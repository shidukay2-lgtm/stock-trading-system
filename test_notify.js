const http = require('http');

console.log('======================================================================');
console.log('   HighWin_TripleConfluence 通知機能 & シグナル可視化テスト');
console.log('======================================================================');

// 1. ローカルサーバー疎通テスト
const req = http.get('http://localhost:3000/api/refresh-data', (res) => {
    console.log(`[HTTP GET /api/refresh-data] Status: ${res.statusCode}`);
});
req.on('error', (e) => console.log('HTTP Error:', e.message));

// 2. Discord Webhook テスト
const https = require('https');
const discordUrl = new URL('https://discord.com/api/webhooks/1551577859389136908/k439dh4UYByMDUW3Cj9rQDDnRzoKGd07DDB5_kweUdDV7-pDHEIbs-Hbd1cb4hLO4s_f');

const discordPayload = JSON.stringify({
  username: 'HighWin Trade Bot 📈',
  embeds: [{
    title: '🔔 【テスト通知】HighWin Trade System 疎通確認',
    description: 'システムからの自動通知テストが正常に完了しました。',
    color: 0x00FF88,
    timestamp: new Date().toISOString()
  }]
});

const dReq = https.request(discordUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(discordPayload)
  }
}, (res) => {
  console.log(`[Discord Webhook] Status: ${res.statusCode} (204 = OK)`);
});
dReq.on('error', (e) => console.log('Discord Error:', e.message));
dReq.write(discordPayload);
dReq.end();
