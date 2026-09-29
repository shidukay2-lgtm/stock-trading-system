// Pagination Logic Unit Test
const tradesMock = [];
for (let i = 1; i <= 45; i++) {
    tradesMock.push({
        id: `trade-${i}`,
        symbol: "4477.T",
        symbol_name: "BASE",
        entry_price: 330,
        exit_price: i % 3 === 0 ? 320 : 340,
        pnl_amount: i % 3 === 0 ? -1000 : 1000,
        pnl_pct: i % 3 === 0 ? "-3.0" : "+3.0",
        exit_time: `2026-09-${String(i % 28 + 1).padStart(2, '0')} 14:00`,
        shares: 100,
        investment_amount: 33000,
        exit_reason: i % 3 === 0 ? "STOP_LOSS" : "TAKE_PROFIT",
        notes: "テスト用トレード記録"
    });
}

function testPagination(trades, pageSize, filter, currentPage) {
    let filtered = trades;
    if (filter === "win") {
        filtered = trades.filter(t => t.pnl_amount > 0);
    } else if (filter === "loss") {
        filtered = trades.filter(t => t.pnl_amount <= 0);
    }

    const totalCount = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const validCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

    const startIndex = (validCurrentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalCount);
    const pageItems = filtered.slice(startIndex, endIndex);

    return {
        totalCount,
        totalPages,
        currentPage: validCurrentPage,
        startIndex,
        endIndex,
        displayedCount: pageItems.length,
        firstItem: pageItems[0] ? pageItems[0].id : null,
        lastItem: pageItems[pageItems.length - 1] ? pageItems[pageItems.length - 1].id : null
    };
}

console.log("=== テスト1: 20件表示 (デフォルト), ページ1 ===");
const res1 = testPagination(tradesMock, 20, "all", 1);
console.log(res1);
if (res1.totalCount === 45 && res1.totalPages === 3 && res1.displayedCount === 20 && res1.startIndex === 0 && res1.endIndex === 20) {
    console.log("✅ テスト1 パス: 20件が正常にスライスされました (1〜20件)");
} else {
    console.error("❌ テスト1 失敗");
}

console.log("\n=== テスト2: 20件表示, ページ2 ===");
const res2 = testPagination(tradesMock, 20, "all", 2);
console.log(res2);
if (res2.currentPage === 2 && res2.displayedCount === 20 && res2.startIndex === 20 && res2.endIndex === 40) {
    console.log("✅ テスト2 パス: 21〜40件が正常にスライスされました");
} else {
    console.error("❌ テスト2 失敗");
}

console.log("\n=== テスト3: 20件表示, ページ3 (最終ページ5件) ===");
const res3 = testPagination(tradesMock, 20, "all", 3);
console.log(res3);
if (res3.currentPage === 3 && res3.displayedCount === 5 && res3.startIndex === 40 && res3.endIndex === 45) {
    console.log("✅ テスト3 パス: 41〜45件 (5件) が正常にスライスされました");
} else {
    console.error("❌ テスト3 失敗");
}

console.log("\n=== テスト4: 10件表示切替, ページ1 ===");
const res4 = testPagination(tradesMock, 10, "all", 1);
console.log(res4);
if (res4.totalPages === 5 && res4.displayedCount === 10) {
    console.log("✅ テスト4 パス: 10件表示で全5ページに分割されました");
} else {
    console.error("❌ テスト4 失敗");
}

console.log("\n=== テスト5: 勝ちトレードフィルター (win) ===");
const res5 = testPagination(tradesMock, 20, "win", 1);
console.log(res5);
if (res5.totalCount === 30 && res5.totalPages === 2) {
    console.log("✅ テスト5 パス: 勝ちトレードのみ30件抽出され全2ページになりました");
} else {
    console.error("❌ テスト5 失敗");
}
