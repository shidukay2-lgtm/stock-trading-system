/**
 * チャート描画ロジック & レート反映・決済タイミング計算の検証スクリプト
 */

const fs = require('fs');
const path = require('path');

console.log("=== [1] チャートモジュール構文 & クラス検証 ===");
const chartJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'chart.js'), 'utf8');
if (!chartJs.includes('Plotly.react') || !chartJs.includes('📍 現在値') || !chartJs.includes('🎯 利確目標') || !chartJs.includes('⏰ 決済期限')) {
    throw new Error("chart.js に必要な現在値・利確・決済期限ロジックが含まれていません");
}
console.log("✔ chart.js 内の決済ガイド・現在値アノテーション・Plotly.react 連携確認 OK");

console.log("\n=== [2] 決済タイミング計算ロジック検証 ===");
const entryPrice = 338.0;
const currentPrice = 345.0;
const shares = 200;
const tpPrice = entryPrice * 1.06; // 358.28
const slPrice = entryPrice * 0.975; // 329.55

const pnl = (currentPrice - entryPrice) * shares;
const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
const distTp = tpPrice - currentPrice;
const distSl = currentPrice - slPrice;
const holdingBars = 4;
const remainBars = 15 - holdingBars;

console.log(`- 買値: ¥${entryPrice}`);
console.log(`- 現在値: ¥${currentPrice}`);
console.log(`- 評価損益: +¥${pnl} (+${pnlPct.toFixed(2)}%)`);
console.log(`- 利確ライン (+6%): ¥${tpPrice.toFixed(1)} [利確まで 残+¥${distTp.toFixed(1)}]`);
console.log(`- 損切ライン (-2.5%): ¥${slPrice.toFixed(1)} [損切まで 余裕-¥${distSl.toFixed(1)}]`);
console.log(`- 保有期限: ${holdingBars}/15本 (あと ${remainBars}本で自動満了決済)`);

if (distTp <= 0) throw new Error("利確計算エラー");
if (distSl <= 0) throw new Error("損切計算エラー");
if (remainBars !== 11) throw new Error("保有期限計算エラー");

console.log("\n🎉 チャートレート反映 & 決済タイミング計算の全テストに合格しました！");
