/**
 * test_compound_and_db.js
 * 複利ロット拡大計算、動的勝率集計、サーバーDB永続化APIの統合自動テスト
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// 1. Strategyの注文サイズ計算ロジック検証
console.log("=== 1. 複利計算 & 100株単元厳守のテスト ===");

// strategy.js から TripleConfluenceStrategy クラスを取り出す擬似環境
const strategyCode = fs.readFileSync(path.join(__dirname, 'web/js/strategy.js'), 'utf8');
const vm = require('vm');
const sandbox = { window: {}, console: console };
vm.createContext(sandbox);
vm.runInContext(strategyCode, sandbox);
const StrategyClass = sandbox.window.TripleConfluenceStrategy;
const strat = new StrategyClass();

// (A) 初期資金 30万円、株価 450円
const order1 = strat.calculateOrderSize(450, 300000, true);
console.log(`[テスト1-A] 資金30万円 / 株価450円 ➔ 株数: ${order1.shares}株, 投資額: ¥${order1.investment} (${order1.note})`);
if (order1.shares % 100 !== 0 || order1.shares < 100 || order1.investment > 300000 * 0.4) {
    console.error("❌ テスト1-A 失敗: 100株単元または投資枠に違反しています");
    process.exit(1);
} else {
    console.log("✅ テスト1-A 成功");
}

// (B) 複利運用で資金が 60万円 に増加した場合
const order2 = strat.calculateOrderSize(450, 600000, true);
console.log(`[テスト1-B] 資金60万円 (複利増加後) / 株価450円 ➔ 株数: ${order2.shares}株, 投資額: ¥${order2.investment} (${order2.note})`);
if (order2.shares % 100 !== 0 || order2.shares <= order1.shares) {
    console.error("❌ テスト1-B 失敗: 複利によるロット拡大が正しく機能していません");
    process.exit(1);
} else {
    console.log("✅ テスト1-B 成功: 運用資金増加に伴いロットが自動拡大");
}

// (C) 複利OFF（固定ロット運用）の場合
const order3 = strat.calculateOrderSize(450, 600000, false);
console.log(`[テスト1-C] 資金60万円 (複利OFF) / 株価450円 ➔ 株数: ${order3.shares}株, 投資額: ¥${order3.investment} (${order3.note})`);
if (order3.investment > 100000) {
    console.error("❌ テスト1-C 失敗: 複利OFF時は上限10万円である必要があります");
    process.exit(1);
} else {
    console.log("✅ テスト1-C 成功: 複利OFF時は上限10万円以内固定");
}

// 2. 動的勝率 & KPI集計ロジック検証
console.log("\n=== 2. 動的勝率 & KPI集計ロジックのテスト ===");
const dataStoreCode = fs.readFileSync(path.join(__dirname, 'web/js/data_store.js'), 'utf8');
const localStorageMock = {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; }
};
const fetchMock = async () => ({ ok: false });
const dsSandbox = { window: {}, console: console, localStorage: localStorageMock, fetch: fetchMock };
vm.createContext(dsSandbox);
vm.runInContext(dataStoreCode, dsSandbox);
const DataStoreClass = dsSandbox.window.DataStore;
const ds = new DataStoreClass();

// 初期状態 (0トレード)
let stats0 = ds.getSummaryStats();
console.log(`[テスト2-A] トレード0件時 ➔ 勝率: ${stats0.winRate}%, トレード数: ${stats0.totalTrades}`);
if (stats0.totalTrades !== 0 || stats0.winRate !== 0.0) {
    console.error("❌ テスト2-A 失敗: 初期状態の勝率が0.0%ではありません");
    process.exit(1);
} else {
    console.log("✅ テスト2-A 成功");
}

// 1勝追加 (+6,000円)
ds.trades.push({ pnl_amount: 6000, pnl_pct: 6.0 });
let stats1 = ds.getSummaryStats();
console.log(`[テスト2-B] 1勝0敗 ➔ 勝率: ${stats1.winRate}%, トレード数: ${stats1.totalTrades}, 損益: ¥${stats1.totalPnl}`);
if (stats1.winRate !== 100.0 || stats1.totalTrades !== 1 || stats1.totalPnl !== 6000) {
    console.error("❌ テスト2-B 失敗: 1勝時の動的勝率集計エラー");
    process.exit(1);
} else {
    console.log("✅ テスト2-B 成功");
}

// 1敗追加 (-2,500円)
ds.trades.push({ pnl_amount: -2500, pnl_pct: -2.5 });
let stats2 = ds.getSummaryStats();
console.log(`[テスト2-C] 1勝1敗 ➔ 勝率: ${stats2.winRate}%, トレード数: ${stats2.totalTrades}, 損益: ¥${stats2.totalPnl}, PF: ${stats2.profitFactor}`);
if (stats2.winRate !== 50.0 || stats2.totalTrades !== 2 || stats2.totalPnl !== 3500) {
    console.error("❌ テスト2-C 失敗: 1勝1敗時の集計エラー");
    process.exit(1);
} else {
    console.log("✅ テスト2-C 成功");
}

// 3. サーバーDB API通信テスト (localhost:3000)
console.log("\n=== 3. サーバーDB永続化API通信テスト ===");

function makeRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: '127.0.0.1',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, rawBody: data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function testServerAPIs() {
    try {
        // (A) GET /api/account
        const accRes = await makeRequest('/api/account');
        console.log(`[テスト3-A] GET /api/account ➔ Status: ${accRes.statusCode}, Success: ${accRes.body.success}, InitialCapital: ${accRes.body.account.initialCapital}`);
        if (accRes.statusCode !== 200 || !accRes.body.success) {
            throw new Error("GET /api/account エラー");
        }

        // (B) POST /api/account (設定更新)
        const updateRes = await makeRequest('/api/account', 'POST', {
            initialCapital: 350000,
            compoundingEnabled: true
        });
        console.log(`[テスト3-B] POST /api/account ➔ Status: ${updateRes.statusCode}, Capital: ${updateRes.body.account.initialCapital}`);
        if (updateRes.statusCode !== 200 || updateRes.body.account.initialCapital !== 350000) {
            throw new Error("POST /api/account エラー");
        }

        // (C) POST /api/trades (トレード登録 & 資産推移更新)
        const sampleTrade = {
            trade_id: "TEST-" + Date.now(),
            symbol: "4477.T",
            symbol_name: "BASE",
            entry_price: 320,
            exit_price: 340,
            shares: 200,
            investment_amount: 64000,
            pnl_amount: 4000,
            pnl_pct: 6.25,
            exit_reason: "TAKE_PROFIT",
            exit_time: new Date().toISOString().replace('T', ' ').substring(0, 16)
        };
        const tradeRes = await makeRequest('/api/trades', 'POST', sampleTrade);
        console.log(`[テスト3-C] POST /api/trades ➔ Status: ${tradeRes.statusCode}, TradesCount: ${tradeRes.body.trades.length}, LatestEquity: ¥${tradeRes.body.equityHistory[tradeRes.body.equityHistory.length - 1].equity}`);
        if (tradeRes.statusCode !== 200 || !tradeRes.body.success) {
            throw new Error("POST /api/trades エラー");
        }

        // (D) GET /api/trades
        const getTradesRes = await makeRequest('/api/trades');
        console.log(`[テスト3-D] GET /api/trades ➔ Status: ${getTradesRes.statusCode}, Count: ${getTradesRes.body.trades.length}`);
        if (getTradesRes.statusCode !== 200 || getTradesRes.body.trades.length === 0) {
            throw new Error("GET /api/trades エラー");
        }

        console.log("\n🎉 全ての自動テスト（複利計算・動的勝率・サーバーDB永続化）に完全合格しました！");
    } catch (err) {
        console.error("❌ サーバーAPIテスト失敗:", err.message);
        process.exit(1);
    }
}

testServerAPIs();
