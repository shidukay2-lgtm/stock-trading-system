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
 * 日本時間 (JST: UTC+9) の現在日時文字列 (YYYY-MM-DD HH:mm) を生成
 */
function getNowJSTString(includeSeconds = false) {
  const now = new Date();
  const jstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const y = jstDate.getUTCFullYear();
  const m = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jstDate.getUTCDate()).padStart(2, '0');
  const h = String(jstDate.getUTCHours()).padStart(2, '0');
  const min = String(jstDate.getUTCMinutes()).padStart(2, '0');
  const sec = String(jstDate.getUTCSeconds()).padStart(2, '0');
  return includeSeconds ? `${y}-${m}-${d} ${h}:${min}:${sec}` : `${y}-${m}-${d} ${h}:${min}`;
}

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

  // API 1.5: 複数時間足ローソク足取得 (/api/candles?symbol=4477.T&interval=5m)
  if (pathname === '/api/candles' && req.method === 'GET') {
    const symbol = parsedUrl.searchParams.get('symbol') || '4477.T';
    const interval = parsedUrl.searchParams.get('interval') || '60m';
    
    // Python の data_fetcher を呼び出して指定時間足のデータを取得
    const pyScript = path.join(__dirname, 'core', 'data_fetcher.py');
    const pyInline = `
import sys, json
sys.path.insert(0, r"${__dirname.replace(/\\/g, '/')}")
from core.data_fetcher import StockDataFetcher
fetcher = StockDataFetcher(use_cache=True)
df = fetcher.fetch_ohlcv("${symbol}", interval="${interval}", target_candles=200, show_cool_ui=False)
candles = []
if df is not None and not df.empty:
    for i in range(len(df)):
        ts = df.index[i]
        ts_str = ts.strftime("%Y-%m-%d %H:%M") if hasattr(ts, "strftime") else str(ts)[:16]
        candles.append({
            "time": ts_str,
            "open": round(float(df["Open"].iloc[i]), 1),
            "high": round(float(df["High"].iloc[i]), 1),
            "low": round(float(df["Low"].iloc[i]), 1),
            "close": round(float(df["Close"].iloc[i]), 1),
            "volume": int(df["Volume"].iloc[i])
        })
print(json.dumps({"success": True, "symbol": "${symbol}", "interval": "${interval}", "candles": candles}))
`;

    const pyProcess = spawn(PYTHON_CMD, ['-c', pyInline]);
    let output = '';
    pyProcess.stdout.on('data', data => { output += data.toString(); });
    pyProcess.on('error', (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message, candles: [] }));
    });
    pyProcess.on('close', (code) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (code === 0 && output) {
        res.end(output.trim());
      } else {
        res.end(JSON.stringify({ success: false, code, candles: [] }));
      }
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

  // --- 永続化データベース管理 (data/user_trading_data.json) ---
  const USER_DATA_FILE = path.join(__dirname, 'data', 'user_trading_data.json');

  function loadUserData() {
    try {
      if (fs.existsSync(USER_DATA_FILE)) {
        const raw = fs.readFileSync(USER_DATA_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('[DB] ユーザーデータ読み込みエラー:', e.message);
    }
    const defaultData = {
      account: {
        initialCapital: 300000,
        cash: 300000,
        compoundingEnabled: true,
        maxAllocationPct: 0.40,
        updatedAt: new Date().toISOString()
      },
      positions: [],
      trades: [],
      notes: {},
      equityHistory: [
        {
          time: new Date().toISOString().replace('T', ' ').substring(0, 16),
          equity: 300000,
          cash: 300000,
          positionsValue: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          returnPct: 0.0,
          note: "運用開始 (元本 ¥300,000)"
        }
      ]
    };
    saveUserData(defaultData);
    return defaultData;
  }

  function saveUserData(data) {
    try {
      const dataDir = path.dirname(USER_DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('[DB] ユーザーデータ保存エラー:', e.message);
      return false;
    }
  }

  // API 4: アカウント・資産・複利設定 (/api/account)
  if (pathname === '/api/account') {
    if (req.method === 'GET') {
      const data = loadUserData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, account: data.account, equityHistory: data.equityHistory || [] }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const data = loadUserData();
          
          if (payload.reset) {
            const initCap = Number(payload.initialCapital) || 300000;
            data.account = {
              initialCapital: initCap,
              cash: initCap,
              compoundingEnabled: payload.compoundingEnabled !== undefined ? payload.compoundingEnabled : true,
              maxAllocationPct: 0.40,
              updatedAt: new Date().toISOString()
            };
            data.positions = [];
            data.trades = [];
            data.equityHistory = [{
              time: getNowJSTString(),
              equity: initCap,
              cash: initCap,
              positionsValue: 0,
              realizedPnl: 0,
              unrealizedPnl: 0,
              returnPct: 0.0,
              note: `データリセット (元本 ¥${initCap.toLocaleString()})`
            }];
          } else {
            if (payload.initialCapital !== undefined) data.account.initialCapital = Number(payload.initialCapital);
            if (payload.cash !== undefined) data.account.cash = Number(payload.cash);
            if (payload.compoundingEnabled !== undefined) data.account.compoundingEnabled = Boolean(payload.compoundingEnabled);
            if (payload.maxAllocationPct !== undefined) data.account.maxAllocationPct = Number(payload.maxAllocationPct);
            data.account.updatedAt = new Date().toISOString();
          }

          saveUserData(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, account: data.account, equityHistory: data.equityHistory }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
  }

  // API 5: トレード履歴永続化 (/api/trades)
  if (pathname === '/api/trades') {
    if (req.method === 'GET') {
      const data = loadUserData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, trades: data.trades || [] }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const trade = JSON.parse(body);
          const data = loadUserData();
          if (!data.trades) data.trades = [];
          
          // 重複チェック
          const existingIdx = data.trades.findIndex(t => t.trade_id === trade.trade_id);
          if (existingIdx >= 0) {
            data.trades[existingIdx] = trade;
          } else {
            data.trades.unshift(trade);
          }

          // 複利口座残高の更新 (拘束されていた元本 + 確定損益を現金口座に返却)
          const invest = Number(trade.investment_amount) || (trade.entry_price * trade.shares) || 0;
          const pnl = Number(trade.pnl_amount) || 0;
          data.account.cash = Math.max(0, (data.account.cash || 0) + invest + pnl);
          data.account.updatedAt = new Date().toISOString();

          // 決済されたポジションを削除
          if (data.positions) {
            data.positions = data.positions.filter(p => p.symbol !== trade.symbol);
          }

          // 資産推移スナップショットの記録
          const totalRealizedPnl = data.trades.reduce((sum, t) => sum + (Number(t.pnl_amount) || 0), 0);
          const currentTotalEquity = (data.account.initialCapital || 300000) + totalRealizedPnl;
          const returnPct = ((currentTotalEquity - data.account.initialCapital) / data.account.initialCapital) * 100;

          if (!data.equityHistory) data.equityHistory = [];
          data.equityHistory.push({
            time: trade.exit_time || getNowJSTString(),
            equity: currentTotalEquity,
            cash: data.account.cash,
            positionsValue: 0,
            realizedPnl: totalRealizedPnl,
            unrealizedPnl: 0,
            returnPct: parseFloat(returnPct.toFixed(2)),
            note: `${trade.symbol_name || trade.symbol} 決済: ${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${trade.exit_reason})`
          });

          saveUserData(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, trades: data.trades, account: data.account, positions: data.positions, equityHistory: data.equityHistory }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
  }

  // API 6: 保有ポジション永続化 (/api/positions)
  if (pathname === '/api/positions' || pathname.startsWith('/api/positions/')) {
    if (req.method === 'GET') {
      const data = loadUserData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, positions: data.positions || [] }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const pos = JSON.parse(body);
          const data = loadUserData();
          if (!data.positions) data.positions = [];
          
          const idx = data.positions.findIndex(p => p.symbol === pos.symbol);
          const invest = Number(pos.investmentAmount) || (pos.entryPrice * pos.shares);

          if (idx >= 0) {
            data.positions[idx] = pos;
          } else {
            data.positions.push(pos);
            // 新規エントリー時に買付現金を正しく拘束（減少）
            data.account.cash = Math.max(0, (data.account.cash || data.account.initialCapital) - invest);
            data.account.updatedAt = new Date().toISOString();
          }

          saveUserData(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, positions: data.positions, account: data.account }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'DELETE') {
      const symbol = decodeURIComponent(pathname.replace('/api/positions/', '').replace('/api/positions', ''));
      const data = loadUserData();
      if (symbol && data.positions) {
        data.positions = data.positions.filter(p => p.symbol !== symbol);
        saveUserData(data);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, positions: data.positions || [] }));
      return;
    }
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
