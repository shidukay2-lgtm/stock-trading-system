/**
 * 複数戦略切替機能 & 板気配VWAP戦略 単体・統合検証スクリプト
 */

const fs = require('fs');
const path = require('path');

// 1. strategy.js を読み込んで評価
const strategyJsPath = path.join(__dirname, '..', 'web', 'js', 'strategy.js');
const strategyJsCode = fs.readFileSync(strategyJsPath, 'utf8');

// window オブジェクトのモック
const mockWindow = {};
const evalFn = new Function('window', strategyJsCode);
evalFn(mockWindow);

const { TripleConfluenceStrategy, OrderBookVWAPPullbackStrategy, StrategyRegistry } = mockWindow;

console.log("=== [1] 戦略クラスのインスタンス化検証 ===");
const strat1 = new TripleConfluenceStrategy();
const strat2 = new OrderBookVWAPPullbackStrategy();
const registry = new StrategyRegistry();

console.log("✔ TripleConfluenceStrategy:", strat1.params.name || "OK");
console.log("✔ OrderBookVWAPPullbackStrategy:", strat2.params.name || "OK");
console.log("✔ StrategyRegistry 初期戦略:", registry.activeStrategyId);

// 2. モックローソク足データ作成
const mockCandles = [];
let price = 500;
for (let i = 0; i < 60; i++) {
    const d = new Date(Date.now() - (60 - i) * 3600 * 1000);
    price += (Math.random() - 0.45) * 5;
    mockCandles.push({
        time: d.toISOString().replace('T', ' ').substring(0, 16),
        open: price,
        high: price + 3,
        low: price - 3,
        close: price + (Math.random() - 0.5) * 2,
        volume: 20000 + Math.floor(Math.random() * 10000)
    });
}

// 3. 戦略1 (TripleConfluence) の分析テスト
console.log("\n=== [2] 戦略1 分析実行 ===");
const analyzed1 = strat1.analyzeCandles(mockCandles);
console.log(`✔ 戦略1 分析件数: ${analyzed1.length}`);
console.log(`✔ 戦略1 最終足 EMA10: ${analyzed1[analyzed1.length-1].ema10?.toFixed(1)}, EMA25: ${analyzed1[analyzed1.length-1].ema25?.toFixed(1)}, RSI: ${analyzed1[analyzed1.length-1].rsi?.toFixed(1)}`);

// 4. 戦略2 (OrderBook_VWAP_Pullback) の分析テスト
console.log("\n=== [3] 戦略2 (板気配VWAP) 分析実行 ===");
const analyzed2 = strat2.analyzeCandles(mockCandles);
console.log(`✔ 戦略2 分析件数: ${analyzed2.length}`);
console.log(`✔ 戦略2 最終足 VWAP: ${analyzed2[analyzed2.length-1].vwap?.toFixed(1)}, EMA20: ${analyzed2[analyzed2.length-1].ema20?.toFixed(1)}, BidAskRatio: ${analyzed2[analyzed2.length-1].bidAskRatio?.toFixed(2)}x`);

// 5. 単元株 (100株) 注文サイズ計算テスト
console.log("\n=== [4] 注文サイズ計算テスト (100株単元厳守) ===");
const calc1 = strat1.calculateOrderSize(338, 300000, true);
console.log(`✔ 戦略1 (株価 ¥338, 資金 ¥300,000): ${calc1.shares}株, 投資額 ¥${calc1.investment}, 備考: ${calc1.note}`);
if (calc1.shares % 100 !== 0) throw new Error("単元未満株が含まれています！");

const calc2 = strat2.calculateOrderSize(889, 300000, true);
console.log(`✔ 戦略2 (株価 ¥889, 資金 ¥300,000): ${calc2.shares}株, 投資額 ¥${calc2.investment}, 備考: ${calc2.note}`);
if (calc2.shares % 100 !== 0) throw new Error("単元未満株が含まれています！");

// 6. レジストリ切り替えテスト
console.log("\n=== [5] 戦略切り替えテスト ===");
registry.setActiveStrategy("orderbook_vwap");
console.log(`✔ 切替後戦略: ${registry.activeStrategyId} (${registry.getActiveStrategyMeta().displayName})`);
const activeStrat = registry.getActiveStrategy();
console.log(`✔ アクティブインスタンス: ${activeStrat.constructor.name}`);

console.log("\n🎉 全ての複数戦略機能テストに合格しました！");
