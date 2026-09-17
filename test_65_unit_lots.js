const fs = require('fs');
const path = require('path');

const symbolsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'web', 'data', 'symbols_data.json'), 'utf8'));

console.log('======================================================================');
console.log('  【検証】勝率65%以上・100株単元限定・シグナル点灯日時の厳格チェック');
console.log('======================================================================');

let allPassed = true;
const symbols = symbolsData.symbols;
const codes = Object.keys(symbols);

console.log(`対象銘柄数: ${codes.length} 銘柄\n`);

codes.forEach(code => {
    const sym = symbols[code];
    const info = sym.info;
    const metrics = sym.metrics;
    const latestCandle = sym.candles[sym.candles.length - 1];
    const price = latestCandle.close;
    const lotCost = price * 100;
    const recShares = info.recommended_shares;
    const recInvest = info.recommended_investment;

    // 1. 勝率65%以上判定
    const isWinRatePassed = metrics.win_rate_pct >= 65.0;
    
    // 2. 単元株(100株単位)判定 & 10万円以下判定
    const is100Unit = (recShares % 100 === 0) && (recShares > 0);
    const isBudgetOk = recInvest <= 100000;
    const isLotUnder100k = lotCost <= 100000;

    // 3. 点灯日時が存在するか判定
    const hasSignalTime = !!metrics.latest_signal_time && metrics.latest_signal_time.length > 5;

    console.log(`【銘柄】: ${info.name} (${code}) | 市場: ${info.market} | セクター: ${info.sector}`);
    console.log(`  最新株価: ¥${price.toFixed(1)} | 100株単元価格: ¥${lotCost.toLocaleString()}`);
    console.log(`  推奨購入: ${recShares}株 (投資額: ¥${recInvest.toLocaleString()})`);
    console.log(`    ↳ 100株単元判定: ${is100Unit && isLotUnder100k ? '✅ 適合 (100株単元株)' : '❌ 単元未満株または不可'}`);
    console.log(`    ↳ 10万円以下判定: ${isBudgetOk ? '✅ 適合 (<= 10万円)' : '❌ 予算超過'}`);
    console.log(`  バックテスト勝率: ${metrics.win_rate_pct}% | PF: ${metrics.profit_factor} | MaxDD: ${metrics.max_drawdown_pct}%`);
    console.log(`    ↳ 勝率65%以上判定: ${isWinRatePassed ? '✅ 合格 (>= 65.0%)' : '❌ 不合格'}`);
    console.log(`  ⏰ 直近シグナル点灯日時: ${metrics.latest_signal_time} (${metrics.latest_signal_time_ago})`);
    console.log(`    ↳ 点灯日時明示判定: ${hasSignalTime ? '✅ 適合' : '❌ 日時未設定'}\n`);

    if (!isWinRatePassed || !is100Unit || !isBudgetOk || !hasSignalTime) {
        allPassed = false;
    }
});

console.log('======================================================================');
console.log(`【最終判定】: ${allPassed ? '✅ 全項目（勝率65%以上・100株単元限定・点灯日時明示）完全クリア！' : '❌ 不合格項目あり'}`);
console.log('======================================================================');
