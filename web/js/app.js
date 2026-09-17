/**
 * メインアプリケーションロジック (web/js/app.js)
 * - リアルタイム相場監視 & オートスクリーニング（30秒自動ポーリング / 手動即時更新）
 * - 東証取引時間帯（開場/閉場）自動ステータス判定
 * - 勝率65%以上・100株単元<=10万円の動的トップ5〜10銘柄リバランス
 * - シグナル点灯日時の明示 & マルチチャネル自動通知
 */

document.addEventListener("DOMContentLoaded", async () => {
    const dataStore = new DataStore();
    const strategy = new TripleConfluenceStrategy();
    const notifier = new NotificationManager();
    const chart = new TradingChart("main-chart-container");

    let symbolsData = null;
    let currentSymbolCode = "4436.T"; // 初期選択
    let refreshCountdown = 30;
    let isRefreshing = false;

    function renderAllUI() {
        if (!symbolsData || !symbolsData.symbols) return;

        // 初期選択銘柄の調整（選択中の銘柄が存在しない場合は先頭銘柄）
        const keys = Object.keys(symbolsData.symbols);
        if (keys.length > 0 && (!currentSymbolCode || !symbolsData.symbols[currentSymbolCode])) {
            currentSymbolCode = keys[0];
        }

        updateMarketStatusHeader();
        renderSymbolSelector();
        updateGlobalSignalTicker();
        selectSymbol(currentSymbolCode);
        renderPositionsTable();
        renderTradesTable();
        renderSummaryKPIs();
    }

    // --- 1. データロード (API優先 / 静的JSONフォールバック) ---
    async function loadData(showLoadingIndicator = false) {
        if (isRefreshing && !showLoadingIndicator) return;
        isRefreshing = true;

        const btnRefreshText = document.getElementById("btn-refresh-text");
        if (btnRefreshText && showLoadingIndicator) {
            btnRefreshText.innerText = "相場データ取得中...";
        }

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
        container.innerHTML = "";

        const symKeys = Object.keys(symbolsData.symbols);
        symKeys.forEach(code => {
            const sym = symbolsData.symbols[code];
            const info = sym.info;
            const metrics = sym.metrics;
            
            const analyzed = strategy.analyzeCandles(sym.candles);
            const latest = analyzed[analyzed.length - 1];
            const activePos = dataStore.positions.find(p => p.symbol === code);
            const isBuyActive = latest ? latest.isBuySignal : false;

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

            let statusBadgeHtml = "";
            if (activePos) {
                statusBadgeHtml = `<span class="badge-status badge-holding">💼 保有中</span>`;
            } else if (isBuyActive) {
                statusBadgeHtml = `<span class="badge-status badge-buy">🔔 BUY点灯中</span>`;
            } else {
                statusBadgeHtml = `<span class="badge-status badge-wait">⏳ 待機中</span>`;
            }

            const currentPrice = latest ? latest.close : (info.current_price_approx || 500);
            const orderCalc = strategy.calculateOrderSize(currentPrice);

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
                <div class="chip-growth" style="font-size: 12px; color: var(--text-muted);">
                    株価 ¥${currentPrice.toLocaleString()} | ${orderCalc.note}
                </div>
                <div style="font-size: 11px; color: var(--primary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                    ⏰ 点灯日時: ${lastSignalTimeStr}
                </div>
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
            const analyzed = strategy.analyzeCandles(sym.candles);
            const latest = analyzed[analyzed.length - 1];
            const activePos = dataStore.positions.find(p => p.symbol === code);

            if (latest && latest.isBuySignal && !activePos) {
                buySignals.push({ code, info: sym.info, latest, time: latest.time });
            }
        });

        if (buySignals.length > 0) {
            tickerText.innerHTML = `<b style="color: var(--accent-green);">🔔 ${buySignals.length}件の買いシグナルが点灯中！</b> (勝率65%以上・100株単元厳守)`;
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

    // --- 5. 銘柄選択 & 画面更新 ---
    function selectSymbol(code) {
        currentSymbolCode = code;

        document.querySelectorAll(".symbol-chip").forEach(el => {
            el.classList.toggle("active", el.dataset.code === code);
        });

        const sym = symbolsData.symbols[code];
        if (!sym) return;

        const analyzed = strategy.analyzeCandles(sym.candles);
        const latest = analyzed[analyzed.length - 1];
        const activePos = dataStore.positions.find(p => p.symbol === code);

        chart.render(analyzed, sym.info, activePos);
        updateSignalBanner(sym.info, latest, activePos, sym.metrics);
        updateFundamentalCard(sym.info, sym.metrics);
    }

    // --- 6. シグナル通知バナー更新 ---
    function updateSignalBanner(info, latest, activePos, metrics) {
        const banner = document.getElementById("signal-banner");
        const orderCalc = strategy.calculateOrderSize(latest.close);
        const signalTime = latest.time || metrics.latest_signal_time || "2026-09-15 09:00";

        if (activePos) {
            // 保有中
            const pnl = (latest.close - activePos.entryPrice) * activePos.shares;
            const pnlPct = ((latest.close - activePos.entryPrice) / activePos.entryPrice) * 100;
            const colorClass = pnl >= 0 ? "val-green" : "val-red";

            banner.className = "signal-alert-banner";
            banner.style.borderColor = pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <span class="signal-tag" style="background:${pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}; color: #0b0f19;">
                        💼 ポジション保有中 (${info.name})
                    </span>
                    <div class="signal-title">${info.name} (${info.code}) - 保有中 (エントリー日時: ${activePos.entryTime})</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">買値</span><span class="sig-metric-value">¥${activePos.entryPrice.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">現在値</span><span class="sig-metric-value">¥${latest.close.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">株数 (単元)</span><span class="sig-metric-value">${activePos.shares} 株 (100株単位)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損益額 (%)</span><span class="sig-metric-value ${colorClass}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">利確目標 (+6%)</span><span class="sig-metric-value val-green">¥${activePos.takeProfitPrice.toFixed(1)}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損切目標 (-2.5%)</span><span class="sig-metric-value val-red">¥${activePos.stopLossPrice.toFixed(1)}</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-danger" id="btn-manual-exit">🚪 手動決済する</button>
                </div>
            `;

            document.getElementById("btn-manual-exit").addEventListener("click", () => openExitModal(activePos, latest.close));

        } else if (latest.isBuySignal) {
            // 買いシグナル点灯中！
            banner.className = "signal-alert-banner";
            banner.style.borderColor = "var(--accent-green)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
                        <span class="signal-tag">🔔 HighWin 買いシグナル点灯中！</span>
                        <span class="chip-badge" style="background: var(--primary); color: #0b0f19; font-weight: 700;">
                            ⏰ 点灯日時: ${signalTime} (1h足確定)
                        </span>
                        <span class="chip-badge" style="background: rgba(0, 230, 118, 0.2); color: var(--accent-green); border: 1px solid var(--accent-green);">
                            勝率 ${metrics.win_rate_pct}%
                        </span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 買いエントリー推奨</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">推奨買値</span><span class="sig-metric-value val-cyan">¥${latest.close.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">推奨株数 (100株単元)</span><span class="sig-metric-value">${orderCalc.note} (¥${orderCalc.investment.toLocaleString()})</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">利確ライン (+6.0%)</span><span class="sig-metric-value val-green">¥${latest.takeProfitPrice.toFixed(1)}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損切ライン (-2.5%)</span><span class="sig-metric-value val-red">¥${latest.stopLossPrice.toFixed(1)}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">リスクリワード比</span><span class="sig-metric-value val-cyan">2.40 : 1</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">最大保有期間</span><span class="sig-metric-value">3営業日 (15バー)</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-primary" id="btn-manual-entry">💡 この銘柄を手動エントリー</button>
                </div>
            `;

            document.getElementById("btn-manual-entry").addEventListener("click", () => openEntryModal(info, latest, orderCalc, signalTime));

        } else {
            // シグナル待機中
            banner.className = "signal-alert-banner";
            banner.style.borderColor = "rgba(255, 255, 255, 0.1)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
                        <span class="signal-tag" style="background:rgba(255,255,255,0.1); color:var(--text-muted)">⏳ シグナル待機中</span>
                        <span style="font-size: 11px; color: var(--text-dim);">直近点灯: ${metrics.latest_signal_time} (${metrics.latest_signal_time_ago})</span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 監視中 (バックテスト勝率: ${metrics.win_rate_pct}%)</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">現在株価</span><span class="sig-metric-value">¥${latest.close.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">EMA 10 / 25</span><span class="sig-metric-value">¥${latest.ema10.toFixed(1)} / ¥${latest.ema25.toFixed(1)}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">RSI(14)</span><span class="sig-metric-value">${latest.rsi.toFixed(1)}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">単元投資枠 (100株)</span><span class="sig-metric-value">${orderCalc.note} (¥${orderCalc.investment.toLocaleString()})</span></div>
                    </div>
                </div>
                <div class="signal-actions">
                    <button class="btn btn-secondary" id="btn-manual-entry-force">手動エントリー (任意)</button>
                </div>
            `;

            document.getElementById("btn-manual-entry-force").addEventListener("click", () => openEntryModal(info, latest, orderCalc, signalTime));
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

        document.getElementById("btn-confirm-entry").onclick = () => {
            const price = parseFloat(document.getElementById("entry-modal-price").value);
            const shares = parseInt(document.getElementById("entry-modal-shares").value);
            
            if (shares % 100 !== 0) {
                alert("⚠️ 単元未満株での購入は避けてください。100株単位で入力してください。");
                return;
            }

            const investment = Math.round(price * shares);
            if (investment > 100000) {
                alert("⚠️ 1回の投資上限は10万円以下です。");
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

            dataStore.addPosition(pos);
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

        document.getElementById("btn-confirm-exit").onclick = () => {
            const exitPrice = parseFloat(document.getElementById("exit-modal-price").value);
            const reason = document.getElementById("exit-modal-reason").value;
            const note = document.getElementById("exit-modal-notes").value;
            const tags = document.getElementById("exit-modal-tags").value;

            dataStore.closePosition(pos.symbol, exitPrice, reason, note, tags);
            modal.classList.remove("active");
            renderSymbolSelector();
            updateGlobalSignalTicker();
            selectSymbol(currentSymbolCode);
            renderPositionsTable();
            renderTradesTable();
            renderSummaryKPIs();
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
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:20px;">記録されたトレード履歴はありません</td></tr>`;
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
        const stats = dataStore.getSummaryStats();
        document.getElementById("kpi-total-trades").innerText = `${stats.totalTrades} 回`;
        document.getElementById("kpi-winrate").innerText = `${stats.winRate}%`;
        document.getElementById("kpi-total-pnl").innerText = `${stats.totalPnl >= 0 ? '+' : ''}¥${stats.totalPnl.toLocaleString()}`;
        document.getElementById("kpi-pf").innerText = stats.profitFactor;
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

    // --- 11. 通知設定モーダル初期化 ---
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

    // 初回ロード
    loadData(true);
    initNotifySettingsModal();
});
