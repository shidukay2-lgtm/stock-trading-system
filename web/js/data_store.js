/**
 * データストレージ & 資産・複利管理モジュール (web/js/data_store.js)
 * サーバー側DB (/api/account, /api/trades, /api/positions) と LocalStorage による完全永続化
 * 複利再投資運用・動的勝率・資産推移スナップショット管理
 */

/**
 * 日本時間 (JST: UTC+9) の現在日時文字列 (YYYY-MM-DD HH:mm:ss または HH:mm) を生成する共通ヘルパー
 */
function getNowJSTString(includeSeconds = true) {
    const now = new Date();
    // JST = UTC+9
    const jstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const y = jstDate.getUTCFullYear();
    const m = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(jstDate.getUTCDate()).padStart(2, '0');
    const h = String(jstDate.getUTCHours()).padStart(2, '0');
    const min = String(jstDate.getUTCMinutes()).padStart(2, '0');
    const sec = String(jstDate.getUTCSeconds()).padStart(2, '0');
    return includeSeconds ? `${y}-${m}-${d} ${h}:${min}:${sec}` : `${y}-${m}-${d} ${h}:${min}`;
}
window.getNowJSTString = getNowJSTString;

class DataStore {
    constructor() {
        this.STORAGE_KEY_POSITIONS = "sts_active_positions_v1";
        this.STORAGE_KEY_TRADES = "sts_trade_history_v1";
        this.STORAGE_KEY_NOTES = "sts_trade_notes_v1";
        this.STORAGE_KEY_ACCOUNT = "sts_account_data_v1";
        this.STORAGE_KEY_AUTOTRADE = "sts_autotrade_enabled_v1";
        this.STORAGE_KEY_STRATEGY_TOGGLES = "sts_strategy_toggles_v1";
        this.STORAGE_KEY_FILTER_70 = "sts_filter_70_plus_v1";

        // 初期値
        this.initialCapital = 300000;
        this.cash = 300000;
        this.compoundingEnabled = true;
        this.positions = this.loadLocalPositions();
        this.trades = this.loadLocalTrades();
        this.notes = this.loadLocalNotes();
        this.equityHistory = this.loadLocalEquityHistory();
        this.autoTradingEnabled = this.loadAutoTradingEnabled();
        this.strategyToggles = this.loadStrategyToggles();
        this.filter70PlusOnly = this.loadFilter70PlusOnly();

        this.loadLocalAccount();
    }

