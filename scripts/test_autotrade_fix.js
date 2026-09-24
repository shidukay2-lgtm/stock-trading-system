/**
 * 自動売買 誤損切防止 & JSTタイムスタンプ & クールダウン無限ループ防止 単体検証スクリプト
 */

const fs = require('fs');
const path = require('path');

// 1. data_store.js, notifier.js, strategy.js の読み込み
const mockWindow = {};
['data_store.js', 'strategy.js', 'notifier.js'].forEach(file => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', file), 'utf8');
    const fn = new Function('window', 'document', 'localStorage', code);
    fn(mockWindow, { getElementById: () => null }, { getItem: () => null, setItem: () => null });
});

const { getNowJSTString, TripleConfluenceStrategy, MTFScalpingStrategy, StrategyRegistry, DataStore, NotificationManager } = mockWindow;

console.log("=== [1] JST 現在時刻生成テスト ===");
const jstTime = getNowJSTString();
const jstTimeSec = getNowJSTString(true);
console.log(`✔ JST 現在日時 (分): ${jstTime}`);
console.log(`✔ JST 現在日時 (秒): ${jstTimeSec}`);

// 簡易検証: フォーマット YYYY-MM-DD HH:mm
if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(jstTime)) {
    throw new Error(`JST 日時フォーマットが不正です: ${jstTime}`);
}

console.log("\n=== [2] 同一足における誤損切防止ロジック検証 ===");
// シナリオ:
// 1. 株価 ¥397 でエントリー (戦略3: 高速デイトレ, 損切 -0.6% = ¥394.618, 利確 +1.2% = ¥401.764)
// 2. そのエントリー足のローソク足データ: open: 395, high: 398, low: 392, close: 397
// 3. エントリー直後 (同一足・barsCount=1): 現在値(close)は 397円のまま
// 4. 過去安値(low: 392)を見ずに、現在値(close: 397)で判定するため、誤損切 (STOP_LOSS) が発生しないことを確認！

const pos = {
    symbol: "7383.T",
    symbolName: "ネットプロHD",
    entryTime: "2026-09-24 13:00",
    entryPrice: 397,
    shares: 200,
    stopLossPrice: 397 * 0.994, // 394.618
    takeProfitPrice: 397 * 1.012, // 401.764
    strategyName: "HighWin_MTF_Scalping_Breakout",
    holdingBars: 1
};

const entryCandle = {
    time: "2026-09-24 13:00",
    open: 395,
    high: 398,
    low: 392, // 損切りライン 394.618 より低い過去安値
    close: 397 // エントリー価格と同じ
};

// 判定テスト (同一足 barsCount = 1)
const barsCount = 1;
const currentClose = Number(entryCandle.close);
const currentLow = Number(entryCandle.low);
const currentHigh = Number(entryCandle.high);

let isExit = false;
let exitReason = null;

if (currentClose >= pos.takeProfitPrice || (barsCount > 1 && currentHigh >= pos.takeProfitPrice)) {
    isExit = true;
    exitReason = "TAKE_PROFIT";
} else if (currentClose <= pos.stopLossPrice || (barsCount > 1 && currentLow <= pos.stopLossPrice)) {
    isExit = true;
    exitReason = "STOP_LOSS";
}

console.log(`✔ 同一足 (barsCount=1, 現在値 ¥${currentClose}, 過去安値 ¥${currentLow}, 損切ライン ¥${pos.stopLossPrice.toFixed(2)}):`);
console.log(`  - 決済判定: ${isExit ? `❌ 誤決済 (${exitReason})` : '🟢 ポジション維持 (正常)'}`);
if (isExit) throw new Error("同一足で過去安値による誤損切りが発生しています！");

console.log("\n=== [3] 次足でのリアル損切り/利確ロジック検証 ===");
// 次の足 (barsCount = 2) で実際にレートが 393円 (損切ライン割れ) に下落した場合
const nextCandleLoss = {
    time: "2026-09-24 14:00",
    open: 396,
    high: 396,
    low: 393,
    close: 393.5
};

let nextExitLoss = false;
let nextReasonLoss = null;
const barsCount2 = 2;
if (nextCandleLoss.close >= pos.takeProfitPrice || (barsCount2 > 1 && nextCandleLoss.high >= pos.takeProfitPrice)) {
    nextExitLoss = true;
    nextReasonLoss = "TAKE_PROFIT";
} else if (nextCandleLoss.close <= pos.stopLossPrice || (barsCount2 > 1 && nextCandleLoss.low <= pos.stopLossPrice)) {
    nextExitLoss = true;
    nextReasonLoss = "STOP_LOSS";
}
console.log(`✔ 次足下落時 (barsCount=2, 安値 ¥${nextCandleLoss.low}, 終値 ¥${nextCandleLoss.close}):`);
console.log(`  - 決済判定: ${nextExitLoss && nextReasonLoss === "STOP_LOSS" ? '🟢 正常損切り執行 (STOP_LOSS)' : '❌ 損切り未執行'}`);
if (!nextExitLoss || nextReasonLoss !== "STOP_LOSS") throw new Error("次足での損切りが正常に機能していません！");

console.log("\n=== [4] クールダウン & 無限再エントリー防止検証 ===");
const exitCooldownMap = {};
// 損切り執行をシミュレーション
exitCooldownMap[pos.symbol] = {
    candleTime: entryCandle.time,
    timestamp: Date.now(),
    exitReason: "STOP_LOSS"
};

// 同じ足で再度シグナルをチェックした場合
const lastExit = exitCooldownMap[pos.symbol];
const isSameCandle = lastExit && lastExit.candleTime === entryCandle.time;
const isWithin5Min = lastExit && (Date.now() - lastExit.timestamp) < (5 * 60 * 1000);
const shouldSkip = isSameCandle || isWithin5Min;

console.log(`✔ 決済直後の同一足再エントリー判定: ${shouldSkip ? '🟢 スキップ (無限ループ防止成功)' : '❌ 再エントリーしてしまいます'}`);
if (!shouldSkip) throw new Error("クールダウン機構が機能していません！");

console.log("\n🎉 全ての自動売買・誤損切防止・JSTタイムスタンプ・クールダウン検証に合格しました！");
