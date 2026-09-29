/**
 * 自動売買・プロ仕様スキャルピング決済エンジンの完全テストスクリプト (test_autotrade_scalping.js)
 */
const assert = require('assert');

console.log("=================================================");
console.log("🧪 プロ仕様スキャルピング 自動売買決済ロジック テスト開始");
console.log("=================================================");

function simulateScalpExit(pos, latestCandle, isMarketOpen = true, isOvernight = false, isMarketCloseTime = false) {
    const currentClose = Number(latestCandle.close);
    const currentHigh = Number(latestCandle.high) || currentClose;
    const currentLow = Number(latestCandle.low) || currentClose;

    if (!pos.maxPrice || currentHigh > pos.maxPrice) {
        pos.maxPrice = Math.max(pos.maxPrice || pos.entryPrice, currentHigh);
    }

    const peakGainPct = (pos.maxPrice - pos.entryPrice) / pos.entryPrice;
    const curGainPct = (currentClose - pos.entryPrice) / pos.entryPrice;
    const barsCount = pos.holdingBars || 1;

    let exitPrice = null;
    let exitReason = null;

    if (isOvernight && isMarketOpen) {
        exitPrice = currentClose;
        exitReason = "DAY_OVER_TIMEOUT";
    } else if (isMarketCloseTime) {
        exitPrice = currentClose;
        exitReason = "MARKET_CLOSE";
    } else if (currentClose >= pos.takeProfitPrice || (barsCount > 1 && currentHigh >= pos.takeProfitPrice)) {
        exitPrice = Math.max(pos.takeProfitPrice, currentClose);
        exitReason = "TAKE_PROFIT";
    } else if (peakGainPct >= 0.010 && currentClose <= pos.maxPrice * 0.997) {
        exitPrice = Math.max(Math.round(pos.entryPrice * 1.002), currentClose);
        exitReason = "TRAILING_PROFIT";
    } else if (peakGainPct >= 0.007 && currentLow <= pos.entryPrice * 1.001) {
        exitPrice = Math.round(pos.entryPrice * 1.001);
        exitReason = "PROFIT_LOCK_GUARD";
    } else if (barsCount >= 2 && latestCandle.ema5 && currentClose < Number(latestCandle.ema5) && curGainPct >= 0.003) {
        exitPrice = currentClose;
        exitReason = "MOMENTUM_EMA5_FADE";
    } else if (currentClose <= pos.stopLossPrice || (barsCount > 1 && currentLow <= pos.stopLossPrice)) {
        exitPrice = Math.min(pos.stopLossPrice, currentClose);
        exitReason = "STOP_LOSS";
    } else if (pos.holdingBars >= 6) {
        exitPrice = currentClose;
        exitReason = "TIMEOUT";
    }

    return { exitPrice, exitReason, maxPrice: pos.maxPrice };
}

// テストケース1: 基本利確目標 (+1.5%) 達成
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 2, maxPrice: 1000 };
    const candle = { open: 1010, high: 1016, low: 1008, close: 1015 };
    const res = simulateScalpExit(pos, candle);
    assert.strictEqual(res.exitReason, "TAKE_PROFIT");
    assert.strictEqual(res.exitPrice, 1015);
    console.log("✅ [Test 1] 基本利確 (+1.5%): 成功 -> TAKE_PROFIT 約定 ¥" + res.exitPrice);
}

// テストケース2: 動的トレーリング利食い (+1.2%まで伸びた後、反落して勝ち逃げ利確)
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 3, maxPrice: 1012 };
    // 高値1012 (+1.2%) から 1008 に反落
    const candle = { open: 1011, high: 1012, low: 1007, close: 1008 };
    const res = simulateScalpExit(pos, candle);
    assert.strictEqual(res.exitReason, "TRAILING_PROFIT");
    assert(res.exitPrice >= 1002);
    console.log("✅ [Test 2] 動的トレーリング利食い (含み益取りこぼし防止): 成功 -> TRAILING_PROFIT 約定 ¥" + res.exitPrice);
}

// テストケース3: プロフィットロック (+0.8%まで伸びた後、買値同値まで押されて同値微益ガード)
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 3, maxPrice: 1008 };
    // ピーク+0.8%到達後、安値1000まで下落 -> 損失転落せず買値+1円でガード
    const candle = { open: 1005, high: 1006, low: 1000, close: 1001 };
    const res = simulateScalpExit(pos, candle);
    assert.strictEqual(res.exitReason, "PROFIT_LOCK_GUARD");
    assert.strictEqual(res.exitPrice, 1001);
    console.log("✅ [Test 3] プロフィットロック (損失転落完全防止): 成功 -> PROFIT_LOCK_GUARD 約定 ¥" + res.exitPrice);
}

// テストケース4: モメンタム失速手仕舞い (EMA5割れ + 微益+0.4%確保)
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 3, maxPrice: 1005 };
    const candle = { open: 1005, high: 1005, low: 1003, close: 1004, ema5: 1006 };
    const res = simulateScalpExit(pos, candle);
    assert.strictEqual(res.exitReason, "MOMENTUM_EMA5_FADE");
    assert.strictEqual(res.exitPrice, 1004);
    console.log("✅ [Test 4] モメンタム失速・超短期EMA5割れ手仕舞い: 成功 -> MOMENTUM_EMA5_FADE 約定 ¥" + res.exitPrice);
}

// テストケース5: 損切り (-1.2% 到達)
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 2, maxPrice: 1000 };
    const candle = { open: 995, high: 995, low: 987, close: 988 };
    const res = simulateScalpExit(pos, candle);
    assert.strictEqual(res.exitReason, "STOP_LOSS");
    assert.strictEqual(res.exitPrice, 988);
    console.log("✅ [Test 5] 通常損切り (-1.2%): 成功 -> STOP_LOSS 約定 ¥" + res.exitPrice);
}

// テストケース6: 大引け手仕舞い (当日15:00)
{
    const pos = { entryPrice: 1000, takeProfitPrice: 1015, stopLossPrice: 988, holdingBars: 2, maxPrice: 1003 };
    const candle = { open: 1002, high: 1003, low: 1001, close: 1002 };
    const res = simulateScalpExit(pos, candle, true, false, true);
    assert.strictEqual(res.exitReason, "MARKET_CLOSE");
    assert.strictEqual(res.exitPrice, 1002);
    console.log("✅ [Test 6] 大引け手仕舞い (持ち越しゼロ): 成功 -> MARKET_CLOSE 約定 ¥" + res.exitPrice);
}

console.log("\n🎉 全てのプロ仕様スキャルピング決済テストが正常に通過しました！");
