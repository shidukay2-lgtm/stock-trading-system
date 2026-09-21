/**
 * メインアプリケーションロジック (web/js/app.js)
 * - リアルタイム相場監視 & オートスクリーニング（30秒自動ポーリング / 手動即時更新）
 * - 東証取引時間帯（開場/閉場）自動ステータス判定
 * - 勝率65%以上・100株単元<=10万円の動的トップ5〜10銘柄リバランス
 * - シグナル点灯日時の明示 & マルチチャネル自動通知
 * - サーバーDB永続化 & 動的勝率集計 & 複利運用・資産推移グラフ可視化
 */

document.addEventListener("DOMContentLoaded", async () => {
    const dataStore = new DataStore();
    const strategy = new TripleConfluenceStrategy();
    const notifier = new NotificationManager();
    const chart = new TradingChart("main-chart-container");

    let symbolsData = null;
    let currentSymbolCode = "4477.T"; // 初期選択
    let currentChartMode = "candle"; // 'candle' または 'equity'
    let refreshCountdown = 30;
    let isRefreshing = false;

    // --- 0. リアルタイム自動売買エンジン (AutoTrader・複利再投資対応) ---
    async function processAutoTrading() {
        if (!symbolsData || !symbolsData.symbols) return;
        if (!dataStore.autoTradingEnabled) return;

        // 1. 保有中ポジションの自動決済チェック (利食い / 損切り / 期限満了)
        const currentPositions = [...dataStore.positions];
        for (const pos of currentPositions) {
            const sym = symbolsData.symbols[pos.symbol];
            if (!sym || !sym.candles || sym.candles.length === 0) continue;

            const latest = sym.candles[sym.candles.length - 1];
            const currentClose = Number(latest.close);
            const currentHigh = Number(latest.high) || currentClose;
            const currentLow = Number(latest.low) || currentClose;

            // 保有バー数の更新 (エントリー時刻以降のバー数を正確に集計)
            let barsCount = 0;
            for (let i = 0; i < sym.candles.length; i++) {
                if (sym.candles[i].time >= pos.entryTime) {
                    barsCount++;
                }
            }
            pos.holdingBars = Math.max(1, barsCount);

            let exitPrice = null;
            let exitReason = null;
            let exitNote = "";

            // (1) 利確判定 (+6.0%以上)
            if (currentHigh >= pos.takeProfitPrice || currentClose >= pos.takeProfitPrice) {
                exitPrice = Math.max(pos.takeProfitPrice, currentClose);
                exitReason = "TAKE_PROFIT";
                exitNote = `🎯 自動利食い約定 (+6.0%達成: ¥${exitPrice.toLocaleString()})`;
            }
            // (2) 損切判定 (-2.5%以下)
            else if (currentLow <= pos.stopLossPrice || currentClose <= pos.stopLossPrice) {
                exitPrice = Math.min(pos.stopLossPrice, currentClose);
                exitReason = "STOP_LOSS";
                exitNote = `🛑 自動損切り約定 (-2.5%到達: ¥${exitPrice.toLocaleString()})`;
            }
            // (3) 保有期限満了 (15バー / 3営業日)
            else if (pos.holdingBars >= 15) {
                exitPrice = currentClose;
                exitReason = "TIMEOUT";
                exitNote = `⌛ 保有期限満了決済 (3営業日/15バー経過: ¥${exitPrice.toLocaleString()})`;
            }

            if (exitPrice !== null && exitReason !== null) {
                console.log(`[AutoTrade] 自動決済執行: ${pos.symbolName} (${pos.symbol}) - 理由: ${exitReason}, 決済価格: ¥${exitPrice}`);
                const closedTrade = await dataStore.closePosition(pos.symbol, exitPrice, exitReason, exitNote, `#AUTO #${exitReason}`);
                if (closedTrade) {
                    notifier.notifyTradeExit(closedTrade, pos.symbolName);
                }
            }
        }

        // 2. 新規買いシグナルの自動エントリーチェック (複利資金プール連動)
        const maxConcurrentPositions = 3; // 同時保有上限 (最大3銘柄分散)
        if (dataStore.positions.length < maxConcurrentPositions) {
            const symKeys = Object.keys(symbolsData.symbols);
            for (const code of symKeys) {
                if (dataStore.positions.length >= maxConcurrentPositions) break;

                const sym = symbolsData.symbols[code];
                const activePos = dataStore.positions.find(p => p.symbol === code);
                if (activePos) continue; // すでに保有中ならスキップ

                const analyzed = strategy.analyzeCandles(sym.candles);
                const latest = analyzed[analyzed.length - 1];

                if (latest && latest.isBuySignal) {
                    // 複利設定に基づき注文サイズを自動計算 (100株単元厳守)
                    const orderCalc = strategy.calculateOrderSize(latest.close, dataStore.cash, dataStore.compoundingEnabled);
                    if (orderCalc.shares > 0 && orderCalc.investment <= dataStore.cash) {
                        const entryPrice = latest.close;
                        const pos = {
                            symbol: sym.info.code,
                            symbolName: sym.info.name,
                            entryTime: latest.time || new Date().toISOString().replace("T", " ").substring(0, 16),
                            entryPrice: entryPrice,
                            shares: orderCalc.shares,
                            investmentAmount: orderCalc.investment,
                            stopLossPrice: latest.stopLossPrice || (entryPrice * (1 - 0.025)),
                            takeProfitPrice: latest.takeProfitPrice || (entryPrice * (1 + 0.060)),
                            strategyName: "HighWin_TripleConfluence",
                            holdingBars: 1,
                            notes: `🤖 リアルタイム自動売買エントリー約定 (${orderCalc.note})`
                        };

                        console.log(`[AutoTrade] 自動エントリー約定: ${pos.symbolName} (${pos.symbol}) - 買値: ¥${pos.entryPrice}, 株数: ${pos.shares}`);
                        await dataStore.addPosition(pos);
                        notifier.notifyBuySignal(sym.info, latest, orderCalc, pos.entryTime);
                    }
                }
            }
        }
    }

    function updateAutoTradeButtonUI() {
        const btn = document.getElementById("btn-toggle-autotrade");
        const statusText = document.getElementById("autotrade-status-text");
        if (!btn || !statusText) return;

        const isEnabled = dataStore.autoTradingEnabled;
        if (isEnabled) {
            btn.style.background = "rgba(0, 230, 118, 0.15)";
            btn.style.borderColor = "var(--accent-green)";
            btn.style.color = "var(--accent-green)";
            statusText.innerText = "自動売買: ON (稼働中)";
        } else {
            btn.style.background = "rgba(255, 255, 255, 0.05)";
            btn.style.borderColor = "rgba(255, 255, 255, 0.2)";
            btn.style.color = "var(--text-muted)";
            statusText.innerText = "自動売買: OFF (停止中)";
        }
    }

    function renderAllUI() {
        if (!symbolsData || !symbolsData.symbols) return;

        try { processAutoTrading(); } catch(e) { console.error("processAutoTrading Error:", e); }
        try { updateAutoTradeButtonUI(); } catch(e) { console.error("updateAutoTradeButtonUI Error:", e); }

        // 初期選択銘柄の調整
        const keys = Object.keys(symbolsData.symbols);
        if (keys.length > 0 && (!currentSymbolCode || !symbolsData.symbols[currentSymbolCode])) {
            currentSymbolCode = keys[0];
        }

        try { updateMarketStatusHeader(); } catch(e) { console.error("updateMarketStatusHeader Error:", e); }
        try { renderSymbolSelector(); } catch(e) { console.error("renderSymbolSelector Error:", e); }
        try { updateGlobalSignalTicker(); } catch(e) { console.error("updateGlobalSignalTicker Error:", e); }
        try { selectSymbol(currentSymbolCode); } catch(e) { console.error("selectSymbol Error:", e); }
        try { renderPositionsTable(); } catch(e) { console.error("renderPositionsTable Error:", e); }
        try { renderTradesTable(); } catch(e) { console.error("renderTradesTable Error:", e); }
        try { renderSummaryKPIs(); } catch(e) { console.error("renderSummaryKPIs Error:", e); }
    }

    // --- 1. データロード (サーバーDB同期 ＋ 相場データ取得) ---
    async function loadData(showLoadingIndicator = false) {
        if (isRefreshing && !showLoadingIndicator) return;
        isRefreshing = true;

        const btnRefreshText = document.getElementById("btn-refresh-text");
        if (btnRefreshText && showLoadingIndicator) {
            btnRefreshText.innerText = "相場データ取得中...";
        }

        // サーバーDBからアカウント・トレード履歴を同期
        await dataStore.syncFromServer();

        try {
            // サーバーAPIから最新マーケットデータを取得 (キャッシュ回避)
            const res = await fetch(`/api/market-data?_t=${Date.now()}`);
            if (res.ok) {
                symbolsData = await res.json();
            } else {
                throw new Error("APIレスポンスエラー");
            }
        } catch (e) {
            console.warn("API取得フォールバック (静的JSONロード):", e);
            try {
                const res = await fetch(`data/symbols_data.json?_t=${Date.now()}`);
                if (res.ok) {
                    symbolsData = await res.json();
                }
            } catch (err) {
                console.error("データロード完全失敗:", err);
            }
        }

        if (!symbolsData || !symbolsData.symbols) {
            symbolsData = createMockSymbolsData();
        }

        isRefreshing = false;
        refreshCountdown = 30;
        if (btnRefreshText) {
            btnRefreshText.innerText = "今すぐ相場更新";
        }

        renderAllUI();
    }

    // --- 2. 東証市場ステータスの反映 ---
    function updateMarketStatusHeader() {
        const headerBadge = document.getElementById("header-market-badge");
        const headerText = document.getElementById("header-market-status-text");
        const sessionLabel = document.getElementById("ticker-session-label");
        const timeText = document.getElementById("ticker-time-text");

        const mStatus = symbolsData.market_status || {
            is_open: false,
            status_text: "⚪ 取引時間外 (最新終値維持)",
            current_time: new Date().toLocaleString("ja-JP")
        };

        if (headerText) {
            headerText.innerText = mStatus.status_text;
        }

        if (headerBadge) {
            headerBadge.style.borderColor = mStatus.is_open ? "var(--accent-green)" : "rgba(255,255,255,0.15)";
        }

        if (sessionLabel) {
            sessionLabel.innerText = mStatus.is_open ? "東証開場中 (リアルタイム配信)" : "東証取引時間外";
        }

        if (timeText) {
            timeText.innerText = `[最終更新: ${symbolsData.generated_at || mStatus.current_time}]`;
        }
    }

    // --- 3. 銘柄セレクター描画 (動的トップ5〜10銘柄 & 単元株 & 点灯日時) ---
    function renderSymbolSelector() {
        const container = document.getElementById("symbols-list");
        if (!container) return;
        container.innerHTML = "";

        const symKeys = Object.keys(symbolsData.symbols);
        symKeys.forEach(code => {
            const sym = symbolsData.symbols[code];
            if (!sym || !sym.info) return;
            const info = sym.info;
            const metrics = sym.metrics || { win_rate_pct: 68.5, latest_signal_time: "-" };
            
            const analyzed = (sym.candles && sym.candles.length >= 30) ? strategy.analyzeCandles(sym.candles) : (sym.candles || []);
            const latest = analyzed.length > 0 ? analyzed[analyzed.length - 1] : { close: info.current_price_approx || 500, isBuySignal: false };
            const activePos = dataStore.positions ? dataStore.positions.find(p => p.symbol === code) : null;
            const isBuyActive = latest ? Boolean(latest.isBuySignal) : false;

            let lastSignalTimeStr = metrics.latest_signal_time || "-";
            for (let i = analyzed.length - 1; i >= 0; i--) {
                if (analyzed[i].isBuySignal) {
                    lastSignalTimeStr = analyzed[i].time;
                    break;
                }
            }

            const chip = document.createElement("div");
            
            let chipClasses = ["symbol-chip"];
            if (code === currentSymbolCode) chipClasses.push("active");
            if (isBuyActive && !activePos) chipClasses.push("signal-buy-active");
            if (activePos) chipClasses.push("position-holding");

            chip.className = chipClasses.join(" ");
            chip.dataset.code = code;

            const currentPrice = Number(latest.close) || Number(info.current_price_approx) || 500;
            const orderCalc = strategy.calculateOrderSize(currentPrice, dataStore.cash, dataStore.compoundingEnabled);

            let statusBadgeHtml = "";
            let detailsHtml = "";

            if (activePos) {
                const entryPrice = Number(activePos.entryPrice) || currentPrice;
                const posShares = Number(activePos.shares) || 100;
                const pnl = (currentPrice - entryPrice) * posShares;
                const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
                const pnlColor = pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)";
                const tpStr = activePos.takeProfitPrice ? Number(activePos.takeProfitPrice).toFixed(1) : (entryPrice * 1.06).toFixed(1);
                const slStr = activePos.stopLossPrice ? Number(activePos.stopLossPrice).toFixed(1) : (entryPrice * 0.975).toFixed(1);
                const entryTimeStr = String(activePos.entryTime || '-');

                statusBadgeHtml = `<span class="badge-status badge-holding" style="background: rgba(0, 229, 255, 0.2); color: #00e5ff; border: 1px solid #00e5ff;">💼 保有中</span>`;
                detailsHtml = `
                    <div class="chip-growth" style="font-size: 12px; color: var(--text-main); margin-top: 2px;">
                        買値 ¥${entryPrice.toLocaleString()} (${posShares}株) | <b style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</b>
                    </div>
                    <div style="font-size: 11px; color: var(--accent-green); margin-top: 2px; display: flex; gap: 8px;">
                        <span>🎯 利確: ¥${tpStr}</span>
                        <span style="color:var(--accent-red)">🛑 損切: ¥${slStr}</span>
                    </div>
                    <div style="font-size: 11px; color: #00e5ff; margin-top: 2px;">
                        ⏰ エントリー: ${entryTimeStr} (保有 ${activePos.holdingBars || 1}/15本)
                    </div>
                `;
            } else if (isBuyActive) {
                statusBadgeHtml = `<span class="badge-status badge-buy">🔔 BUY点灯中</span>`;
                detailsHtml = `
                    <div class="chip-growth" style="font-size: 12px; color: var(--text-muted);">
                        現在値 ¥${currentPrice.toLocaleString()} | ${orderCalc.note}
                    </div>
                    <div style="font-size: 11px; color: var(--primary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        ⏰ 点灯日時: ${lastSignalTimeStr} (自動約定対象)
                    </div>
                `;
            } else {
                statusBadgeHtml = `<span class="badge-status badge-wait">⏳ 待機中</span>`;
                detailsHtml = `
                    <div class="chip-growth" style="font-size: 12px; color: var(--text-muted);">
                        現在値 ¥${currentPrice.toLocaleString()} | ${orderCalc.note}
                    </div>
                    <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">
                        直近点灯: ${lastSignalTimeStr}
                    </div>
                `;
            }

            chip.innerHTML = `
                <div class="chip-header">
                    <span class="chip-code">${info.code}</span>
                    <div style="display: flex; gap: 4px; align-items: center;">
                        <span class="chip-badge" style="background: rgba(0, 230, 118, 0.2); color: var(--accent-green); border: 1px solid var(--accent-green);">
                            勝率 ${metrics.win_rate_pct}%
                        </span>
                        ${statusBadgeHtml}
                    </div>
                </div>
                <div class="chip-name" style="font-size: 16px; font-weight: 700; margin: 4px 0;">${info.name}</div>
                ${detailsHtml}
            `;

            chip.addEventListener("click", () => selectSymbol(code));
            container.appendChild(chip);
        });
    }

    // --- 4. 全銘柄シグナル状況ティッカーバー更新 ---
    function updateGlobalSignalTicker() {
        const tickerText = document.getElementById("ticker-status-text");
        const activeContainer = document.getElementById("ticker-active-symbols");
        if (!tickerText || !activeContainer) return;

        activeContainer.innerHTML = "";
        const symKeys = Object.keys(symbolsData.symbols);
        const buySignals = [];

        symKeys.forEach(code => {
            const sym = symbolsData.symbols[code];
            if (!sym || !sym.candles) return;
            const analyzed = (sym.candles.length >= 30) ? strategy.analyzeCandles(sym.candles) : (sym.candles || []);
            const latest = analyzed.length > 0 ? analyzed[analyzed.length - 1] : null;
            const activePos = dataStore.positions ? dataStore.positions.find(p => p.symbol === code) : null;

            if (latest && latest.isBuySignal && !activePos) {
                buySignals.push({ code, info: sym.info, latest, time: latest.time });
            }
        });

        if (buySignals.length > 0) {
            tickerText.innerHTML = `<b style="color: var(--accent-green);">🔔 ${buySignals.length}件の買いシグナルが点灯中！</b> (自動売買エンジン稼働中・100株単元)`;
            buySignals.forEach(item => {
                const btn = document.createElement("button");
                btn.className = "ticker-symbol-quick";
                btn.innerHTML = `🔔 ${item.info.name} (${item.code}) [点灯: ${item.time}] ➔ 表示`;
                btn.addEventListener("click", () => selectSymbol(item.code));
                activeContainer.appendChild(btn);
            });
        } else {
            tickerText.innerHTML = `勝率上位厳選 ${symKeys.length}銘柄をリアルタイム監視中（現在シグナル待機中）`;
        }
    }

    // --- 5. 銘柄選択 & チャート・画面更新 ---
    function selectSymbol(code) {
        currentSymbolCode = code;

        document.querySelectorAll(".symbol-chip").forEach(el => {
            el.classList.toggle("active", el.dataset.code === code);
        });

        const sym = symbolsData.symbols[code];
        if (!sym) return;

        const analyzed = (sym.candles && sym.candles.length >= 30) ? strategy.analyzeCandles(sym.candles) : (sym.candles || []);
        const latest = analyzed.length > 0 ? analyzed[analyzed.length - 1] : { close: 500, isBuySignal: false };
        const activePos = dataStore.positions ? dataStore.positions.find(p => p.symbol === code) : null;

        if (currentChartMode === "equity") {
            chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
        } else {
            chart.render(analyzed, sym.info, activePos);
        }

        updateSignalBanner(sym.info, latest, activePos, sym.metrics);
        updateFundamentalCard(sym.info, sym.metrics);
    }

    // --- チャートタブ切替 ---
    function initChartTabs() {
        const btnCandle = document.getElementById("tab-btn-candle");
        const btnEquity = document.getElementById("tab-btn-equity");
        const subBadge = document.getElementById("chart-sub-badge");

        if (!btnCandle || !btnEquity) return;

        btnCandle.addEventListener("click", () => {
            currentChartMode = "candle";
            btnCandle.className = "btn btn-primary";
            btnEquity.className = "btn btn-secondary";
            if (subBadge) subBadge.innerText = "時間軸: 1h / 損切 -2.5% / 利確 +6%";
            selectSymbol(currentSymbolCode);
        });

        btnEquity.addEventListener("click", () => {
            currentChartMode = "equity";
            btnEquity.className = "btn btn-primary";
            btnCandle.className = "btn btn-secondary";
            if (subBadge) subBadge.innerText = "📈 資産推移・複利成長カーブ (全トレード実績連動)";
            chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
        });
    }

    // --- 6. シグナル通知バナー更新 ---
    function updateSignalBanner(info, latest, activePos, metrics) {
        const banner = document.getElementById("signal-banner");
        if (!banner) return;
        const currentClose = Number(latest.close) || 500;
        const orderCalc = strategy.calculateOrderSize(currentClose, dataStore.cash, dataStore.compoundingEnabled);
        const signalTime = latest.time || (metrics && metrics.latest_signal_time) || "2026-09-18 09:00";
        const winRate = (metrics && metrics.win_rate_pct) ? metrics.win_rate_pct : 68.5;

        if (activePos) {
            // 保有中
            const entryPrice = Number(activePos.entryPrice) || currentClose;
            const posShares = Number(activePos.shares) || 100;
            const pnl = (currentClose - entryPrice) * posShares;
            const pnlPct = entryPrice > 0 ? ((currentClose - entryPrice) / entryPrice) * 100 : 0;
            const colorClass = pnl >= 0 ? "val-green" : "val-red";
            const tpValNum = activePos.takeProfitPrice ? Number(activePos.takeProfitPrice) : (entryPrice * 1.06);
            const slValNum = activePos.stopLossPrice ? Number(activePos.stopLossPrice) : (entryPrice * 0.975);
            const toTp = tpValNum - currentClose;
            const toSl = currentClose - slValNum;
            const entryTimeStr = String(activePos.entryTime || '-');

            banner.className = "signal-alert-banner";
            banner.style.borderColor = pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:4px; flex-wrap:wrap;">
                        <span class="signal-tag" style="background:${pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}; color: #0b0f19; font-weight:700;">
                            💼 ポジション保有中 (自動売買監視中)
                        </span>
                        <span class="chip-badge" style="background:rgba(0,229,255,0.2); color:#00e5ff; border:1px solid #00e5ff;">
                            ⏰ エントリー: ${entryTimeStr}
                        </span>
                        <span class="chip-badge" style="background:rgba(255,255,255,0.1); color:var(--text-muted);">
                            保有バー数: ${activePos.holdingBars || 1} / 15本 (最大3日)
                        </span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - リアルタイム保有状況</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">買値</span><span class="sig-metric-value val-cyan">¥${entryPrice.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">現在値</span><span class="sig-metric-value">¥${currentClose.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">株数 (単元)</span><span class="sig-metric-value">${posShares} 株</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">評価損益 (%)</span><span class="sig-metric-value ${colorClass}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">利確目標 (+6.0%)</span><span class="sig-metric-value val-green">¥${tpValNum.toFixed(1)} (残 ${toTp >= 0 ? '+' : ''}${toTp.toFixed(1)}円)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損切目標 (-2.5%)</span><span class="sig-metric-value val-red">¥${slValNum.toFixed(1)} (幅 ${toSl.toFixed(1)}円)</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-danger" id="btn-manual-exit">🚪 今すぐ手動決済</button>
                </div>
            `;

            const btnManualExit = document.getElementById("btn-manual-exit");
            if (btnManualExit) {
                btnManualExit.addEventListener("click", () => openExitModal(activePos, currentClose));
            }

        } else if (latest.isBuySignal) {
            // 買いシグナル点灯中！
            const tpStr = latest.takeProfitPrice ? Number(latest.takeProfitPrice).toFixed(1) : (currentClose * 1.06).toFixed(1);
            const slStr = latest.stopLossPrice ? Number(latest.stopLossPrice).toFixed(1) : (currentClose * 0.975).toFixed(1);

            banner.className = "signal-alert-banner";
            banner.style.borderColor = "var(--accent-green)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap:wrap;">
                        <span class="signal-tag">🔔 HighWin 買いシグナル点灯中！</span>
                        <span class="chip-badge" style="background: var(--primary); color: #0b0f19; font-weight: 700;">
                            ⏰ 点灯日時: ${signalTime} (1h足確定)
                        </span>
                        <span class="chip-badge" style="background: rgba(0, 230, 118, 0.2); color: var(--accent-green); border: 1px solid var(--accent-green);">
                            勝率 ${winRate}%
                        </span>
                        <span class="chip-badge" style="background: rgba(0, 229, 255, 0.2); color: #00e5ff;">
                            🤖 自動売買: ${dataStore.autoTradingEnabled ? '有効 (自動約定)' : '停止中'}
                        </span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 買いエントリー推奨</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">推奨買値</span><span class="sig-metric-value val-cyan">¥${currentClose.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">推奨株数 (100株単元)</span><span class="sig-metric-value">${orderCalc.note} (¥${orderCalc.investment.toLocaleString()})</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">利確ライン (+6.0%)</span><span class="sig-metric-value val-green">¥${tpStr}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損切ライン (-2.5%)</span><span class="sig-metric-value val-red">¥${slStr}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">リスクリワード比</span><span class="sig-metric-value val-cyan">2.40 : 1</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">最大保有期間</span><span class="sig-metric-value">3営業日 (15バー)</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-primary" id="btn-manual-entry">💡 この銘柄を手動エントリー</button>
                </div>
            `;

            const btnManualEntry = document.getElementById("btn-manual-entry");
            if (btnManualEntry) {
                btnManualEntry.addEventListener("click", () => openEntryModal(info, latest, orderCalc, signalTime));
            }

        } else {
            // シグナル待機中
            const winRateStr = (metrics && metrics.win_rate_pct) ? metrics.win_rate_pct : '68.5';
            const sigTimeStr = (metrics && metrics.latest_signal_time) ? metrics.latest_signal_time : '直近確定';
            const sigTimeAgoStr = (metrics && metrics.latest_signal_time_ago) ? metrics.latest_signal_time_ago : '待機中';
            const ema10Str = latest.ema10 ? Number(latest.ema10).toFixed(1) : '-';
            const ema25Str = latest.ema25 ? Number(latest.ema25).toFixed(1) : '-';
            const rsiStr = latest.rsi ? Number(latest.rsi).toFixed(1) : '-';

            banner.className = "signal-alert-banner";
            banner.style.borderColor = "rgba(255, 255, 255, 0.1)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
                        <span class="signal-tag" style="background:rgba(255,255,255,0.1); color:var(--text-muted)">⏳ シグナル待機中</span>
                        <span style="font-size: 11px; color: var(--text-dim);">直近点灯: ${sigTimeStr} (${sigTimeAgoStr})</span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 監視中 (バックテスト勝率: ${winRateStr}%)</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">現在株価</span><span class="sig-metric-value">¥${currentClose.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">EMA 10 / 25</span><span class="sig-metric-value">¥${ema10Str} / ¥${ema25Str}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">RSI(14)</span><span class="sig-metric-value">${rsiStr}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">単元投資枠 (100株)</span><span class="sig-metric-value">${orderCalc.note} (¥${orderCalc.investment.toLocaleString()})</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-secondary" id="btn-manual-entry-force">手動エントリー (任意)</button>
                </div>
            `;

            const btnForce = document.getElementById("btn-manual-entry-force");
            if (btnForce) {
                btnForce.addEventListener("click", () => openEntryModal(info, latest, orderCalc, signalTime));
            }
        }
    }

    // --- 7. ファンダメンタルズ詳細カード更新 ---
    function updateFundamentalCard(info, metrics) {
        document.getElementById("fund-name").innerText = `${info.name} (${info.code})`;
        document.getElementById("fund-market").innerText = `${info.market} / ${info.sector}`;
        document.getElementById("fund-growth").innerText = info.sales_growth_rate;
        document.getElementById("fund-cap").innerText = info.market_cap_approx;
        document.getElementById("fund-profit").innerText = info.operating_profit;
        document.getElementById("fund-desc").innerText = info.description;

        if (metrics) {
            document.getElementById("backtest-winrate").innerText = `${metrics.win_rate_pct}%`;
            document.getElementById("backtest-pf").innerText = metrics.profit_factor;
            document.getElementById("backtest-pnl").innerText = `${metrics.total_pnl_amount >= 0 ? '+' : ''}¥${metrics.total_pnl_amount.toLocaleString()}`;
            document.getElementById("backtest-dd").innerText = `${metrics.max_drawdown_pct}%`;
        }
    }

    // --- 8. モーダル操作 (手動エントリー & 決済) ---
    function openEntryModal(info, latest, orderCalc, signalTime) {
        const modal = document.getElementById("entry-modal");
        document.getElementById("entry-modal-symbol").innerHTML = `${info.name} (${info.code}) <span class="chip-badge" style="background:var(--primary); color:#0b0f19;">⏰ 点灯: ${signalTime}</span>`;
        document.getElementById("entry-modal-price").value = latest.close;
        document.getElementById("entry-modal-shares").value = orderCalc.shares;
        document.getElementById("entry-modal-invest").innerText = `¥${orderCalc.investment.toLocaleString()} (単元株・100株単位)`;

        modal.classList.add("active");

        document.getElementById("btn-confirm-entry").onclick = async () => {
            const price = parseFloat(document.getElementById("entry-modal-price").value);
            const shares = parseInt(document.getElementById("entry-modal-shares").value);
            
            if (shares % 100 !== 0) {
                alert("⚠️ 単元未満株での購入は避けてください。100株単位で入力してください。");
                return;
            }

            const investment = Math.round(price * shares);
            if (investment > dataStore.cash) {
                alert(`⚠️ 投資資金（買付余力 ¥${Math.round(dataStore.cash).toLocaleString()}）が不足しています。`);
                return;
            }

            const pos = {
                symbol: info.code,
                symbolName: info.name,
                entryTime: signalTime || new Date().toISOString().replace("T", " ").substring(0, 16),
                entryPrice: price,
                shares: shares,
                investmentAmount: investment,
                stopLossPrice: price * (1 - strategy.params.stopLossPct),
                takeProfitPrice: price * (1 + strategy.params.takeProfitPct),
                strategyName: "HighWin_TripleConfluence",
                holdingBars: 0,
                notes: document.getElementById("entry-modal-notes").value
            };

            await dataStore.addPosition(pos);
            modal.classList.remove("active");
            renderSymbolSelector();
            updateGlobalSignalTicker();
            selectSymbol(currentSymbolCode);
            renderPositionsTable();
            renderSummaryKPIs();
        };
    }

    function openExitModal(pos, currentPrice) {
        const modal = document.getElementById("exit-modal");
        const pnl = (currentPrice - pos.entryPrice) * pos.shares;
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        document.getElementById("exit-modal-symbol").innerText = `${pos.symbolName} (${pos.symbol})`;
        document.getElementById("exit-modal-price").value = currentPrice;
        document.getElementById("exit-modal-pnl").innerText = `${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;

        modal.classList.add("active");

        document.getElementById("btn-confirm-exit").onclick = async () => {
            const exitPrice = parseFloat(document.getElementById("exit-modal-price").value);
            const reason = document.getElementById("exit-modal-reason").value;
            const note = document.getElementById("exit-modal-notes").value;
            const tags = document.getElementById("exit-modal-tags").value;

            await dataStore.closePosition(pos.symbol, exitPrice, reason, note, tags);
            modal.classList.remove("active");
            renderSymbolSelector();
            updateGlobalSignalTicker();
            selectSymbol(currentSymbolCode);
            renderPositionsTable();
            renderTradesTable();
            renderSummaryKPIs();
            if (currentChartMode === "equity") {
                chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
            }
        };
    }

    // --- 9. ポジション一覧・履歴・KPI ---
    function renderPositionsTable() {
        const tbody = document.getElementById("positions-table-body");
        tbody.innerHTML = "";

        if (dataStore.positions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:20px;">現在保有中のポジションはありません（リアルタイム監視中）</td></tr>`;
            return;
        }

        dataStore.positions.forEach(pos => {
            const sym = symbolsData.symbols[pos.symbol];
            const currentPrice = sym ? sym.candles[sym.candles.length - 1].close : pos.entryPrice;
            const pnl = (currentPrice - pos.entryPrice) * pos.shares;
            const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
            const colorClass = pnl >= 0 ? "val-green" : "val-red";

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><b>${pos.symbolName}</b> (${pos.symbol})<br><span style="font-size:11px; color:var(--text-dim)">${pos.entryTime}</span></td>
                <td>¥${pos.entryPrice.toLocaleString()}</td>
                <td>¥${currentPrice.toLocaleString()}</td>
                <td>${pos.shares} 株 (単元)</td>
                <td>¥${pos.investmentAmount.toLocaleString()}</td>
                <td class="${colorClass}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</td>
                <td><button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="window.appOpenExit('${pos.symbol}', ${currentPrice})">決済</button></td>
            `;
            tbody.appendChild(tr);
        });
    }

    window.appOpenExit = (symbol, price) => {
        const pos = dataStore.positions.find(p => p.symbol === symbol);
        if (pos) openExitModal(pos, price);
    };

    function renderTradesTable() {
        const tbody = document.getElementById("trades-table-body");
        tbody.innerHTML = "";

        const allTrades = dataStore.trades;
        if (allTrades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:20px;">記録されたトレード履歴はありません</td></tr>`;
            return;
        }

        allTrades.slice(0, 20).forEach(t => {
            const isWin = t.pnl_amount > 0;
            const colorClass = isWin ? "val-green" : "val-red";
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><span style="font-size:11px; color:var(--text-dim)">${t.exit_time}</span><br><b>${t.symbol_name}</b></td>
                <td>¥${t.entry_price.toLocaleString()} → ¥${t.exit_price.toLocaleString()}</td>
                <td>${t.shares} 株 (¥${Math.round(t.investment_amount).toLocaleString()})</td>
                <td class="${colorClass}"><b>${isWin ? '+' : ''}¥${t.pnl_amount.toLocaleString()}</b><br><span style="font-size:11px">${isWin ? '+' : ''}${t.pnl_pct}%</span></td>
                <td><span class="chip-badge">${t.exit_reason}</span></td>
                <td><span style="font-size:12px;">${t.notes || '-'}</span><br><span style="font-size:10px; color:var(--primary);">${t.tags || ''}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function renderSummaryKPIs() {
        // 現在株価マップの構築
        const currentPrices = {};
        if (symbolsData && symbolsData.symbols) {
            Object.keys(symbolsData.symbols).forEach(code => {
                const sym = symbolsData.symbols[code];
                if (sym && sym.candles && sym.candles.length > 0) {
                    currentPrices[code] = sym.candles[sym.candles.length - 1].close;
                } else if (sym && sym.info && sym.info.current_price_approx) {
                    currentPrices[code] = sym.info.current_price_approx;
                }
            });
        }

        const stats = dataStore.getSummaryStats(currentPrices);
        const totalEquity = stats.totalEquity;
        const returnPct = stats.returnPct;

        const elTrades = document.getElementById("kpi-total-trades");
        const elWinLoss = document.getElementById("kpi-win-loss-count");
        const elWinrate = document.getElementById("kpi-winrate");
        const elWinrateSub = document.getElementById("kpi-winrate-sub");
        const elEquity = document.getElementById("kpi-total-equity");
        const elCapitalSub = document.getElementById("kpi-capital-sub");
        const elTotalPnl = document.getElementById("kpi-total-pnl");
        const elPnlSub = document.getElementById("kpi-pnl-sub");
        const elPf = document.getElementById("kpi-pf");

        if (elTrades) elTrades.innerText = `${stats.totalTrades} 回`;
        if (elWinLoss) {
            elWinLoss.innerText = stats.totalTrades > 0 
                ? `${stats.winCount}勝 ${stats.lossCount}敗` 
                : (dataStore.positions.length > 0 ? `保有中: ${dataStore.positions.length}銘柄` : `0勝 0敗`);
        }
        if (elWinrate) {
            elWinrate.innerText = stats.totalTrades > 0 ? `${stats.winRate}%` : `0.0%`;
            elWinrate.className = `kpi-val ${stats.winRate >= 60 ? 'val-green' : (stats.winRate >= 50 ? 'val-yellow' : 'val-muted')}`;
        }
        if (elWinrateSub) {
            elWinrateSub.innerText = stats.totalTrades === 0 
                ? (dataStore.positions.length > 0 ? "保有中 (決済後に勝率集計)" : "トレード待機中 (決済後に集計)")
                : `実トレード実績でリアルタイム更新 (${stats.winCount}勝/${stats.totalTrades}回)`;
        }
        if (elEquity) elEquity.innerText = `¥${totalEquity.toLocaleString()}`;
        if (elCapitalSub) elCapitalSub.innerText = `元本 ¥${dataStore.initialCapital.toLocaleString()} | 複利再投資: ${dataStore.compoundingEnabled ? 'ON' : 'OFF'}`;
        if (elTotalPnl) {
            elTotalPnl.innerText = `${stats.totalPnl >= 0 ? '+' : ''}¥${stats.totalPnl.toLocaleString()} (${returnPct >= 0 ? '+' : ''}${returnPct}%)`;
            elTotalPnl.className = `kpi-val ${stats.totalPnl >= 0 ? 'val-green' : 'val-red'}`;
        }
        if (elPnlSub) {
            if (dataStore.positions.length > 0 && stats.unrealizedPnl !== 0) {
                elPnlSub.innerText = `買付余力: ¥${Math.round(dataStore.cash).toLocaleString()} (含み損益: ${stats.unrealizedPnl >= 0 ? '+' : ''}¥${stats.unrealizedPnl.toLocaleString()})`;
            } else {
                elPnlSub.innerText = `買付可能残高: ¥${Math.round(dataStore.cash).toLocaleString()}`;
            }
        }
        if (elPf) elPf.innerText = stats.totalTrades > 0 ? stats.profitFactor : "0.00";
    }

    // --- 10. 定期自動ポーリング (30秒) & 手動更新ボタン連携 ---
    const btnManualRefresh = document.getElementById("btn-manual-refresh-now");
    if (btnManualRefresh) {
        btnManualRefresh.addEventListener("click", async () => {
            const btnText = document.getElementById("btn-refresh-text");
            btnText.innerText = "相場スクリーニング中...";
            try {
                const res = await fetch("/api/refresh-now", { method: "POST" });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.symbols) {
                        symbolsData = data;
                        renderAllUI();
                        refreshCountdown = 30;
                        btnText.innerText = "今すぐ相場更新";
                        return;
                    }
                }
            } catch (e) {
                console.warn("手動更新エラー:", e);
            }
            await loadData(true);
        });
    }

    // 30秒ごとの自動更新
    setInterval(() => {
        refreshCountdown -= 1;
        const btnText = document.getElementById("btn-refresh-text");
        if (btnText && !isRefreshing) {
            btnText.innerText = refreshCountdown <= 5 ? `更新まで ${refreshCountdown}s` : "今すぐ相場更新";
        }
        if (refreshCountdown <= 0) {
            loadData(false);
            refreshCountdown = 30;
        }
    }, 1000);

    // --- 11. 資金・複利設定モーダル初期化 ---
    function initCapitalSettingsModal() {
        const modal = document.getElementById("capital-modal");
        const btnOpen = document.getElementById("btn-open-capital-settings");
        const inputCap = document.getElementById("input-initial-capital");
        const checkCompound = document.getElementById("check-compounding-enabled");
        const btnSave = document.getElementById("btn-save-capital-settings");
        const btnReset = document.getElementById("btn-reset-trading-data");

        if (!modal || !btnOpen) return;

        btnOpen.addEventListener("click", () => {
            if (inputCap) inputCap.value = dataStore.initialCapital;
            if (checkCompound) checkCompound.checked = dataStore.compoundingEnabled;
            modal.classList.add("active");
        });

        if (btnSave) {
            btnSave.addEventListener("click", async () => {
                const newCap = parseFloat(inputCap.value) || 300000;
                const newCompound = checkCompound.checked;

                await dataStore.updateAccountSettings(newCap, newCompound, false);
                modal.classList.remove("active");
                renderAllUI();
                if (currentChartMode === "equity") {
                    chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
                }
                alert("💾 資金・複利設定を保存・反映しました！");
            });
        }

        if (btnReset) {
            btnReset.addEventListener("click", async () => {
                if (confirm("⚠️ 本当にこれまでの取引実績・損益・資産推移履歴をリセットして元本に戻しますか？\n（サーバーDBも初期化されます）")) {
                    const currentCap = parseFloat(inputCap.value) || dataStore.initialCapital;
                    await dataStore.updateAccountSettings(currentCap, checkCompound.checked, true);
                    modal.classList.remove("active");
                    renderAllUI();
                    if (currentChartMode === "equity") {
                        chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
                    }
                    alert("🔄 取引実績・資産履歴をリセットしました。");
                }
            });
        }
    }

    // --- 12. 通知設定モーダル初期化 ---
    function initNotifySettingsModal() {
        const modal = document.getElementById("notify-settings-modal");
        const btnOpen = document.getElementById("btn-open-notify-settings");
        if (!modal || !btnOpen) return;

        btnOpen.addEventListener("click", () => {
            const s = notifier.settings;
            document.getElementById("notify-browser-enabled").checked = s.browser.enabled;
            document.getElementById("notify-discord-enabled").checked = s.chat.discordEnabled;
            document.getElementById("notify-discord-url").value = s.chat.discordWebhook || "";
            document.getElementById("notify-slack-enabled").checked = s.chat.slackEnabled;
            document.getElementById("notify-slack-url").value = s.chat.slackWebhook || "";
            
            document.getElementById("notify-email-enabled").checked = s.email.enabled;
            document.getElementById("notify-email-to").value = s.email.toEmail || "";
            document.getElementById("notify-smtp-host").value = s.email.smtpHost || "smtp.gmail.com";
            document.getElementById("notify-smtp-port").value = s.email.smtpPort || 587;
            document.getElementById("notify-smtp-user").value = s.email.smtpUser || "";
            document.getElementById("notify-smtp-pass").value = s.email.smtpPass || "";

            document.getElementById("event-buy-signal").checked = s.events.buySignal;
            document.getElementById("event-take-profit").checked = s.events.takeProfit;
            document.getElementById("event-stop-loss").checked = s.events.stopLoss;
            document.getElementById("event-timeout").checked = s.events.holdingTimeout;

            modal.classList.add("active");
        });

        modal.querySelectorAll(".tab-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                modal.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
                modal.querySelectorAll(".notify-tab-pane").forEach(p => p.style.display = "none");
                btn.classList.add("active");
                const targetId = btn.dataset.tab;
                const targetPane = document.getElementById(targetId);
                if (targetPane) targetPane.style.display = "block";
            });
        });

        document.getElementById("btn-request-browser-perm").addEventListener("click", async () => {
            const granted = await notifier.requestBrowserPermission();
            alert(granted ? "✅ ブラウザ通知の権限が許可されました！" : "❌ ブラウザ通知の権限が拒否されました。");
        });

        document.getElementById("btn-test-browser").addEventListener("click", async () => {
            const res = await notifier.testNotification("browser");
            alert(res.message);
        });

        document.getElementById("btn-test-discord").addEventListener("click", async () => {
            notifier.settings.chat.discordEnabled = true;
            notifier.settings.chat.discordWebhook = document.getElementById("notify-discord-url").value;
            const res = await notifier.testNotification("discord");
            alert(res.success ? "✅ Discord テスト通知を送信しました！" : `❌ Discord 送信エラー: ${res.message || res.error}`);
        });

        document.getElementById("btn-test-slack").addEventListener("click", async () => {
            notifier.settings.chat.slackEnabled = true;
            notifier.settings.chat.slackWebhook = document.getElementById("notify-slack-url").value;
            const res = await notifier.testNotification("slack");
            alert(res.success ? "✅ Slack テスト通知を送信しました！" : `❌ Slack 送信エラー: ${res.message || res.error}`);
        });

        document.getElementById("btn-test-email").addEventListener("click", async () => {
            notifier.settings.email = {
                enabled: true,
                toEmail: document.getElementById("notify-email-to").value,
                smtpHost: document.getElementById("notify-smtp-host").value,
                smtpPort: parseInt(document.getElementById("notify-smtp-port").value),
                smtpUser: document.getElementById("notify-smtp-user").value,
                smtpPass: document.getElementById("notify-smtp-pass").value
            };
            const res = await notifier.testNotification("email");
            alert(res.success ? `✅ ${res.message}` : `❌ メール送信エラー: ${res.message}`);
        });

        document.getElementById("btn-save-notify-settings").addEventListener("click", () => {
            const newSettings = {
                browser: {
                    enabled: document.getElementById("notify-browser-enabled").checked,
                    sound: true
                },
                chat: {
                    discordEnabled: document.getElementById("notify-discord-enabled").checked,
                    discordWebhook: document.getElementById("notify-discord-url").value.trim(),
                    slackEnabled: document.getElementById("notify-slack-enabled").checked,
                    slackWebhook: document.getElementById("notify-slack-url").value.trim(),
                    lineEnabled: false,
                    lineToken: ""
                },
                email: {
                    enabled: document.getElementById("notify-email-enabled").checked,
                    toEmail: document.getElementById("notify-email-to").value.trim(),
                    smtpHost: document.getElementById("notify-smtp-host").value.trim(),
                    smtpPort: parseInt(document.getElementById("notify-smtp-port").value) || 587,
                    smtpUser: document.getElementById("notify-smtp-user").value.trim(),
                    smtpPass: document.getElementById("notify-smtp-pass").value.trim()
                },
                events: {
                    buySignal: document.getElementById("event-buy-signal").checked,
                    takeProfit: document.getElementById("event-take-profit").checked,
                    stopLoss: document.getElementById("event-stop-loss").checked,
                    holdingTimeout: document.getElementById("event-timeout").checked
                }
            };

            notifier.saveSettings(newSettings);
            modal.classList.remove("active");
            alert("💾 通知設定を正常に保存しました！");
        });
    }

    document.querySelectorAll(".modal-close-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".modal-overlay").forEach(m => m.classList.remove("active"));
        });
    });

    function createMockSymbolsData() {
        return {
            symbols: {
                "4436.T": {
                    info: { code: "4436.T", name: "ミンカブ", market: "東証グロース", sector: "情報・通信", sales_growth_rate: "+21.0%", market_cap_approx: "75億円", operating_profit: "メディア収益", description: "金融メディアプラットフォーム", lot_investment_approx: 41700 },
                    candles: generateMockCandles(417, 300),
                    metrics: { win_rate_pct: 68.5, profit_factor: 2.15, total_pnl_amount: 14200, max_drawdown_pct: 2.3, latest_signal_time: "2026-09-14 12:00", latest_signal_time_ago: "点灯中", is_signal_active: true }
                }
            }
        };
    }

    function generateMockCandles(basePrice, count) {
        const arr = [];
        let p = basePrice;
        const now = new Date();
        for (let i = count; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 3600 * 1000);
            const change = (Math.random() - 0.48) * 4;
            p = Math.max(100, p + change);
            arr.push({
                time: d.toISOString().replace("T", " ").substring(0, 16),
                open: p, high: p + Math.random() * 3, low: p - Math.random() * 3, close: p + (Math.random() - 0.5) * 2, volume: Math.floor(Math.random() * 50000), signal: (i === 1 ? 1 : 0)
            });
        }
        return arr;
    }

    // 自動売買トグルボタンのイベントハンドラ
    const btnToggleAutoTrade = document.getElementById("btn-toggle-autotrade");
    if (btnToggleAutoTrade) {
        btnToggleAutoTrade.addEventListener("click", () => {
            const nextState = !dataStore.autoTradingEnabled;
            dataStore.saveAutoTradingEnabled(nextState);
            updateAutoTradeButtonUI();
            renderAllUI();
            alert(nextState ? "🤖 自動売買モードを【有効 (ON)】に設定しました。\n買いシグナル検知時に自動エントリーし、利確(+6%)/損切(-2.5%)/期限切れ(15本)を自動決済します。" : "⏸️ 自動売買モードを【停止 (OFF)】に設定しました。\n手動承認モードになります。");
        });
    }

    // 初期化と起動
    initChartTabs();
    initCapitalSettingsModal();
    initNotifySettingsModal();
    loadData(true);
});
