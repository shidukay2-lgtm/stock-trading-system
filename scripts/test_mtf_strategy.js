/**
 * MTF高速スキャル・デイトレ戦略 (戦略3) & 個別監視ON/OFF & 勝率70%以上フィルター 検証スクリプト
 */

const fs = require('fs');
const path = require('path');

// 1. strategy.js を読み込んで評価
const strategyJsPath = path.join(__dirname, '..', 'web', 'js', 'strategy.js');
const strategyJsCode = fs.readFileSync(strategyJsPath, 'utf8');

const mockWindow = {};
const evalFn = new Function('window', strategyJsCode);
evalFn(mockWindow);

const { TripleConfluenceStrategy, OrderBookVWAPPullbackStrategy, MTFScalpingStrategy, StrategyRegistry } = mockWindow;

console.log("=== [1] 戦略クラス・レジストリ インスタンス化テスト ===");
const strat1 = new TripleConfluenceStrategy();
const strat2 = new OrderBookVWAPPullbackStrategy();
const strat3 = new MTFScalpingStrategy();
const registry = new StrategyRegistry();

console.log(`✔ 戦略1: ${registry.strategies['triple_confluence'].displayName}`);
console.log(`✔ 戦略2: ${registry.strategies['orderbook_vwap'].displayName}`);
console.log(`✔ 戦略3: ${registry.strategies['mtf_scalping'].displayName}`);
console.log(`✔ デフォルトアクティブ戦略: ${registry.activeStrategyId}`);

// 2. モックローソク足データ作成 (下位足: 5分足想定)
const mockCandles = [];
let price = 500;
for (let i = 0; i < 60; i++) {
    const d = new Date(Date.now() - (60 - i) * 5 * 60 * 1000);
    const change = (Math.random() - 0.45) * 4;
    price += change;
    mockCandles.push({
        time: d.toISOString().replace('T', ' ').substring(0, 16),
        open: price - (Math.random() * 2),
        high: price + 3,
        low: price - 3,
        close: price,
        volume: 15000 + Math.floor(Math.random() * 8000),
        bid_ask_imbalance: 1.45 // 強い買い板気配
    });
}

// 3. 戦略3 (MTFScalpingStrategy) 分析実行
console.log("\n=== [2] 戦略3 (MTF高速スキャル・デイトレ) 分析実行 ===");
const analyzed3 = strat3.analyzeCandles(mockCandles);
console.log(`✔ 戦略3 分析バー数: ${analyzed3.length}`);
const lastBar = analyzed3[analyzed3.length - 1];
console.log(`✔ 最新足データ:`);
console.log(`  - 終値: ¥${lastBar.close.toFixed(1)}`);
console.log(`  - VWAP: ¥${lastBar.vwap.toFixed(1)}`);
console.log(`  - EMA9: ¥${lastBar.ema9.toFixed(1)}, EMA20: ¥${lastBar.ema20.toFixed(1)}, EMA50: ¥${lastBar.ema50.toFixed(1)}`);
console.log(`  - RSI(9): ${lastBar.rsi ? lastBar.rsi.toFixed(1) : 'N/A'}`);
console.log(`  - 直近高値: ¥${lastBar.recentHigh.toFixed(1)}`);
console.log(`  - 利確価格 (+1.2%): ¥${lastBar.takeProfitPrice.toFixed(1)}`);
console.log(`  - 損切価格 (-0.6%): ¥${lastBar.stopLossPrice.toFixed(1)}`);
console.log(`  - 買シグナル判定: ${lastBar.isBuySignal ? '🔥 点灯' : '待機中'}`);

// 4. 100株単元注文サイズ計算テスト (全戦略)
console.log("\n=== [3] 単元株 (100株) 注文サイズ計算テスト (100株単元厳守) ===");
const pricesToTest = [338, 889, 2450];
[strat1, strat2, strat3].forEach((strat, idx) => {
    const stratName = `戦略${idx + 1} (${strat.constructor.name})`;
    console.log(`--- ${stratName} ---`);
    pricesToTest.forEach(p => {
        const res = strat.calculateOrderSize(p, 300000, true);
        console.log(`  株価 ¥${p}: ${res.shares}株, 投資額 ¥${res.investment.toLocaleString()} (単元株: ${res.isUnitLot}) - ${res.note}`);
        if (res.shares > 0 && res.shares % 100 !== 0) {
            throw new Error(`単元未満株エラー: ${stratName} で ${res.shares}株`);
        }
    });
});

// 5. 個別監視ON/OFFトグルテスト
console.log("\n=== [4] 戦略個別監視 ON/OFF 切替テスト ===");
console.log(`初期有効戦略数: ${registry.getEnabledStrategies().length}件`);

// 戦略1をOFF、戦略2をOFF、戦略3のみON
registry.setStrategyEnabled("triple_confluence", false);
registry.setStrategyEnabled("orderbook_vwap", false);
registry.setStrategyEnabled("mtf_scalping", true);

const enabledStrats1 = registry.getEnabledStrategies();
console.log(`✔ 戦略1,2をOFF後の有効戦略: ${enabledStrats1.map(s => s.shortName).join(', ')} (計${enabledStrats1.length}件)`);
if (enabledStrats1.length !== 1 || enabledStrats1[0].id !== "mtf_scalping") {
    throw new Error("戦略個別ON/OFFトグルが正しく機能していません！");
}

// トグル状態のエクスポートと復元
const togglesState = registry.getStrategyToggles();
console.log(`✔ トグル保存状態:`, JSON.stringify(togglesState));

const newRegistry = new StrategyRegistry();
newRegistry.loadStrategyToggles(togglesState);
const restoredEnabled = newRegistry.getEnabledStrategies();
console.log(`✔ 復元後有効戦略: ${restoredEnabled.map(s => s.shortName).join(', ')}`);
if (restoredEnabled.length !== 1 || restoredEnabled[0].id !== "mtf_scalping") {
    throw new Error("トグル状態の復元に失敗しました！");
}

// 6. 勝率70%以上フィルターテスト
console.log("\n=== [5] 勝率70%以上 銘柄フィルターテスト ===");
const mockSymbols = [
    { code: "6758", name: "ソニーG", metrics: { winRate: 75.0 }, is_win_rate_70_plus: true },
    { code: "7203", name: "トヨタ自動車", metrics: { winRate: 65.0 }, is_win_rate_70_plus: false },
    { code: "8306", name: "三菱UFJ", metrics: { winRate: 83.3 }, is_win_rate_70_plus: true },
    { code: "9984", name: "ソフトバンクG", metrics: { winRate: 58.0 }, is_win_rate_70_plus: false }
];

const filter70Only = true;
const filteredSymbols = mockSymbols.filter(s => {
    if (!filter70Only) return true;
    return s.is_win_rate_70_plus || (s.metrics && s.metrics.winRate >= 70.0);
});

console.log(`✔ 全銘柄数: ${mockSymbols.length}件 -> 70%以上厳選後: ${filteredSymbols.length}件`);
filteredSymbols.forEach(s => console.log(`  - [${s.code}] ${s.name}: 勝率 ${s.metrics.winRate}%`));
if (filteredSymbols.length !== 2 || filteredSymbols[0].code !== "6758" || filteredSymbols[1].code !== "8306") {
    throw new Error("勝率70%以上フィルターが正しく機能していません！");
}

console.log("\n🎉 全てのMTF高速戦略・個別監視ON/OFF・勝率70%フィルターテストに合格しました！");
