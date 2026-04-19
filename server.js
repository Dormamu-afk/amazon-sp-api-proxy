const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json());

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── Access Token 발급 ──────────────────────────────────────────
async function getAccessToken() {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
      refresh_token: process.env.LWA_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('LWA Token 발급 실패: ' + JSON.stringify(data));
  }
  return data.access_token;
}

// ── SP-API 호출 (간소화 버전 — AWS 서명 없이) ───────────────────
async function callSpApi(path) {
  const token = await getAccessToken();
  const res = await fetch('https://sellingpartnerapi-na.amazon.com' + path, {
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

// ── 엔드포인트 ────────────────────────────────────────────────

// 루트 & 헬스 체크
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    service: 'Amazon SP-API Proxy',
    endpoints: [
      'GET /health',
      'GET /inventory',
      'GET /sales (coming soon)'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: '프록시 서버 정상 작동 중'
  });
});

// FBA 재고 현황
app.get('/inventory', async (req, res) => {
  try {
    const data = await callSpApi(
      '/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=ATVPDKIKX0DER&marketplaceIds=ATVPDKIKX0DER'
    );
    
    // 데이터 변환
    const inventory = (data.payload?.inventorySummaries || []).map(item => ({
      sku: item.sellerSku,
      asin: item.asin,
      name: item.productName,
      available: item.inventoryDetails?.fulfillableQuantity || 0,
      inbound: (item.inventoryDetails?.inboundWorkingQuantity || 0) + 
               (item.inventoryDetails?.inboundShippedQuantity || 0),
      reserved: item.inventoryDetails?.reservedQuantity || 0,
    }));
    
    res.json({ inventory, total: inventory.length });
  } catch (e) {
    console.error('Inventory API 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

// 판매 리포트 (추후 구현)
app.get('/sales', async (req, res) => {
  res.json({ message: 'Sales endpoint coming soon' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ SP-API 프록시 서버 실행 중 (포트 ${PORT})`);
});
