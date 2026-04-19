const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── AWS SigV4 서명 (외부 라이브러리 없이 내장 crypto 사용) ──
function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}
function hash(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function getSignatureKey(key, dateStamp, region, service) {
  const kDate    = hmac('AWS4' + key, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── LWA Access Token 발급 ──────────────────────────────────
let tokenCache = { token: null, expiry: 0 };
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiry) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.LWA_CLIENT_ID,
    client_secret: process.env.LWA_CLIENT_SECRET,
    refresh_token: process.env.LWA_REFRESH_TOKEN,
  }).toString();
  const data = await fetchJson('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (!data.access_token) throw new Error('LWA 실패: ' + JSON.stringify(data));
  tokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

// ── SP-API 호출 (SigV4 서명 포함) ─────────────────────────
async function callSpApi(path, method = 'GET', body = '') {
  const token      = await getAccessToken();
  const host       = 'sellingpartnerapi-na.amazon.com';
  const region     = 'us-east-1';
  const service    = 'execute-api';
  const now        = new Date();
  const amzDate    = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp  = amzDate.slice(0, 8);
  const url        = new URL('https://' + host + path);
  const canonicalQueryString = url.searchParams.toString();
  const canonicalHeaders = `host:${host}\nx-amz-access-token:${token}\nx-amz-date:${amzDate}\n`;
  const signedHeaders    = 'host;x-amz-access-token;x-amz-date';
  const payloadHash      = hash(body);
  const canonicalRequest = [method, url.pathname, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope        = `${dateStamp}/${region}/${service}/aws4_request`;
  const strToSign        = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${hash(canonicalRequest)}`;
  const signingKey       = getSignatureKey(process.env.AWS_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature        = hmac(signingKey, strToSign).toString('hex');
  const authHeader       = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const data = await fetchJson('https://' + host + path, {
    method,
    headers: {
      'host': host,
      'x-amz-access-token': token,
      'x-amz-date': amzDate,
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body,
  });
  return data;
}

// ── 엔드포인트 ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'running', service: 'Amazon SP-API Proxy v2 (SigV4)' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), message: '프록시 서버 정상 작동 중' }));

// FBA 재고 현황
app.get('/inventory', async (req, res) => {
  try {
    const data = await callSpApi(
      '/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=ATVPDKIKX0DER&marketplaceIds=ATVPDKIKX0DER'
    );
    console.log('Inventory API 응답:', JSON.stringify(data).slice(0, 300));
    if (data.errors) return res.status(400).json({ error: data.errors, raw: data });
    const items = (data.payload?.inventorySummaries || []).map(item => ({
      sku:       item.sellerSku,
      asin:      item.asin,
      name:      item.productName,
      available: item.inventoryDetails?.fulfillableQuantity || 0,
      inbound:   (item.inventoryDetails?.inboundWorkingQuantity || 0) +
                 (item.inventoryDetails?.inboundShippedQuantity || 0),
      reserved:  item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
    }));
    res.json({ inventory: items, total: items.length });
  } catch (e) {
    console.error('Inventory 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 리포트 목록
app.get('/api/sp/reports', async (req, res) => {
  try {
    const data = await callSpApi('/reports/2021-06-30/reports?pageSize=10');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ SP-API 프록시 서버 실행 중 (포트 ${PORT}) - SigV4 활성화`));
