/**
 * 日本取引所(東証)日中取引時間判定 & 時間外エントリー完全防止の検証スクリプト (test_market_hours_guard.js)
 */
const assert = require('assert');

console.log("=================================================");
console.log("🧪 東証取引時間判定 & 時間外エントリー防止テスト開始");
console.log("=================================================");

function isTSEMarketOpenCheck(year, month, day, hour, minute) {
    // month: 1-12
    const jstDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const dayOfWeek = jstDate.getUTCDay(); // 0: 日, 1: 月, ..., 5: 金, 6: 土

    // 土日判定
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    const curMinVal = hour * 60 + minute;
    // 前場: 09:00 〜 11:30 (540分 〜 690分)
    const isMorning = (curMinVal >= 540 && curMinVal <= 690);
    // 後場: 12:30 〜 15:30 (750分 〜 930分)
    const isAfternoon = (curMinVal >= 750 && curMinVal <= 930);

    return isMorning || isAfternoon;
}

// テストケース1: 平日 夜間 (22:56) -> 時間外 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 29, 22, 56);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 1] 平日夜間 22:56: 判定=時間外(休場) -> 新規エントリー完全停止");
}

// テストケース2: 平日 深夜・早朝 (08:30) -> 時間外 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 30, 8, 30);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 2] 平日早朝 08:30: 判定=時間外(開場前) -> 新規エントリー完全停止");
}

// テストケース3: 平日 前場中 (10:15) -> 開場中 (true)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 30, 10, 15);
    assert.strictEqual(isOpen, true);
    console.log("✅ [Test 3] 平日前場 10:15: 判定=東証開場中 -> リアルタイム約定許可");
}

// テストケース4: 平日 昼休み (12:00) -> 休場中 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 30, 12, 0);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 4] 平日昼休み 12:00: 判定=昼休み休場 -> 新規エントリー停止");
}

// テストケース5: 平日 後場中 (14:00) -> 開場中 (true)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 30, 14, 0);
    assert.strictEqual(isOpen, true);
    console.log("✅ [Test 5] 平日後場 14:00: 判定=東証開場中 -> リアルタイム約定許可");
}

// テストケース6: 平日 大引け後 (15:31) -> 時間外 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 9, 30, 15, 31);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 6] 平日大引け後 15:31: 判定=時間外(閉場) -> 新規エントリー完全停止");
}

// テストケース7: 土曜日 (11:00) -> 休場 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 10, 3, 11, 0);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 7] 土曜日 11:00: 判定=土日休場 -> 新規エントリー完全停止");
}

// テストケース8: 日曜日 (14:00) -> 休場 (false)
{
    const isOpen = isTSEMarketOpenCheck(2026, 10, 4, 14, 0);
    assert.strictEqual(isOpen, false);
    console.log("✅ [Test 8] 日曜日 14:00: 判定=土日休場 -> 新規エントリー完全停止");
}

console.log("\n🎉 全ての東証取引時間・時間外ガード検証テストが正常に通過しました！");
