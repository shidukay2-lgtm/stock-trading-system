/**
 * データストレージ & ポジション管理モジュール (web/js/data_store.js)
 * LocalStorageを用いたポジション・トレード履歴・振り返りメモの永続化
 */

class DataStore {
    constructor() {
        this.STORAGE_KEY_POSITIONS = "sts_active_positions_v1";
        this.STORAGE_KEY_TRADES = "sts_trade_history_v1";
        this.STORAGE_KEY_NOTES = "sts_trade_notes_v1";
        this.STORAGE_KEY_SETTINGS = "sts_user_settings_v1";
        this.STORAGE_KEY_AUTOTRADE = "sts_autotrade_enabled_v1";

        this.positions = this.loadPositions();
        this.trades = this.loadTrades();
        this.notes = this.loadNotes();
        this.autoTradingEnabled = this.loadAutoTradingEnabled();
    }

    loadAutoTradingEnabled() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_AUTOTRADE);
            return data !== null ? JSON.parse(data) : true; // デフォルトで有効
        } catch (e) {
            return true;
        }
    }

    saveAutoTradingEnabled(enabled) {
        this.autoTradingEnabled = enabled;
        try {
            localStorage.setItem(this.STORAGE_KEY_AUTOTRADE, JSON.stringify(enabled));
        } catch (e) {
            console.error("自動売買設定保存エラー:", e);
        }
    }
    }

    loadPositions() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_POSITIONS);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    savePositions() {
        try {
            localStorage.setItem(this.STORAGE_KEY_POSITIONS, JSON.stringify(this.positions));
        } catch (e) {
            console.error("ポジション保存エラー:", e);
        }
    }

    loadTrades() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_TRADES);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    saveTrades() {
        try {
            localStorage.setItem(this.STORAGE_KEY_TRADES, JSON.stringify(this.trades));
        } catch (e) {
            console.error("トレード履歴保存エラー:", e);
        }
    }

    loadNotes() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_NOTES);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            return {};
        }
    }

    saveNotes() {
        try {
            localStorage.setItem(this.STORAGE_KEY_NOTES, JSON.stringify(this.notes));
        } catch (e) {
            console.error("メモ保存エラー:", e);
        }
    }

    // --- ポジション操作 ---

    addPosition(position) {
        // 重複チェック
        const existingIdx = this.positions.findIndex(p => p.symbol === position.symbol);
        if (existingIdx >= 0) {
            this.positions[existingIdx] = position;
        } else {
            this.positions.push(position);
        }
        this.savePositions();
    }

    closePosition(symbol, exitPrice, exitReason = "MANUAL", note = "", tags = "") {
        const idx = this.positions.findIndex(p => p.symbol === symbol);
        if (idx < 0) return null;

        const pos = this.positions[idx];
        const pnlAmount = Math.round((exitPrice - pos.entryPrice) * pos.shares);
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

        const trade = {
            trade_id: "REAL-" + Date.now().toString(36).toUpperCase(),
            symbol: pos.symbol,
            symbol_name: pos.symbolName,
            strategy_name: pos.strategyName || "HighWin_TripleConfluence",
            entry_time: pos.entryTime,
            exit_time: new Date().toISOString().replace("T", " ").substring(0, 16),
            entry_price: pos.entryPrice,
            exit_price: exitPrice,
            shares: pos.shares,
            investment_amount: pos.investmentAmount,
            pnl_amount: pnlAmount,
            pnl_pct: parseFloat(pnlPct.toFixed(2)),
            holding_bars: pos.holdingBars || 1,
            holding_days: parseFloat(((pos.holdingBars || 1) / 5).toFixed(1)),
            exit_reason: exitReason,
            notes: note || pos.notes || "手動リアルトレード決済",
            tags: tags || "#MANUAL #HighWin"
        };

        this.trades.unshift(trade);
        this.positions.splice(idx, 1);
        this.savePositions();
        this.saveTrades();

        return trade;
    }

    updateTradeNote(tradeId, note, tags = "") {
        const trade = this.trades.find(t => t.trade_id === tradeId);
        if (trade) {
            trade.notes = note;
            if (tags) trade.tags = tags;
            this.saveTrades();
            return true;
        }
        return false;
    }

    // --- 通算統計算出 ---

    getSummaryStats() {
        const allTrades = this.trades;
        if (allTrades.length === 0) {
            return {
                totalTrades: 0,
                winRate: 0,
                totalPnl: 0,
                profitFactor: 0,
                wins: 0,
                losses: 0
            };
        }

        const wins = allTrades.filter(t => t.pnl_amount > 0);
        const losses = allTrades.filter(t => t.pnl_amount <= 0);

        const totalProfit = wins.reduce((sum, t) => sum + t.pnl_amount, 0);
        const totalLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl_amount, 0));
        const pf = totalLoss > 0 ? (totalProfit / totalLoss) : (totalProfit > 0 ? 99.9 : 0);

        return {
            totalTrades: allTrades.length,
            winRate: parseFloat(((wins.length / allTrades.length) * 100).toFixed(1)),
            totalPnl: Math.round(totalProfit - totalLoss),
            profitFactor: parseFloat(pf.toFixed(2)),
            wins: wins.length,
            losses: losses.length
        };
    }
}

window.DataStore = DataStore;
