const http = require('http');

console.log('======================================================================');
console.log('   HighWin_TripleConfluence 通知機能 & シグナル可視化テスト');
console.log('======================================================================');

// 1. ローカルサーバー疎通テスト
const req = http.get('http://localhost:3000/api/refresh-data', (res) => {
    console.log(`[HTTP GET /api/refresh-data] Status: ${res.statusCode}`);
});
req.on('error', (e) => console.log('HTTP Error:', e.message));

// 2. メールAPI疎通テスト (空設定時のエラーハンドリング確認)
const postData = JSON.stringify({
    config: { smtpHost: 'smtp.gmail.com', smtpPort: 587, toEmail: 'test@example.com' },
    subject: 'テスト件名',
    body: 'テスト本文'
});

const postReq = http.request('http://localhost:3000/api/notify/email', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        console.log(`[HTTP POST /api/notify/email] Response:`, data);
        console.log('======================================================================');
        console.log('✅ 通知APIサーバー連携テスト完了！');
        console.log('======================================================================');
    });
});

postReq.on('error', (e) => console.log('Post Error:', e.message));
postReq.write(postData);
postReq.end();
