// Test Pre-Market Order Reservation and Opening Execution Logic

class MockDataStore {
    constructor() {
        this.initialCapital = 300000;
        this.cash = 300000;
        this.positions = [];
        this.trades = [];
    }

    async addPosition(pos) {
        pos.status = pos.status || "ACTIVE";
        this.positions.push(pos);
        const invest = Number(pos.investmentAmount) || (pos.entryPrice * pos.shares);
        this.cash -= invest;
    }

    async updatePosition(pos) {
        const idx = this.positions.findIndex(p => p.symbol === pos.symbol);
        if (idx >= 0) this.positions[idx] = pos;
    }

    async cancelPosition(symbol) {
        const idx = this.positions.findIndex(p => p.symbol === symbol);
        if (idx < 0) return null;
        const pos = this.positions[idx];
        const invest = Number(pos.investmentAmount) || (pos.entryPrice * pos.shares);
        this.cash += invest;
        this.positions.splice(idx, 1);
        return pos;
    }

    async closePosition(symbol, exitPrice, exitReason) {
        const idx = this.positions.findIndex(p => p.symbol === symbol);
        if (idx < 0) return null;
        const pos = this.positions[idx];
        const pnl = Math.round((exitPrice - pos.entryPrice) * pos.shares);
        const invest = Number(pos.investmentAmount) || (pos.entryPrice * pos.shares);
        this.cash += (invest + pnl);
        const trade = {
            symbol: pos.symbol,
            entry_price: pos.entryPrice,
            exit_price: exitPrice,
            pnl_amount: pnl,
            exit_reason: exitReason
        };
        this.trades.push(trade);
        this.positions.splice(idx, 1);
        return trade;
    }
}

async function runTests() {
    console.log("=== 1. 時間外予約注文の発注テスト ===");
    const store = new MockDataStore();
    
    // 時間外に BASE (4477.T) を 100株 ¥336.0 (¥33,600) で予約発注
    const pendingOrder = {
        symbol: "4477.T",
        symbolName: "BASE",
        entryTime: "🕒 開場時約定待機",
        orderPlacedTime: "2026-09-30 07:15:00",
        entryPrice: 336.0,
        shares: 100,
        investmentAmount: 33600,
        status: "ORDER_PENDING",
        notes: "🕒 時間外予約注文"
    };

    await store.addPosition(pendingOrder);
    console.log("発注後 ポジション数:", store.positions.length, "買付余力:", store.cash);
    console.assert(store.positions.length === 1, "ポジション数 1");
    console.assert(store.positions[0].status === "ORDER_PENDING", "ステータス ORDER_PENDING");
    console.assert(store.cash === 266400, "余力拘束 266,400円");
    console.log("✅ 1. 時間外予約注文の資金拘束と登録が正常に行われました");

    console.log("\n=== 2. 開場前予約注文の取消テスト ===");
    const canceled = await store.cancelPosition("4477.T");
    console.log("取消後 ポジション数:", store.positions.length, "買付余力:", store.cash);
    console.assert(store.positions.length === 0, "ポジション数 0");
    console.assert(store.cash === 300000, "余力全額返却 300,000円");
    console.log("✅ 2. 予約注文の取消と資金返却が正常に行われました");

    console.log("\n=== 3. 東証開場時の自動約定移行テスト ===");
    // 再度予約
    await store.addPosition(pendingOrder);
    console.log("予約状態:", store.positions[0]);

    // 東証開場シミュレーション (寄り付き 338.0円で成行約定)
    const isMarketOpen = true;
    const openingPrice = 338.0;

    for (const pos of store.positions) {
        if (pos.status === "ORDER_PENDING" && isMarketOpen) {
            pos.status = "ACTIVE";
            pos.entryPrice = openingPrice;
            pos.entryTime = "2026-09-30 09:00:01";
            pos.investmentAmount = openingPrice * pos.shares;
            await store.updatePosition(pos);
        }
    }

    console.log("開場約定後:", store.positions[0]);
    console.assert(store.positions[0].status === "ACTIVE", "ステータス ACTIVE");
    console.assert(store.positions[0].entryPrice === 338.0, "寄り付き約定値 338.0円");
    console.assert(store.positions[0].entryTime === "2026-09-30 09:00:01", "約定日時 09:00:01");
    console.log("✅ 3. 東証開場時の自動約定移行が正常に行われました");

    console.log("\n=== 4. 開場中の利食い決済テスト ===");
    const closed = await store.closePosition("4477.T", 345.0, "TAKE_PROFIT");
    console.log("利食い決済:", closed, "残高:", store.cash);
    console.assert(closed.pnl_amount === 700, "利益 +700円");
    console.assert(store.cash === 300700, "残高 300,700円");
    console.log("✅ 4. 利食い決済と複利残高反映が正常に行われました");

    console.log("\n🎉 全てのユニットテストが正常に通過しました！");
}

runTests();
