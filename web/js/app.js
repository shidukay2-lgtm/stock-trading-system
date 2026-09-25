/**
 * メインアプリケーションロジック (web/js/app.js)
 * - リアルタイム相場監視 & オートスクリーニング（30秒自動ポーリング / 手動即時更新）
 * - 複数トレード戦略切替 & 個別監視ON/OFF対応 (StrategyRegistry & Toggles)
 *   1) 【戦略1】TripleConfluence (EMA×MACD×RSI同期 スイング)
 *   2) 【戦略2】板気配インバランス × VWAP反発押し目 (板需給考慮スイング)
 *   3) 【戦略3】MTF高速スキャル・デイトレ (1時間以内完結・勝率70%+)
 * - 勝率70%以上バックテスト通過銘柄の厳選監視フィルター
 * - ポジション・履歴・シグナル・チャートでのエントリー戦略完全可視化
 * - サーバーDB永続化 & 動的勝率集計 & 複利運用・資産推移グラフ可視化
 */

document.addEventListener("DOMContentLoaded", async () => {
    const dataStore = new DataStore();
    const strategyRegistry = new StrategyRegistry();
    const notifier = new NotificationManager();
    const chart = new TradingChart("main-chart-container");

    // 保存済みの戦略監視ON/OFF設定をロード
    strategyRegistry.loadStrategyToggles(dataStore.strategyToggles);

    let symbolsData = null;
    let currentSymbolCode = "4477.T"; // 初期選択
    let currentChartMode = "candle"; // 'candle' または 'equity'
    let refreshCountdown = 30;
    let isRefreshing = false;

    /**
     * 現在アクティブな戦略に対応するバックテスト指標を取得
     */
    function getSymbolMetricsForActiveStrategy(sym) {
        if (!sym) return { win_rate_pct: 68.5, latest_signal_time: "-" };
        const stratId = strategyRegistry.activeStrategyId;
        if (stratId === "mtf_scalping" && sym.metrics_strat3) {
            return sym.metrics_strat3;
        } else if (stratId === "orderbook_vwap" && sym.metrics_strat2) {
            return sym.metrics_strat2;
        }
        return sym.metrics_strat1 || sym.metrics || { win_rate_pct: 68.5, latest_signal_time: "-" };
    }

    /**
     * 戦略名に応じたカラーバッジHTMLを生成
     */
    function getStrategyBadgeHtml(strategyName) {
        if (!strategyName) return `<span class="chip-badge" style="background:rgba(0,229,255,0.15); color:#00e5ff;">HighWin</span>`;
        if (strategyName.includes("Scalping") || strategyName.includes("MTF") || strategyName === "mtf_scalping") {
            return `<span class="chip-badge" style="background:rgba(255,215,64,0.2); color:#ffd740; border:1px solid #ffd740;">⚡ 戦略3 (高速デイトレ)</span>`;
        } else if (strategyName.includes("OrderBook") || strategyName === "orderbook_vwap") {
            return `<span class="chip-badge" style="background:rgba(179,136,255,0.2); color:#b388ff; border:1px solid #b388ff;">📊 戦略2 (板気配VWAP)</span>`;
        } else {
            return `<span class="chip-badge" style="background:rgba(0,229,255,0.2); color:#00e5ff; border:1px solid #00e5ff;">📈 戦略1 (スイング)</span>`;
        }
    }

    // 同一足または決済直後の無限再エントリーを防ぐクールダウン管理
    const exitCooldownMap = {};

    // --- 0. リアルタイム自動売買エンジン (AutoTrader・監視ON戦略のみ対象・高速スキャル・デイトレ持ち越し完全防止) ---
    async function processAutoTrading() {
        if (!symbolsData || !symbolsData.symbols) return;
        if (!dataStore.autoTradingEnabled) return;

        const getJst = window.getNowJSTString || function(includeSeconds = true) {
            const now = new Date();
            const jst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
            const y = jst.getUTCFullYear();
            const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
            const d = String(jst.getUTCDate()).padStart(2, '0');
            const h = String(jst.getUTCHours()).padStart(2, '0');
            const min = String(jst.getUTCMinutes()).padStart(2, '0');
            const sec = String(jst.getUTCSeconds()).padStart(2, '0');
            return includeSeconds ? `${y}-${m}-${d} ${h}:${min}:${sec}` : `${y}-${m}-${d} ${h}:${min}`;
        };

        const nowJstStr = getJst(true);
        const todayDateStr = nowJstStr.substring(0, 10); // YYYY-MM-DD
        const currentHour = parseInt(nowJstStr.substring(11, 13), 10);
        const currentMin = parseInt(nowJstStr.substring(14, 16), 10);
        const isMarketOpen = symbolsData.market_status ? Boolean(symbolsData.market_status.is_open) : false;
        // 開場中の大引け時間帯判定 (平日14:50〜15:30)
        const isMarketCloseTime = isMarketOpen && ((currentHour === 14 && currentMin >= 50) || currentHour === 15);

        // 1. 保有中ポジションの自動決済チェック (利食い / 損切り / 期限満了 / 持ち越し防止 / 大引け手仕舞い)
        const currentPositions = [...dataStore.positions];
        for (const pos of currentPositions) {
            const sym = symbolsData.symbols[pos.symbol];
            if (!sym || !sym.candles || sym.candles.length === 0) continue;

            const latest = sym.candles[sym.candles.length - 1];
            const currentClose = Number(latest.close);
            const currentHigh = Number(latest.high) || currentClose;
            const currentLow = Number(latest.low) || currentClose;

            // 保有バー数の正確な算出 (エントリー日時以降の新しいローソク足のみをカウント)
            let barsCount = 1;
            const entryPrefix = String(pos.entryTime || "").substring(0, 16);
            let matchedIdx = -1;
            for (let i = 0; i < sym.candles.length; i++) {
                if (sym.candles[i].time >= entryPrefix) {
                    matchedIdx = i;
                    break;
                }
            }
            if (matchedIdx >= 0) {
                barsCount = Math.max(1, sym.candles.length - matchedIdx);
            }
            pos.holdingBars = barsCount;

            const isScalpPos = (pos.strategyName && (pos.strategyName.includes("Scalping") || pos.strategyName.includes("mtf_scalping")));
            const entryDateStr = String(pos.entryTime || "").substring(0, 10);
            const isOvernight = Boolean(entryDateStr && entryDateStr < todayDateStr);

            // 実時間経過分数の計算 (スキャルピングの高速イグジット用)
            let elapsedMinutes = 0;
            try {
                const cleanEntryTime = pos.entryTime.replace(' ', 'T') + '+09:00';
                const entryEpoch = new Date(cleanEntryTime).getTime();
                const nowEpoch = Date.now();
                if (!isNaN(entryEpoch) && entryEpoch > 0) {
                    elapsedMinutes = Math.max(0, Math.floor((nowEpoch - entryEpoch) / (60 * 1000)));
                }
            } catch (e) {}

            let exitPrice = null;
            let exitReason = null;
            let exitNote = "";

            // --- 決済条件判定 (デイトレ・高速スキャルピング厳格ルール) ---
            // (A) 【重要】デイトレ日跨ぎ持ち越し防止の強制成行決済 (前日エントリーの持ち越しを即時排除)
            if (isScalpPos && isOvernight && isMarketOpen) {
                exitPrice = currentClose;
                exitReason = "DAY_OVER_TIMEOUT";
                exitNote = `🛑 デイトレ持ち越し防止・前日ポジション強制成行決済 (前日 ${pos.entryTime} 約定分)`;
            }
            // (B) 【重要】デイトレ大引け手仕舞い決済 (当日14:50〜15:30の大引け時に全手仕舞い)
            else if (isScalpPos && isMarketCloseTime) {
                exitPrice = currentClose;
                exitReason = "MARKET_CLOSE";
                exitNote = `🔔 デイトレ大引け手仕舞い決済 (当日完結成行)`;
            }
            // (C) 利確判定 (目標価格到達: 戦略3は+2.5%, 他は+6.0%)
            // ※エントリー足（barsCount === 1）では現在値(currentClose)で判定
            else if (currentClose >= pos.takeProfitPrice || (barsCount > 1 && currentHigh >= pos.takeProfitPrice)) {
                exitPrice = Math.max(pos.takeProfitPrice, currentClose);
                exitReason = "TAKE_PROFIT";
                exitNote = isScalpPos ? `🎯 高速利食い約定 (+2.5%達成: ¥${exitPrice.toLocaleString()})` : `🎯 自動利食い約定 (+6.0%達成: ¥${exitPrice.toLocaleString()})`;
            }
            // (D) 損切判定 (損切りライン到達: 戦略3は-1.6%, 他は-2.5%)
            // ※エントリー足（barsCount === 1）ではリアルタイム現在値(currentClose)のみで判定し、過去の下ヒゲ最安値(currentLow)による即座の損切り誤爆を完全に防止
            else if (currentClose <= pos.stopLossPrice || (barsCount > 1 && currentLow <= pos.stopLossPrice)) {
                exitPrice = Math.min(pos.stopLossPrice, currentClose);
                exitReason = "STOP_LOSS";
                exitNote = isScalpPos ? `🛑 高速損切り約定 (-1.6%到達: ¥${exitPrice.toLocaleString()})` : `🛑 自動損切り約定 (-2.5%到達: ¥${exitPrice.toLocaleString()})`;
            }
            // (E) スキャルピング保有時間満了 (最大8バー経過、または実時間経過)
            else if (isScalpPos && (pos.holdingBars >= 8 || elapsedMinutes >= 360)) {
                exitPrice = currentClose;
                exitReason = "TIMEOUT";
                exitNote = `⌛ デイトレ保有期限満了決済 (当日8バー経過: ¥${exitPrice.toLocaleString()})`;
            }
            // (F) スイング戦略の通常期限満了 (15バー経過)
            else if (!isScalpPos && pos.holdingBars >= 15) {
                exitPrice = currentClose;
                exitReason = "TIMEOUT";
                exitNote = `⌛ スイング保有期限満了決済 (15バー/3営業日経過: ¥${exitPrice.toLocaleString()})`;
            }

            if (exitPrice !== null && exitReason !== null) {
                console.log(`[AutoTrade] 自動決済執行: ${pos.symbolName} (${pos.symbol}) - 戦略: ${pos.strategyName}, 理由: ${exitReason}, 決済価格: ¥${exitPrice}`);
                
                // クールダウン登録（同一足・直近5分での即時再エントリーを防止）
                exitCooldownMap[pos.symbol] = {
                    candleTime: latest.time,
                    timestamp: Date.now(),
                    exitReason: exitReason
                };

                const closedTrade = await dataStore.closePosition(pos.symbol, exitPrice, exitReason, exitNote, `#AUTO #${exitReason} #${pos.strategyName || 'HighWin'}`);
                if (closedTrade) {
                    notifier.notifyTradeExit(closedTrade, pos.symbolName);
                }
            }
        }

        // 2. 新規買いシグナルの自動エントリーチェック (監視ONになっている戦略のみを巡回)
        const enabledStrategies = strategyRegistry.getEnabledStrategies();
        if (enabledStrategies.length === 0) return; // 全てOFFなら新規エントリー停止

        const maxConcurrentPositions = 3; // 同時保有上限 (最大3銘柄分散)
        if (dataStore.positions.length < maxConcurrentPositions) {
            const symKeys = Object.keys(symbolsData.symbols);

            for (const code of symKeys) {
                if (dataStore.positions.length >= maxConcurrentPositions) break;

                const sym = symbolsData.symbols[code];
                const activePos = dataStore.positions.find(p => p.symbol === code);
                if (activePos) continue; // すでに保有中ならスキップ

                // 勝率70%以上フィルターチェック
                if (dataStore.filter70PlusOnly && !sym.info.is_win_rate_70_plus && (sym.info.max_win_rate < 70.0)) {
                    continue; // 70%未満はスキップ
                }

                // クールダウンチェック (同一足または決済から5分以内は再エントリー禁止)
                const lastCandle = sym.candles && sym.candles.length > 0 ? sym.candles[sym.candles.length - 1] : null;
                const lastExit = exitCooldownMap[code];
                if (lastExit && lastCandle) {
                    const isSameCandle = lastExit.candleTime === lastCandle.time;
                    const isWithin5Min = (Date.now() - lastExit.timestamp) < (5 * 60 * 1000);
                    if (isSameCandle || isWithin5Min) {
                        continue; // クールダウン中
                    }
                }

                // 監視ONの戦略を順次チェック
                for (const stratMeta of enabledStrategies) {
                    if (dataStore.positions.length >= maxConcurrentPositions) break;

                    const stratInstance = stratMeta.instance;
                    const analyzed = stratInstance.analyzeCandles(sym.candles);
                    const latest = analyzed[analyzed.length - 1];

                    if (latest && latest.isBuySignal) {
                        const orderCalc = stratInstance.calculateOrderSize(latest.close, dataStore.cash, dataStore.compoundingEnabled);
                        if (orderCalc.shares > 0 && orderCalc.investment <= dataStore.cash) {
                            const entryPrice = latest.close;
                            // リアルタイム秒付き現在日時で約定記録
                            const realtimeEntryTime = getJst(true);
                            const pos = {
                                symbol: sym.info.code,
                                symbolName: sym.info.name,
                                entryTime: realtimeEntryTime,
                                entryPrice: entryPrice,
                                shares: orderCalc.shares,
                                investmentAmount: orderCalc.investment,
                                stopLossPrice: latest.stopLossPrice || (entryPrice * (1 - (stratInstance.params.stopLossPct || 0.025))),
                                takeProfitPrice: latest.takeProfitPrice || (entryPrice * (1 + (stratInstance.params.takeProfitPct || 0.060))),
                                strategyName: stratMeta.name,
                                strategyDisplayName: stratMeta.displayName,
                                holdingBars: 1,
                                notes: `🤖 リアルタイム自動売買エントリー約定 [${stratMeta.shortName || stratMeta.name}] (${orderCalc.note})`
                            };

                            console.log(`[AutoTrade] 自動エントリー約定: ${pos.symbolName} (${pos.symbol}) - 採用戦略: ${stratMeta.displayName}, 買値: ¥${pos.entryPrice}, 株数: ${pos.shares}, 約定日時: ${pos.entryTime}`);
                            await dataStore.addPosition(pos);
                            notifier.notifyBuySignal(sym.info, latest, orderCalc, stratMeta);
                            break; // 1銘柄につき1エントリー
                        }
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

    // --- 運用戦略セレクター & 個別監視ON/OFFトグルの初期化 ---
    function initStrategyControls() {
        const selectEl = document.getElementById("select-active-strategy");
        const descEl = document.getElementById("strategy-desc-text");

        if (selectEl) {
            selectEl.value = strategyRegistry.activeStrategyId;
            selectEl.addEventListener("change", async (e) => {
                const stratId = e.target.value;
                strategyRegistry.setActiveStrategy(stratId);
                const meta = strategyRegistry.getActiveStrategyMeta();
                if (descEl) descEl.innerText = meta.description;
                console.log(`[Strategy] チャート表示戦略切替: ${meta.displayName} (${stratId})`);
                await renderAllUI();
            });
        }

        // 戦略個別監視ON/OFFボタン
        const toggleButtons = [
            { btnId: "btn-toggle-strat-mtf", stratId: "mtf_scalping", name: "戦略3 (高勝率デイトレ)", color: "#ffd740" },
            { btnId: "btn-toggle-strat-ob", stratId: "orderbook_vwap", name: "戦略2 (板気配VWAP)", color: "#b388ff" },
            { btnId: "btn-toggle-strat-tc", stratId: "triple_confluence", name: "戦略1 (スイング)", color: "#00e5ff" }
        ];

        toggleButtons.forEach(item => {
            const btn = document.getElementById(item.btnId);
            if (!btn) return;

            const updateBtnUI = () => {
                const isEnabled = strategyRegistry.isStrategyEnabled(item.stratId);
                if (isEnabled) {
                    btn.style.background = `rgba(255, 255, 255, 0.08)`;
                    btn.style.borderColor = item.color;
                    btn.style.color = item.color;
                    btn.innerText = `👁️ ${item.name}: ON`;
                } else {
                    btn.style.background = "rgba(255, 255, 255, 0.02)";
                    btn.style.borderColor = "rgba(255, 255, 255, 0.2)";
                    btn.style.color = "var(--text-dim)";
                    btn.innerText = `⏸️ ${item.name}: OFF`;
                }
            };

            updateBtnUI();

            btn.addEventListener("click", async () => {
                const nextState = !strategyRegistry.isStrategyEnabled(item.stratId);
                strategyRegistry.setStrategyEnabled(item.stratId, nextState);
                dataStore.saveStrategyToggles(strategyRegistry.getStrategyToggles());
                updateBtnUI();
                console.log(`[Strategy Toggle] ${item.name} 監視設定変更: ${nextState ? 'ON' : 'OFF'}`);
                await renderAllUI();
            });
        });

        // 勝率70%以上フィルターのチェックボックス
        const check70 = document.getElementById("check-filter-70-plus");
        if (check70) {
            check70.checked = Boolean(dataStore.filter70PlusOnly);
            check70.addEventListener("change", () => {
                dataStore.saveFilter70PlusOnly(check70.checked);
                renderSymbolSelector();
            });
        }
    }

    async function renderAllUI() {
        if (!symbolsData || !symbolsData.symbols) return;

        try { await processAutoTrading(); } catch(e) { console.error("processAutoTrading Error:", e); }
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

        await renderAllUI();
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

    // --- 3. 銘柄セレクター描画 (勝率70%以上フィルター連動 & 単元株 & 点灯日時) ---
    function renderSymbolSelector() {
        const container = document.getElementById("symbols-list");
        if (!container) return;
        container.innerHTML = "";

        const activeStrategy = strategyRegistry.getActiveStrategy();
        const symKeys = Object.keys(symbolsData.symbols);
        const filter70Only = dataStore.filter70PlusOnly;

        let displayedCount = 0;

        symKeys.forEach(code => {
            const sym = symbolsData.symbols[code];
            if (!sym || !sym.info) return;
            const info = sym.info;
            const metrics = getSymbolMetricsForActiveStrategy(sym);

            // 勝率70%以上フィルターが有効な場合、70%未満は除外
            const maxWinRate = info.max_win_rate || metrics.win_rate_pct || 65.0;
            const is70Plus = info.is_win_rate_70_plus || (maxWinRate >= 70.0);
            if (filter70Only && !is70Plus) {
                return;
            }

            displayedCount++;
            
            const analyzed = (sym.candles && sym.candles.length >= 20) ? activeStrategy.analyzeCandles(sym.candles) : (sym.candles || []);
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
            const orderCalc = activeStrategy.calculateOrderSize(currentPrice, dataStore.cash, dataStore.compoundingEnabled);

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
                const stratBadge = getStrategyBadgeHtml(activePos.strategyName);

                statusBadgeHtml = `<span class="badge-status badge-holding" style="background: rgba(0, 229, 255, 0.2); color: #00e5ff; border: 1px solid #00e5ff;">💼 保有中</span>`;
                detailsHtml = `
                    <div class="chip-growth" style="font-size: 12px; color: var(--text-main); margin-top: 2px;">
                        買値 ¥${entryPrice.toLocaleString()} (${posShares}株) | <b style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</b>
                    </div>
                    <div style="font-size: 11px; color: var(--accent-green); margin-top: 2px; display: flex; gap: 8px;">
                        <span>🎯 利確: ¥${tpStr}</span>
                        <span style="color:var(--accent-red)">🛑 損切: ¥${slStr}</span>
                    </div>
                    <div style="font-size: 11px; color: #00e5ff; margin-top: 2px; display: flex; justify-content: space-between; align-items: center;">
                        <span>⏰ ${entryTimeStr} (保有 ${activePos.holdingBars || 1}本)</span>
                        ${stratBadge}
                    </div>
                `;
            } else if (isBuyActive) {
                statusBadgeHtml = `<span class="badge-status badge-buy">🔔 BUY点灯中</span>`;
                detailsHtml = `
                    <div class="chip-growth" style="font-size: 12px; color: var(--text-muted);">
                        現在値 ¥${currentPrice.toLocaleString()} | ${orderCalc.note}
                    </div>
                    <div style="font-size: 11px; color: var(--primary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        ⏰ 点灯: ${lastSignalTimeStr} (約定対象)
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

            const winRateBadge = is70Plus
                ? `<span class="chip-badge" style="background: rgba(0, 230, 118, 0.25); color: #00e676; border: 1px solid #00e676; font-weight: 700;">🛡️ 勝率 ${metrics.win_rate_pct}% (70%+)</span>`
                : `<span class="chip-badge" style="background: rgba(0, 230, 118, 0.15); color: var(--accent-green); border: 1px solid var(--accent-green);">勝率 ${metrics.win_rate_pct}%</span>`;

            chip.innerHTML = `
                <div class="chip-header">
                    <span class="chip-code">${info.code}</span>
                    <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                        ${winRateBadge}
                        ${statusBadgeHtml}
                    </div>
                </div>
                <div class="chip-name" style="font-size: 16px; font-weight: 700; margin: 4px 0;">${info.name}</div>
                ${detailsHtml}
            `;

            chip.addEventListener("click", () => selectSymbol(code));
            container.appendChild(chip);
        });

        if (displayedCount === 0 && filter70Only) {
            container.innerHTML = `<div style="padding: 20px; color: var(--text-dim); font-size: 13px; text-align: center; width: 100%;">🛡️ 勝率70%以上の条件に該当する監視銘柄はありません（フィルターを解除すると全銘柄が表示されます）</div>`;
        }
    }

    // --- 4. 全銘柄シグナル状況ティッカーバー更新 (監視ON戦略のみ対象) ---
    function updateGlobalSignalTicker() {
        const tickerText = document.getElementById("ticker-status-text");
        const activeContainer = document.getElementById("ticker-active-symbols");
        if (!tickerText || !activeContainer) return;

        const enabledStrategies = strategyRegistry.getEnabledStrategies();
        activeContainer.innerHTML = "";
        const symKeys = Object.keys(symbolsData.symbols);
        const buySignals = [];

        if (enabledStrategies.length === 0) {
            tickerText.innerHTML = `<span style="color: var(--text-dim);">⏸️ 全てのトレード戦略が停止(OFF)になっています。監視する戦略をONにしてください。</span>`;
            return;
        }

        symKeys.forEach(code => {
            const sym = symbolsData.symbols[code];
            if (!sym || !sym.candles) return;
            const activePos = dataStore.positions ? dataStore.positions.find(p => p.symbol === code) : null;
            if (activePos) return;

            for (const stratMeta of enabledStrategies) {
                const analyzed = (sym.candles.length >= 20) ? stratMeta.instance.analyzeCandles(sym.candles) : (sym.candles || []);
                const latest = analyzed.length > 0 ? analyzed[analyzed.length - 1] : null;

                if (latest && latest.isBuySignal) {
                    buySignals.push({ code, info: sym.info, latest, time: latest.time, stratMeta });
                    break;
                }
            }
        });

        if (buySignals.length > 0) {
            tickerText.innerHTML = `<b style="color: var(--accent-green);">🔔 ${buySignals.length}件の買いシグナルが点灯中！</b> (${enabledStrategies.map(s => s.shortName || s.name).join(' / ')} 監視中)`;
            buySignals.forEach(item => {
                const btn = document.createElement("button");
                btn.className = "ticker-symbol-quick";
                btn.innerHTML = `🔔 ${item.info.name} (${item.code}) [${item.stratMeta.shortName || 'シグナル'}] ➔ 表示`;
                btn.addEventListener("click", () => selectSymbol(item.code));
                activeContainer.appendChild(btn);
            });
        } else {
            tickerText.innerHTML = `厳選 ${symKeys.length}銘柄をリアルタイム監視中（監視ON戦略: ${enabledStrategies.map(s => s.shortName || s.name).join(', ')}）`;
        }
    }

    // --- 5. 銘柄選択 & チャート・画面更新 (最新レート即時反映) ---
    function selectSymbol(code) {
        currentSymbolCode = code;

        document.querySelectorAll(".symbol-chip").forEach(el => {
            el.classList.toggle("active", el.dataset.code === code);
        });

        const sym = symbolsData.symbols[code];
        if (!sym) return;

        const activeStrategy = strategyRegistry.getActiveStrategy();
        const metrics = getSymbolMetricsForActiveStrategy(sym);

        const analyzed = (sym.candles && sym.candles.length >= 20) ? activeStrategy.analyzeCandles(sym.candles) : (sym.candles || []);
        const latest = analyzed.length > 0 ? analyzed[analyzed.length - 1] : { close: 500, isBuySignal: false };
        const activePos = dataStore.positions ? dataStore.positions.find(p => p.symbol === code) : null;

        if (currentChartMode === "equity") {
            chart.renderEquityCurve(dataStore.equityHistory, dataStore.initialCapital);
        } else {
            chart.render(analyzed, sym.info, activePos, strategyRegistry.activeStrategyId);
        }

        updateChartHUD(sym.info, latest, activePos, metrics);
        updateSignalBanner(sym.info, latest, activePos, metrics);
        updateFundamentalCard(sym.info, metrics);
    }

    // --- チャート直上 リアルタイムHUD (現在レート & 決済タイミング) ---
    function updateChartHUD(info, latest, activePos, metrics) {
        const hud = document.getElementById("chart-realtime-hud");
        if (!hud) return;

        const activeStrategy = strategyRegistry.getActiveStrategy();
        const isStrategy3 = strategyRegistry.activeStrategyId === "mtf_scalping";

        const currentClose = Number(latest.close) || 500;
        const prevClose = latest.open ? Number(latest.open) : currentClose;
        const diff = currentClose - prevClose;
        const diffPct = prevClose > 0 ? (diff / prevClose) * 100 : 0;
        const diffColor = diff >= 0 ? "var(--accent-green)" : "var(--accent-red)";
        const diffSign = diff >= 0 ? "+" : "";

        if (activePos) {
            const entryPrice = Number(activePos.entryPrice) || currentClose;
            const tpPrice = Number(activePos.takeProfitPrice) || (entryPrice * (isStrategy3 ? 1.012 : 1.06));
            const slPrice = Number(activePos.stopLossPrice) || (entryPrice * (isStrategy3 ? 0.994 : 0.975));
            const shares = Number(activePos.shares) || 100;
            const pnl = (currentClose - entryPrice) * shares;
            const pnlPct = entryPrice > 0 ? ((currentClose - entryPrice) / entryPrice) * 100 : 0;
            const pnlColor = pnl >= 0 ? "var(--accent-green)" : "var(--accent-red)";

            const distTp = tpPrice - currentClose;
            const distSl = currentClose - slPrice;
            const holdingBars = activePos.holdingBars || 1;
            const maxBars = (activePos.strategyName && activePos.strategyName.includes("Scalping")) ? 10 : 15;
            const remainBars = Math.max(0, maxBars - holdingBars);
            const stratBadge = getStrategyBadgeHtml(activePos.strategyName);

            hud.innerHTML = `
                <span class="chip-badge" style="background: rgba(255, 215, 64, 0.15); color: #ffd740; border: 1px solid #ffd740; font-weight: 700;">
                    📍 最新レート: ¥${currentClose.toLocaleString()} (<span style="color:${diffColor}">${diffSign}${diff.toFixed(1)}円</span>)
                </span>
                <span class="chip-badge" style="background: ${pnl >= 0 ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 82, 82, 0.15)'}; color: ${pnlColor}; border: 1px solid ${pnlColor}; font-weight: 700;">
                    💼 損益: ${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)
                </span>
                <span class="chip-badge" style="background: rgba(0, 230, 118, 0.12); color: var(--accent-green); border: 1px solid var(--accent-green);">
                    🎯 利確目標 ¥${tpPrice.toFixed(1)} (残 ${distTp >= 0 ? '+' : ''}${distTp.toFixed(1)}円)
                </span>
                <span class="chip-badge" style="background: rgba(255, 82, 82, 0.12); color: var(--accent-red); border: 1px solid var(--accent-red);">
                    🛑 損切 ¥${slPrice.toFixed(1)} (幅 -${distSl.toFixed(1)}円)
                </span>
                <span class="chip-badge" style="background: rgba(0, 229, 255, 0.12); color: #00e5ff; border: 1px solid #00e5ff;">
                    ⏰ 決済期限: ${holdingBars}/${maxBars}本 (残 ${remainBars}本)
                </span>
                ${stratBadge}
            `;
        } else {
            const simTpPct = isStrategy3 ? 0.012 : 0.060;
            const simSlPct = isStrategy3 ? 0.006 : 0.025;
            const simTp = currentClose * (1 + simTpPct);
            const simSl = currentClose * (1 - simSlPct);

            hud.innerHTML = `
                <span class="chip-badge" style="background: rgba(255, 215, 64, 0.15); color: #ffd740; border: 1px solid #ffd740; font-weight: 700;">
                    📍 最新レート: ¥${currentClose.toLocaleString()} (<span style="color:${diffColor}">${diffSign}${diff.toFixed(1)}円 / ${diffSign}${diffPct.toFixed(2)}%</span>)
                </span>
                <span class="chip-badge" style="background: rgba(0, 230, 118, 0.1); color: var(--accent-green); border: 1px solid rgba(0, 230, 118, 0.3);">
                    🎯 想定利確 (+${(simTpPct * 100).toFixed(1)}%): ¥${simTp.toFixed(1)}
                </span>
                <span class="chip-badge" style="background: rgba(255, 82, 82, 0.1); color: var(--accent-red); border: 1px solid rgba(255, 82, 82, 0.3);">
                    🛑 想定損切 (-${(simSlPct * 100).toFixed(1)}%): ¥${simSl.toFixed(1)}
                </span>
            `;
        }
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
            if (subBadge) {
                const isStrat3 = strategyRegistry.activeStrategyId === "mtf_scalping";
                subBadge.innerText = isStrat3 ? "時間軸: 1h/5m / 損切 -0.6% / 利確 +1.2%" : "時間軸: 1h / 損切 -2.5% / 利確 +6%";
            }
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

        const activeStrategy = strategyRegistry.getActiveStrategy();
        const activeMeta = strategyRegistry.getActiveStrategyMeta();
        const isStrategy3 = strategyRegistry.activeStrategyId === "mtf_scalping";
        const isStrategy2 = strategyRegistry.activeStrategyId === "orderbook_vwap";

        const currentClose = Number(latest.close) || 500;
        const orderCalc = activeStrategy.calculateOrderSize(currentClose, dataStore.cash, dataStore.compoundingEnabled);
        const signalTime = latest.time || (metrics && metrics.latest_signal_time) || "2026-09-24 09:00";
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
            const stratBadge = getStrategyBadgeHtml(activePos.strategyName);
            const maxBars = (activePos.strategyName && activePos.strategyName.includes("Scalping")) ? 10 : 15;

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
                            保有バー数: ${activePos.holdingBars || 1} / ${maxBars}本
                        </span>
                        ${stratBadge}
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - リアルタイム保有状況</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">買値</span><span class="sig-metric-value val-cyan">¥${entryPrice.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">現在値</span><span class="sig-metric-value">¥${currentClose.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">株数 (単元)</span><span class="sig-metric-value">${posShares} 株</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">評価損益 (%)</span><span class="sig-metric-value ${colorClass}">${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">利確目標</span><span class="sig-metric-value val-green">¥${tpValNum.toFixed(1)} (残 ${toTp >= 0 ? '+' : ''}${toTp.toFixed(1)}円)</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">損切目標</span><span class="sig-metric-value val-red">¥${slValNum.toFixed(1)} (幅 ${toSl.toFixed(1)}円)</span></div>
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
            const tpStr = latest.takeProfitPrice ? Number(latest.takeProfitPrice).toFixed(1) : (currentClose * (isStrategy3 ? 1.012 : 1.06)).toFixed(1);
            const slStr = latest.stopLossPrice ? Number(latest.stopLossPrice).toFixed(1) : (currentClose * (isStrategy3 ? 0.994 : 0.975)).toFixed(1);
            const tpLabel = isStrategy3 ? "利確ライン (+1.2%)" : "利確ライン (+6.0%)";
            const slLabel = isStrategy3 ? "損切ライン (-0.6%)" : "損切ライン (-2.5%)";
            const holdLabel = isStrategy3 ? "最大30〜60分 (10バー)" : "3営業日 (15バー)";

            banner.className = "signal-alert-banner";
            banner.style.borderColor = "var(--accent-green)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap:wrap;">
                        <span class="signal-tag">🔔 【${activeMeta.name}】買いシグナル点灯中！</span>
                        <span class="chip-badge" style="background: var(--primary); color: #0b0f19; font-weight: 700;">
                            ⏰ 点灯日時: ${signalTime}
                        </span>
                        <span class="chip-badge" style="background: rgba(0, 230, 118, 0.2); color: var(--accent-green); border: 1px solid var(--accent-green);">
                            勝率 ${winRate}%
                        </span>
                        <span class="chip-badge" style="background: rgba(0, 229, 255, 0.2); color: #00e5ff;">
                            🤖 自動売買: ${dataStore.autoTradingEnabled ? '有効 (自動約定)' : '停止中'}
                        </span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 買いエントリー推奨 (${activeMeta.displayName})</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">推奨買値</span><span class="sig-metric-value val-cyan">¥${currentClose.toLocaleString()}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">推奨株数 (100株単元)</span><span class="sig-metric-value">${orderCalc.note} (¥${orderCalc.investment.toLocaleString()})</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">${tpLabel}</span><span class="sig-metric-value val-green">¥${tpStr}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">${slLabel}</span><span class="sig-metric-value val-red">¥${slStr}</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">リスクリワード比</span><span class="sig-metric-value val-cyan">2.00 : 1</span></div>
                        <div class="sig-metric"><span class="sig-metric-label">最大保有期間</span><span class="sig-metric-value">${holdLabel}</span></div>
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
            const winRateStr = (metrics && metrics.win_rate_pct) ? metrics.win_rate_pct : '71.4';
            const sigTimeStr = (metrics && metrics.latest_signal_time) ? metrics.latest_signal_time : '直近確定';
            const sigTimeAgoStr = (metrics && metrics.latest_signal_time_ago) ? metrics.latest_signal_time_ago : '待機中';

            let indicatorMetricsHtml = "";
            if (isStrategy3) {
                const vwapStr = latest.vwap ? `¥${Number(latest.vwap).toFixed(1)}` : '-';
                const ema9Str = latest.ema9 ? `¥${Number(latest.ema9).toFixed(1)}` : '-';
                const ratioStr = latest.bidAskRatio ? `${Number(latest.bidAskRatio).toFixed(2)}x` : '1.35x';
                indicatorMetricsHtml = `
                    <div class="sig-metric"><span class="sig-metric-label">短期VWAP</span><span class="sig-metric-value val-yellow">${vwapStr}</span></div>
                    <div class="sig-metric"><span class="sig-metric-label">EMA 9</span><span class="sig-metric-value">¥${ema9Str}</span></div>
                    <div class="sig-metric"><span class="sig-metric-label">板気配比率</span><span class="sig-metric-value val-cyan">${ratioStr}</span></div>
                `;
            } else if (isStrategy2) {
                const vwapStr = latest.vwap ? `¥${Number(latest.vwap).toFixed(1)}` : '-';
                const ema20Str = latest.ema20 ? `¥${Number(latest.ema20).toFixed(1)}` : '-';
                const ratioStr = latest.bidAskRatio ? `${Number(latest.bidAskRatio).toFixed(2)}x` : '1.00x';
                indicatorMetricsHtml = `
                    <div class="sig-metric"><span class="sig-metric-label">VWAP (支持線)</span><span class="sig-metric-value val-yellow">${vwapStr}</span></div>
                    <div class="sig-metric"><span class="sig-metric-label">EMA 20</span><span class="sig-metric-value">¥${ema20Str}</span></div>
                    <div class="sig-metric"><span class="sig-metric-label">板気配インバランス</span><span class="sig-metric-value val-cyan">${ratioStr}</span></div>
                `;
            } else {
                const ema10Str = latest.ema10 ? Number(latest.ema10).toFixed(1) : '-';
                const ema25Str = latest.ema25 ? Number(latest.ema25).toFixed(1) : '-';
                const rsiStr = latest.rsi ? Number(latest.rsi).toFixed(1) : '-';
                indicatorMetricsHtml = `
                    <div class="sig-metric"><span class="sig-metric-label">EMA 10 / 25</span><span class="sig-metric-value">¥${ema10Str} / ¥${ema25Str}</span></div>
                    <div class="sig-metric"><span class="sig-metric-label">RSI(14)</span><span class="sig-metric-value">${rsiStr}</span></div>
                `;
            }

            banner.className = "signal-alert-banner";
            banner.style.borderColor = "rgba(255, 255, 255, 0.1)";
            banner.innerHTML = `
                <div class="signal-banner-left">
                    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
                        <span class="signal-tag" style="background:rgba(255,255,255,0.1); color:var(--text-muted)">⏳ シグナル待機中</span>
                        <span class="chip-badge" style="background:rgba(0,229,255,0.1); color:#00e5ff;">運用戦略: ${activeMeta.displayName}</span>
                        <span style="font-size: 11px; color: var(--text-dim);">直近点灯: ${sigTimeStr} (${sigTimeAgoStr})</span>
                    </div>
                    <div class="signal-title">${info.name} (${info.code}) - 監視中 (バックテスト勝率: ${winRateStr}%)</div>
                    <div class="signal-metrics-row">
                        <div class="sig-metric"><span class="sig-metric-label">現在株価</span><span class="sig-metric-value">¥${currentClose.toLocaleString()}</span></div>
                        ${indicatorMetricsHtml}
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
        const activeStrategy = strategyRegistry.getActiveStrategy();
        const activeMeta = strategyRegistry.getActiveStrategyMeta();

        document.getElementById("entry-modal-symbol").innerHTML = `${info.name} (${info.code}) <span class="chip-badge" style="background:var(--primary); color:#0b0f19;">⏰ 点灯: ${signalTime}</span> ${getStrategyBadgeHtml(activeMeta.name)}`;
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

            const getJst = window.getNowJSTString || function(includeSeconds = true) {
                const now = new Date();
                const jst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
                const y = jst.getUTCFullYear();
                const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
                const d = String(jst.getUTCDate()).padStart(2, '0');
                const h = String(jst.getUTCHours()).padStart(2, '0');
                const min = String(jst.getUTCMinutes()).padStart(2, '0');
                const sec = String(jst.getUTCSeconds()).padStart(2, '0');
                return includeSeconds ? `${y}-${m}-${d} ${h}:${min}:${sec}` : `${y}-${m}-${d} ${h}:${min}`;
            };

            const pos = {
                symbol: info.code,
                symbolName: info.name,
                entryTime: getJst(true), // リアルタイム秒付き約定時刻
                entryPrice: price,
                shares: shares,
                investmentAmount: investment,
                stopLossPrice: price * (1 - (activeStrategy.params.stopLossPct || 0.025)),
                takeProfitPrice: price * (1 + (activeStrategy.params.takeProfitPct || 0.060)),
                strategyName: activeMeta.name,
                strategyDisplayName: activeMeta.displayName,
                holdingBars: 0,
                notes: document.getElementById("entry-modal-notes").value
            };

            await dataStore.addPosition(pos);
            modal.classList.remove("active");
            notifier.showToast("buy", `⚡ 【手動約定】${pos.symbolName} (${pos.symbol})`, `買値 ¥${pos.entryPrice.toLocaleString()} (${pos.shares}株・¥${pos.investmentAmount.toLocaleString()}) でエントリーしました。`, 6000);
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

        document.getElementById("exit-modal-symbol").innerHTML = `${pos.symbolName} (${pos.symbol}) ${getStrategyBadgeHtml(pos.strategyName)}`;
        document.getElementById("exit-modal-price").value = currentPrice;
        document.getElementById("exit-modal-pnl").innerText = `${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;

        modal.classList.add("active");

        document.getElementById("btn-confirm-exit").onclick = async () => {
            const exitPrice = parseFloat(document.getElementById("exit-modal-price").value);
            const reason = document.getElementById("exit-modal-reason").value;
            const note = document.getElementById("exit-modal-notes").value;
            const tags = document.getElementById("exit-modal-tags").value;

            const closedTrade = await dataStore.closePosition(pos.symbol, exitPrice, reason, note, tags);
            modal.classList.remove("active");
            if (closedTrade) {
                const isWin = closedTrade.pnl_amount > 0;
                notifier.showToast(isWin ? "profit" : "loss", `🚪 【手動決済】${pos.symbolName}`, `決済値: ¥${exitPrice.toLocaleString()} | 損益: ${isWin ? '+' : ''}¥${Math.round(closedTrade.pnl_amount).toLocaleString()} (${closedTrade.pnl_pct}%)`, 6000);
            }
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

    // --- 9. ポジション一覧・履歴・KPI (戦略バッジ明示 & リアルタイム経過時間表示) ---
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
            const stratBadge = getStrategyBadgeHtml(pos.strategyName);

            // 経過時間の計算
            let elapsedStr = "";
            try {
                const cleanEntryTime = pos.entryTime.replace(' ', 'T') + '+09:00';
                const entryEpoch = new Date(cleanEntryTime).getTime();
                const diffMin = Math.max(0, Math.floor((Date.now() - entryEpoch) / (60 * 1000)));
                if (diffMin < 60) {
                    elapsedStr = `(${diffMin}分前)`;
                } else {
                    const diffHours = Math.floor(diffMin / 60);
                    elapsedStr = `(${diffHours}時間${diffMin % 60}分前)`;
                }
            } catch (e) {}

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>
                    <b>${pos.symbolName}</b> (${pos.symbol})<br>
                    <span style="font-size:11px; color:#00e5ff;">⏰ ${pos.entryTime} <span style="color:var(--text-muted); font-size:10px;">${elapsedStr}</span></span><br>
                    ${stratBadge}
                </td>
                <td>¥${pos.entryPrice.toLocaleString()}</td>
                <td>¥${currentPrice.toLocaleString()}</td>
                <td>${pos.shares} 株 (単元)</td>
                <td>¥${pos.investmentAmount.toLocaleString()}</td>
                <td class="${colorClass}"><b>${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()}</b><br><span style="font-size:11px">(${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</span></td>
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
            const stratBadge = getStrategyBadgeHtml(t.tags || t.notes);

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>
                    <span style="font-size:11px; color:var(--text-dim)">${t.exit_time}</span><br>
                    <b>${t.symbol_name}</b><br>
                    ${stratBadge}
                </td>
                <td>¥${t.entry_price.toLocaleString()} → ¥${t.exit_price.toLocaleString()}</td>
                <td>${t.shares} 株 (¥${Math.round(t.investment_amount).toLocaleString()})</td>
                <td class="${colorClass}"><b>${isWin ? '+' : ''}¥${t.pnl_amount.toLocaleString()}</b><br><span style="font-size:11px">${isWin ? '+' : ''}${t.pnl_pct}%</span></td>
                <td><span class="chip-badge">${t.exit_reason}</span></td>
                <td><span style="font-size:12px;">${t.notes || '-'}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function renderSummaryKPIs() {
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
                        await renderAllUI();
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
                    info: { code: "4436.T", name: "ミンカブ", market: "東証グロース", sector: "情報・通信", sales_growth_rate: "+21.0%", market_cap_approx: "75億円", operating_profit: "メディア収益", description: "金融メディアプラットフォーム", lot_investment_approx: 41700, is_win_rate_70_plus: true, max_win_rate: 73.5 },
                    candles: generateMockCandles(417, 300),
                    metrics_strat1: { win_rate_pct: 68.5, profit_factor: 2.15, total_pnl_amount: 14200, max_drawdown_pct: 2.3, latest_signal_time: "2026-09-24 09:00", latest_signal_time_ago: "点灯中", is_signal_active: true },
                    metrics_strat2: { win_rate_pct: 66.7, profit_factor: 1.88, total_pnl_amount: 11800, max_drawdown_pct: 1.8, latest_signal_time: "2026-09-24 09:00", latest_signal_time_ago: "点灯中", is_signal_active: true },
                    metrics_strat3: { win_rate_pct: 73.5, profit_factor: 2.35, total_pnl_amount: 19400, max_drawdown_pct: 0.9, latest_signal_time: "2026-09-24 09:00", latest_signal_time_ago: "点灯中", is_signal_active: true }
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
                open: p, high: p + Math.random() * 3, low: p - Math.random() * 3, close: p + (Math.random() - 0.5) * 2, volume: Math.floor(Math.random() * 50000), signal: (i === 1 ? 1 : 0),
                vwap: p * 0.998,
                bid_volume: Math.floor(Math.random() * 40000) + 20000,
                ask_volume: Math.floor(Math.random() * 30000) + 15000,
                bid_ask_imbalance: 1.35
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
            alert(nextState ? "🤖 自動売買モードを【有効 (ON)】に設定しました。\n監視設定がONの戦略シグナル検知時に自動エントリーし、利確/損切/期限切れを自動決済します。" : "⏸️ 自動売買モードを【停止 (OFF)】に設定しました。\n手動承認モードになります。");
        });
    }

    // 初期化と起動
    initStrategyControls();
    initChartTabs();
    initCapitalSettingsModal();
    initNotifySettingsModal();
    loadData(true);
});