    loadStrategyToggles() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_STRATEGY_TOGGLES);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return { triple_confluence: true, orderbook_vwap: true, mtf_scalping: true };
    }

    saveStrategyToggles(toggles) {
        this.strategyToggles = toggles;
        try {
            localStorage.setItem(this.STORAGE_KEY_STRATEGY_TOGGLES, JSON.stringify(toggles));
        } catch (e) {}
    }

    loadFilter70PlusOnly() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_FILTER_70);
            if (raw !== null) return JSON.parse(raw);
        } catch (e) {}
        return false;
    }

    saveFilter70PlusOnly(enabled) {
        this.filter70PlusOnly = Boolean(enabled);
        try {
            localStorage.setItem(this.STORAGE_KEY_FILTER_70, JSON.stringify(this.filter70PlusOnly));
        } catch (e) {}
    }

    // --- 1. サーバーDBとの非同期同期 ---
    async syncFromServer() {
        try {
            // (1) アカウント・資産推移の取得
            const accRes = await fetch('/api/account');
            if (accRes.ok) {
                const accData = await accRes.json();
                if (accData.success && accData.account) {
                    this.initialCapital = Number(accData.account.initialCapital) || 300000;
                    this.cash = Number(accData.account.cash) || this.initialCapital;
                    this.compoundingEnabled = accData.account.compoundingEnabled !== undefined ? Boolean(accData.account.compoundingEnabled) : true;
                    if (accData.equityHistory && accData.equityHistory.length > 0) {
                        this.equityHistory = accData.equityHistory;
                    }
                    this.saveLocalAccount();
                }
            }

            // (2) トレード履歴の取得
            const tradesRes = await fetch('/api/trades');
            if (tradesRes.ok) {
                const tradesData = await tradesRes.json();
                if (tradesData.success && tradesData.trades) {
                    this.trades = tradesData.trades;
                    this.saveLocalTrades();
                }
            }

            // (3) 保有ポジションの取得
            const posRes = await fetch('/api/positions');
            if (posRes.ok) {
                const posData = await posRes.json();
                if (posData.success && posData.positions) {
                    this.positions = posData.positions;
                    this.saveLocalPositions();
                }
            }
            console.log('[DataStore] サーバーDBとの同期完了: トレード数 =', this.trades.length, '保有ポジション数 =', this.positions.length, '現在残高 =', this.cash);
            return true;
        } catch (e) {
            console.warn('[DataStore] サーバー同期オフラインフォールバック (LocalStorage利用):', e.message);
            return false;
        }
    }

    // --- 2. LocalStorage フォールバック操作 ---
    loadLocalAccount() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY_ACCOUNT);
            if (raw) {
                const data = JSON.parse(raw);
                if (data.initialCapital) this.initialCapital = Number(data.initialCapital);
                if (data.cash !== undefined) this.cash = Number(data.cash);
                if (data.compoundingEnabled !== undefined) this.compoundingEnabled = Boolean(data.compoundingEnabled);
                if (data.equityHistory) this.equityHistory = data.equityHistory;
            }
        } catch (e) {}
    }

    saveLocalAccount() {
        try {
            localStorage.setItem(this.STORAGE_KEY_ACCOUNT, JSON.stringify({
                initialCapital: this.initialCapital,
                cash: this.cash,
                compoundingEnabled: this.compoundingEnabled,
                equityHistory: this.equityHistory
            }));
        } catch (e) {}
    }

    loadAutoTradingEnabled() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_AUTOTRADE);
            return data !== null ? JSON.parse(data) : true;
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

    loadLocalPositions() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_POSITIONS);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    saveLocalPositions() {
        try {
            localStorage.setItem(this.STORAGE_KEY_POSITIONS, JSON.stringify(this.positions));
        } catch (e) {}
    }

    loadLocalTrades() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_TRADES);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    saveLocalTrades() {
        try {
            localStorage.setItem(this.STORAGE_KEY_TRADES, JSON.stringify(this.trades));
        } catch (e) {}
    }

    loadLocalNotes() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY_NOTES);
            return data ? JSON.parse(data) : {};
        } catch (e) {
            return {};
        }
    }

    saveLocalNotes() {
        try {
            localStorage.setItem(this.STORAGE_KEY_NOTES, JSON.stringify(this.notes));
        } catch (e) {}
    }

    loadLocalEquityHistory() {
        return [{
            time: getNowJSTString(),
            equity: this.initialCapital,
            cash: this.initialCapital,
            positionsValue: 0,
            realizedPnl: 0,
            unrealizedPnl: 0,
            returnPct: 0.0,
            note: "初期元本設定"
        }];
    }

    // --- 3. アカウント & 複利設定の更新 ---
    async updateAccountSettings(initialCapital, compoundingEnabled, reset = false) {
        this.initialCapital = Number(initialCapital) || this.initialCapital;
        this.compoundingEnabled = Boolean(compoundingEnabled);

        if (reset) {
            this.cash = this.initialCapital;
            this.positions = [];
            this.trades = [];
            this.equityHistory = [{
                time: getNowJSTString(),
                equity: this.initialCapital,
                cash: this.initialCapital,
                positionsValue: 0,
                realizedPnl: 0,
                unrealizedPnl: 0,
                returnPct: 0.0,
                note: `データリセット (元本 ¥${this.initialCapital.toLocaleString()})`
            }];
            this.saveLocalPositions();
            this.saveLocalTrades();
        }

        this.saveLocalAccount();

        // サーバーDBへ非同期保存
        try {
            await fetch('/api/account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    initialCapital: this.initialCapital,
                    cash: this.cash,
                    compoundingEnabled: this.compoundingEnabled,
                    reset: reset
                })
            });
        } catch (e) {
            console.warn('[DataStore] サーバーアカウント更新エラー:', e);
        }
    }

    // --- 4. ポジション操作 ---
    async addPosition(position) {
        const existingIdx = this.positions.findIndex(p => p.symbol === position.symbol);
        if (existingIdx >= 0) {
            this.positions[existingIdx] = position;
        } else {
            this.positions.push(position);
            // 資金拘束
            const invest = Number(position.investmentAmount) || (position.entryPrice * position.shares);
            this.cash = Math.max(0, this.cash - invest);
        }
        this.saveLocalPositions();
        this.saveLocalAccount();

        // サーバーDBへ非同期POST
        try {
            fetch('/api/positions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(position)
            });
        } catch (e) {}
    }

    async closePosition(symbol, exitPrice, exitReason = "MANUAL", note = "", tags = "") {
        const idx = this.positions.findIndex(p => p.symbol === symbol);
        if (idx < 0) return null;

        const pos = this.positions[idx];
        const pnlAmount = Math.round((exitPrice - pos.entryPrice) * pos.shares);
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const invest = Number(pos.investmentAmount) || (pos.entryPrice * pos.shares);

        const trade = {
            trade_id: "REAL-" + Date.now().toString(36).toUpperCase(),
            symbol: pos.symbol,
            symbol_name: pos.symbolName,
            strategy_name: pos.strategyName || "HighWin_TripleConfluence",
            entry_time: pos.entryTime,
            exit_time: getNowJSTString(),
            entry_price: pos.entryPrice,
            exit_price: exitPrice,
            shares: pos.shares,
            investment_amount: invest,
            pnl_amount: pnlAmount,
            pnl_pct: parseFloat(pnlPct.toFixed(2)),
            holding_bars: pos.holdingBars || 1,
            holding_days: parseFloat(((pos.holdingBars || 1) / 5).toFixed(1)),
            exit_reason: exitReason,
            notes: note || pos.notes || "リアル約定決済",
            tags: tags || "#REAL #HighWin"
        };

        // 資金プール返却（元本 ＋ 損益額を合算して複利再投資に回す）
        this.cash = Math.max(0, this.cash + invest + pnlAmount);

        this.trades.unshift(trade);
        this.positions.splice(idx, 1);

        // 資産推移スナップショットの記録
        const totalRealizedPnl = this.trades.reduce((sum, t) => sum + (Number(t.pnl_amount) || 0), 0);
        const currentEquity = this.initialCapital + totalRealizedPnl;
        const returnPct = ((currentEquity - this.initialCapital) / this.initialCapital) * 100;

        this.equityHistory.push({
            time: trade.exit_time,
            equity: currentEquity,
            cash: this.cash,
            positionsValue: 0,
            realizedPnl: totalRealizedPnl,
            unrealizedPnl: 0,
            returnPct: parseFloat(returnPct.toFixed(2)),
            note: `${pos.symbolName} 決済: ${pnlAmount >= 0 ? '+' : ''}¥${Math.round(pnlAmount).toLocaleString()} (${exitReason})`
        });

        this.saveLocalPositions();
        this.saveLocalTrades();
        this.saveLocalAccount();

        // サーバーDBへ非同期保存 & ポジション削除
        try {
            fetch('/api/trades', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(trade)
            });
            fetch(`/api/positions/${encodeURIComponent(symbol)}`, {
                method: 'DELETE'
            });
        } catch (e) {}

        return trade;
    }

    // --- 5. 通算統計 & 動的勝率・時価総資産の算出 ---
    getSummaryStats(currentMarketPrices = {}) {
        const allTrades = this.trades;
        const wins = allTrades.filter(t => Number(t.pnl_amount) > 0);
        const losses = allTrades.filter(t => Number(t.pnl_amount) <= 0);

        const totalProfit = wins.reduce((sum, t) => sum + Number(t.pnl_amount), 0);
        const totalLoss = Math.abs(losses.reduce((sum, t) => sum + Number(t.pnl_amount), 0));
        const totalRealizedPnl = Math.round(totalProfit - totalLoss);
        const pf = totalLoss > 0 ? (totalProfit / totalLoss) : (totalProfit > 0 ? 99.9 : 0);

        const winRate = allTrades.length > 0 
            ? parseFloat(((wins.length / allTrades.length) * 100).toFixed(1))
            : 0.0;

        // 保有中ポジションの時価評価と含み損益
        let totalInvested = 0;
        let totalPositionsMarketValue = 0;
        let totalUnrealizedPnl = 0;

        this.positions.forEach(pos => {
            const currentPrice = Number(currentMarketPrices[pos.symbol]) || Number(pos.entryPrice);
            const posInvest = Number(pos.investmentAmount) || (Number(pos.entryPrice) * Number(pos.shares));
            const posMarketVal = currentPrice * Number(pos.shares);
            const posUnrealized = posMarketVal - posInvest;

            totalInvested += posInvest;
            totalPositionsMarketValue += posMarketVal;
            totalUnrealizedPnl += posUnrealized;
        });

        // 総資産 = 現金残高 + 保有株の時価総額 (ポジション0件時は initialCapital + totalRealizedPnl と完全一致)
        const totalEquity = this.positions.length > 0
            ? Math.round(this.cash + totalPositionsMarketValue)
            : Math.round(this.initialCapital + totalRealizedPnl);

        const totalPnl = Math.round(totalRealizedPnl + totalUnrealizedPnl);
        const returnPct = this.initialCapital > 0 
            ? parseFloat((((totalEquity - this.initialCapital) / this.initialCapital) * 100).toFixed(2))
            : 0.0;

        return {
            totalTrades: allTrades.length,
            winCount: wins.length,
            lossCount: losses.length,
            wins: wins.length,
            losses: losses.length,
            winRate: winRate,
            totalPnl: totalPnl,
            realizedPnl: totalRealizedPnl,
            unrealizedPnl: Math.round(totalUnrealizedPnl),
            totalInvested: Math.round(totalInvested),
            totalMarketValue: Math.round(totalPositionsMarketValue),
            profitFactor: parseFloat(pf.toFixed(2)),
            initialCapital: this.initialCapital,
            cash: Math.round(this.cash),
            totalEquity: totalEquity,
            returnPct: returnPct,
            compoundingEnabled: this.compoundingEnabled
        };
    }
}

// グローバル公開
window.DataStore = DataStore;
