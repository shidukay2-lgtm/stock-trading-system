/**
 * Stock Trading System - HighWin Real-Time Web Server (server.js)
 * - Render / クラウド環境 & ローカル環境 自動適応
 * - 0.0.0.0 バインド & ポート動的割り当て
 * - Python / Python3 自動検出 & クラッシュ防止ガード
 * - ヘルスチェック エンドポイント (/health, /api/health)
 * - リアルタイム相場監視 & オートスクリーニング（2分間隔）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0'; // Render 等のクラウドデプロイで必須
const WEB_DIR = path.join(__dirname, 'web');
const SYMBOLS_DATA_FILE = path.join(WEB_DIR, 'data', 'symbols_data.json');

// Python コマンドの自動検出 (Windows: python, Linux/Render: python3)
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

let isScreeningRunning = false;
let lastScreeningTime = null;

/**
 * Python スクリーニングスクリプト (market_monitor.py) の安全な実行
 */
function triggerMarketScreening(callback) {
  if (isScreeningRunning) {
    console.log('[Monitor] スクリーニングは既に実行中です。スキップします。');
    if (callback) callback(null, { status: 'already_running' });
    return;
  }

  isScreeningRunning = true;
  console.log(`[Monitor] リアルタイム相場スクリーニングを開始します (コマンド: ${PYTHON_CMD})...`);

  try {
    const pyScript = path.join(__dirname, 'server', 'market_monitor.py');
    const pyProcess = spawn(PYTHON_CMD, [pyScript]);
    let output = '';

    pyProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log(`[Python]: ${data.toString().trim()}`);
    });

    pyProcess.stderr.on('data', (data) => {
      console.warn(`[Python Err]: ${data.toString().trim()}`);
    });

    pyProcess.on('error', (err) => {
      console.error(`[Monitor] Python プロセス起動エラー (${PYTHON_CMD}):`, err.message);
      isScreeningRunning = false;
      if (callback) callback(err, { output, error: err.message });
    });

    pyProcess.on('close', (code) => {
      isScreeningRunning = false;
      lastScreeningTime = new Date().toISOString();
      console.log(`[Monitor] スクリーニング完了 (Exit Code: ${code})`);
      if (callback) callback(code === 0 ? null : new Error(`Screening exit code ${code}`), { code, output, lastScreeningTime });
    });
  } catch (err) {
    console.error('[Monitor] 例外発生:', err.message);
    isScreeningRunning = false;
    if (callback) callback(err, { error: err.message });
  }
}

// サーバー起動 3 秒後に初回相場スクリーニングを実行
setTimeout(() => {
  triggerMarketScreening();
}, 3000);

// 2分ごとの定期相場監視トリガー
const AUTO_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
setInterval(() => {
  console.log('[Cron] 定期相場監視トリガー実行 (2分間隔)');
  triggerMarketScreening();
}, AUTO_REFRESH_INTERVAL_MS);

const server = http.createServer((req, res) => {
  // CORS ヘッダー
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  // Render ヘルスチェックエンドポイント (/health, /api/health)
  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      uptime: process.uptime(), 
      timestamp: new Date().toISOString(),
      service: 'stock-trading-system'
    }));
    return;
  }

  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  // API 1: 最新マーケットデータ取得 (/api/market-data)
  if (pathname === '/api/market-data' && req.method === 'GET') {
    fs.readFile(SYMBOLS_DATA_FILE, 'utf8', (err, data) => {
      if (err) {
        // 万一ファイルがない場合は初期レスポンスを返す
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ 
          success: false, 
          message: 'データ準備中',
          market_status: { is_open: false, status_text: 'データ準備中' },
          symbols: {}
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // API 2: 今すぐ手動更新トリガー (/api/refresh-now または /api/refresh-data)
  if ((pathname === '/api/refresh-now' || pathname === '/api/refresh-data') && req.method === 'POST') {
    console.log('[API] 手動更新リクエストを受信しました');
    triggerMarketScreening((err, result) => {
      fs.readFile(SYMBOLS_DATA_FILE, 'utf8', (readErr, data) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (!readErr && data) {
          res.end(data);
        } else {
          res.end(JSON.stringify({ success: !err, result }));
        }
      });
    });
    return;
  }

  // API 3: メール送信エンドポイント (/api/notify/email)
  if (pathname === '/api/notify/email' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const pyProcess = spawn(PYTHON_CMD, [
          path.join(__dirname, 'server', 'email_sender.py'),
          body
        ]);

        let pyOutput = '';
        pyProcess.stdout.on('data', data => { pyOutput += data.toString(); });
        
        pyProcess.on('error', (err) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: `Python実行エラー: ${err.message}` }));
        });

        pyProcess.on('close', (code) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          try {
            res.end(pyOutput || JSON.stringify({ success: code === 0, message: '送信完了' }));
          } catch(e) {
            res.end(JSON.stringify({ success: false, message: pyOutput }));
          }
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
    return;
  }

  // 静的ファイル配信
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(WEB_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(WEB_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

// 0.0.0.0 で確実にリッスン（Render ヘルスチェック対策）
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  Stock Trading System - HighWin クラウド/ローカル Web Server');
  console.log(`  リッスンアドレス: http://${HOST}:${PORT}`);
  console.log(`  環境: PORT=${PORT}, PYTHON_CMD=${PYTHON_CMD}`);
  console.log('====================================================');
});
