/**
 * インタラクティブチャート描画モジュール (web/js/chart.js)
 * - Plotly.js を使用した1時間足ローソク足、EMA10/EMA25/EMA50、MACD、RSI、VWAP、板気配インバランス描画
 * - 画面更新・切り替えごとの最新レート即時反映 (Current Price Horizon & Badges)
 * - ポジション保有中の決済タイミング（利確+6% / 損切-2.5% / 15バー保有期限）の直感的可視化
 * - 未エントリー時の想定利確/損切シミュレーションガイド
 */

class TradingChart {
    constructor(containerId = "main-chart-container") {
        this.containerId = containerId;
    }

    render(analyzedCandles, symbolInfo, activePosition = null, strategyId = "triple_confluence", interval = "60m") {
        if (!analyzedCandles || analyzedCandles.length === 0) return;

        const times = analyzedCandles.map(c => c.time);
        const opens = analyzedCandles.map(c => c.open);
        const highs = analyzedCandles.map(c => c.high);
        const lows = analyzedCandles.map(c => c.low);
        const closes = analyzedCandles.map(c => c.close);
        const volumes = analyzedCandles.map(c => c.volume);
        const rsi = analyzedCandles.map(c => c.rsi);

        const lastIndex = analyzedCandles.length - 1;
        const lastTime = times[lastIndex];
        const currentPrice = closes[lastIndex] || (symbolInfo && symbolInfo.current_price_approx) || 500;
        const prevPrice = lastIndex > 0 ? closes[lastIndex - 1] : currentPrice;
        const priceChange = currentPrice - prevPrice;
        const priceChangePct = prevPrice > 0 ? (priceChange / prevPrice) * 100 : 0;
        const changeSign = priceChange >= 0 ? "+" : "";

        const isStrategy3 = (strategyId === "mtf_scalping") || Boolean(analyzedCandles[0] && analyzedCandles[0].strategyName && analyzedCandles[0].strategyName.includes("Scalping"));
        const isStrategy2 = !isStrategy3 && ((strategyId === "orderbook_vwap") || Boolean(analyzedCandles[0] && analyzedCandles[0].vwap !== undefined && !analyzedCandles[0].strategyName));

        const intervalLabels = {
            "5m": "5分足 (5m 高速スキャル)",
            "15m": "15分足 (15m デイトレ)",
            "30m": "30分足 (30m デイトレ)",
            "60m": "1時間足 (60m スイング/デイトレ)"
        };
        const currentIntervalLabel = intervalLabels[interval] || `${interval}足`;

        // 買いシグナルポイント抽出
        const buySignals = analyzedCandles.filter(c => c.isBuySignal);
        const buyTimes = buySignals.map(c => c.time);
        const buyPrices = buySignals.map(c => c.close);

        const traces = [
            // (1) ローソク足
            {
                type: "candlestick",
                x: times,
                open: opens,
                high: highs,
                low: lows,
                close: closes,
                name: `株価 OHLC [${currentIntervalLabel}]`,
                increasing: { line: { color: "#00e676", width: 1.5 }, fillcolor: "rgba(0, 230, 118, 0.4)" },
                decreasing: { line: { color: "#ff5252", width: 1.5 }, fillcolor: "rgba(255, 82, 82, 0.4)" },
                xaxis: "x",
                yaxis: "y"
            }
        ];

        if (isStrategy3) {
            // 戦略3 (MTF高速スキャル・デイトレ): 短期VWAP + EMA10 + EMA25 + EMA50 + 板気配インバランス
            const vwap = analyzedCandles.map(c => c.vwap !== undefined ? c.vwap : c.close);
            const ema10 = analyzedCandles.map(c => c.ema10 !== undefined ? c.ema10 : c.close);
            const ema25 = analyzedCandles.map(c => c.ema25 !== undefined ? c.ema25 : c.close);
            const ema50 = analyzedCandles.map(c => c.ema50 !== undefined ? c.ema50 : c.close);
            const bidAskRatio = analyzedCandles.map(c => c.bidAskRatio !== undefined ? c.bidAskRatio : (c.bid_ask_imbalance || 1.25));

            traces.push(
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: vwap,
                    name: "VWAP (出来高加重平均)",
                    line: { color: "#ffd740", width: 2.2, dash: "solid" },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema10,
                    name: "EMA 10 (超短期)",
                    line: { color: "#00e5ff", width: 1.8 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema25,
                    name: "EMA 25 (中期)",
                    line: { color: "#b388ff", width: 1.6 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema50,
                    name: "EMA 50 (長期支持線)",
                    line: { color: "#ff80ab", width: 1.4, dash: "dot" },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "bar",
                    x: times,
                    y: bidAskRatio,
                    name: "板気配比率 (Bid/Ask)",
                    marker: {
                        color: bidAskRatio.map(r => (r >= 1.25 ? "#ffd740" : (r >= 1.10 ? "#00e676" : "#4a5568")))
                    },
                    xaxis: "x",
                    yaxis: "y2"
                }
            );
        } else if (isStrategy2) {
            // 戦略2: VWAP + EMA20 + EMA50 + 板気配インバランス
            const vwap = analyzedCandles.map(c => c.vwap !== undefined ? c.vwap : c.close);
            const ema20 = analyzedCandles.map(c => c.ema20 !== undefined ? c.ema20 : c.close);
            const ema50 = analyzedCandles.map(c => c.ema50 !== undefined ? c.ema50 : c.close);
            const bidAskRatio = analyzedCandles.map(c => c.bidAskRatio !== undefined ? c.bidAskRatio : (c.bid_ask_imbalance || 1.0));

            traces.push(
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: vwap,
                    name: "VWAP (出来高加重平均)",
                    line: { color: "#ffd740", width: 2.2, dash: "solid" },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema20,
                    name: "EMA 20",
                    line: { color: "#00e5ff", width: 1.6 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema50,
                    name: "EMA 50",
                    line: { color: "#b388ff", width: 1.6 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "bar",
                    x: times,
                    y: bidAskRatio,
                    name: "板気配比率 (Bid/Ask)",
                    marker: {
                        color: bidAskRatio.map(r => (r >= 1.25 ? "#00e676" : "#4a5568"))
                    },
                    xaxis: "x",
                    yaxis: "y2"
                }
            );
        } else {
            // 戦略1: EMA10 + EMA25 + MACD
            const ema10 = analyzedCandles.map(c => c.ema10);
            const ema25 = analyzedCandles.map(c => c.ema25);
            const macdHist = analyzedCandles.map(c => c.macdHist || 0);

            traces.push(
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema10,
                    name: "EMA 10 (短期)",
                    line: { color: "#00e5ff", width: 1.8 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "scatter",
                    mode: "lines",
                    x: times,
                    y: ema25,
                    name: "EMA 25 (長期)",
                    line: { color: "#b388ff", width: 1.8 },
                    xaxis: "x",
                    yaxis: "y"
                },
                {
                    type: "bar",
                    x: times,
                    y: macdHist,
                    name: "MACD Hist",
                    marker: {
                        color: macdHist.map(h => (h >= 0 ? "#00e676" : "#ff5252"))
                    },
                    xaxis: "x",
                    yaxis: "y2"
                }
            );
        }

        // 買いシグナルマーカー (▲)
        if (buyTimes.length > 0) {
            const tpPctDefault = isStrategy3 ? 1.025 : 1.06;
            const slPctDefault = isStrategy3 ? 0.984 : 0.975;
            const tpStr = isStrategy3 ? "+2.5%" : "+6.0%";
            const slStr = isStrategy3 ? "-1.6%" : "-2.5%";
            const holdRuleStr = isStrategy3 ? "最大8バー (当日大引け手仕舞い・持ち越しゼロ)" : "最大15バー (3営業日)";

            traces.push({
                type: "scatter",
                mode: "markers",
                x: buyTimes,
                y: buyPrices,
                name: isStrategy3 ? "⚡ 戦略3 BUYシグナル (▲)" : "BUY シグナル (▲)",
                marker: { symbol: "triangle-up", size: 14, color: isStrategy3 ? "#ffd740" : "#00e676", line: { width: 1.5, color: "#ffffff" } },
                hovertext: buySignals.map(s => {
                    const tpVal = s.takeProfitPrice ? s.takeProfitPrice.toFixed(1) : (s.close * tpPctDefault).toFixed(1);
                    const slVal = s.stopLossPrice ? s.stopLossPrice.toFixed(1) : (s.close * slPctDefault).toFixed(1);
                    return `【${isStrategy3 ? '⚡ 戦略3 高速デイトレ BUYシグナル' : '🔔 BUY推奨シグナル点灯'}】<br>時間軸: ${currentIntervalLabel}<br>日時: ${s.time}<br>株価: ¥${s.close}<br>利確目標(${tpStr}): ¥${tpVal}<br>損切ライン(${slStr}): ¥${slVal}<br>ルール: ${holdRuleStr}`;
                }),
                hoverinfo: "text",
                xaxis: "x",
                yaxis: "y"
            });
        }

        // RSI(14 / 9) (サブプロット3)
        traces.push({
            type: "scatter",
            mode: "lines",
            x: times,
            y: rsi,
            name: isStrategy3 ? "RSI(9)" : "RSI(14)",
            line: { color: "#ffd740", width: 1.8 },
            xaxis: "x",
            yaxis: "y3"
        });

        // サブプロットラベル設定
        const y2Title = isStrategy3 ? "板気配比率 (高速)" : (isStrategy2 ? "板気配比率" : "MACD");

        // シェイプとアノテーションの構築
        const shapes = [
            // RSI 水平基準ライン
            { type: "line", x0: times[0], x1: lastTime, y0: 70, y1: 70, yref: "y3", line: { color: "rgba(255, 82, 82, 0.4)", dash: "dot", width: 1 } },
            { type: "line", x0: times[0], x1: lastTime, y0: isStrategy3 ? 55 : (isStrategy2 ? 50 : 48), y1: isStrategy3 ? 55 : (isStrategy2 ? 50 : 48), yref: "y3", line: { color: "rgba(0, 229, 255, 0.6)", dash: "dash", width: 1 } },
            { type: "line", x0: times[0], x1: lastTime, y0: 30, y1: 30, yref: "y3", line: { color: "rgba(0, 230, 118, 0.4)", dash: "dot", width: 1 } }
        ];

        if (isStrategy3) {
            // 板気配比率 1.30 基準ライン
            shapes.push({
                type: "line", x0: times[0], x1: lastTime, y0: 1.30, y1: 1.30, yref: "y2",
                line: { color: "#ffd740", dash: "dash", width: 1.2 }
            });
        } else if (isStrategy2) {
            // 板気配比率 1.25 基準ライン
            shapes.push({
                type: "line", x0: times[0], x1: lastTime, y0: 1.25, y1: 1.25, yref: "y2",
                line: { color: "rgba(0, 230, 118, 0.7)", dash: "dash", width: 1.2 }
            });
        }

        const annotations = [];

        // 常に最新レート（現在値）の水平破線を描画
        shapes.push({
            type: "line",
            x0: times[0],
            x1: lastTime,
            y0: currentPrice,
            y1: currentPrice,
            yref: "y",
            line: { color: "#ffd740", dash: "dot", width: 1.6 }
        });

        if (activePosition) {
            // ==========================================
            // ポジション保有中: 決済タイミング完全可視化
            // ==========================================
            const entryP = Number(activePosition.entryPrice) || currentPrice;
            const tpP = Number(activePosition.takeProfitPrice) || (entryP * (isStrategy3 ? 1.012 : 1.06));
            const slP = Number(activePosition.stopLossPrice) || (entryP * (isStrategy3 ? 0.994 : 0.975));
            const posShares = Number(activePosition.shares) || 100;
            const holdingBars = activePosition.holdingBars || 1;
            const maxBars = isStrategy3 ? 10 : 15;
            const pnl = (currentPrice - entryP) * posShares;
            const pnlPct = entryP > 0 ? ((currentPrice - entryP) / entryP) * 100 : 0;
            const pnlColor = pnl >= 0 ? "#00e676" : "#ff5252";

            // 利確・損切までの残り値幅とパーセント
            const distTp = tpP - currentPrice;
            const distTpPct = ((tpP - currentPrice) / currentPrice) * 100;
            const distSl = currentPrice - slP;
            const distSlPct = ((currentPrice - slP) / currentPrice) * 100;

            // 1. 利確ゾーン（買値〜利確目標の薄緑背景）
            shapes.push({
                type: "rect",
                x0: times[0], x1: lastTime,
                y0: Math.min(entryP, tpP), y1: Math.max(entryP, tpP),
                yref: "y",
                fillcolor: "rgba(0, 230, 118, 0.08)",
                line: { width: 0 }
            });

            // 2. 損切ゾーン（損切ライン〜買値の薄赤背景）
            shapes.push({
                type: "rect",
                x0: times[0], x1: lastTime,
                y0: Math.min(slP, entryP), y1: Math.max(slP, entryP),
                yref: "y",
                fillcolor: "rgba(255, 82, 82, 0.08)",
                line: { width: 0 }
            });

            // 3. 買値ライン (シアン色実線)
            shapes.push({
                type: "line",
                x0: times[0], x1: lastTime,
                y0: entryP, y1: entryP,
                yref: "y",
                line: { color: "#00e5ff", dash: "solid", width: 2.2 }
            });

            // 4. 利確ライン (鮮やかな緑色破線)
            shapes.push({
                type: "line",
                x0: times[0], x1: lastTime,
                y0: tpP, y1: tpP,
                yref: "y",
                line: { color: "#00e676", dash: "dash", width: 2.2 }
            });

            // 5. 損切ライン (鮮やかな赤色破線)
            shapes.push({
                type: "line",
                x0: times[0], x1: lastTime,
                y0: slP, y1: slP,
                yref: "y",
                line: { color: "#ff5252", dash: "dash", width: 2.2 }
            });

            const tpPctStr = isStrategy3 ? "+2.5%" : "+6.0%";
            const slPctStr = isStrategy3 ? "-1.6%" : "-2.5%";

            // 右端アノテーションラベル（価格・決済条件・残り距離）
            annotations.push({
                x: lastTime, y: tpP, xref: "x", yref: "y",
                text: `🎯 利確目標: ¥${tpP.toFixed(1)} (${tpPctStr})<br><span style="font-size:10px;">残 ${distTp >= 0 ? '+' : ''}${distTp.toFixed(1)}円 (${distTpPct >= 0 ? '+' : ''}${distTpPct.toFixed(1)}%)</span>`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#00e676",
                ax: 75, ay: 0,
                bgcolor: "#00e676", font: { color: "#0b0f19", size: 10.5, weight: "bold" },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: entryP, xref: "x", yref: "y",
                text: `💼 買値: ¥${entryP.toLocaleString()} (${posShares}株)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#00e5ff",
                ax: 75, ay: (Math.abs(currentPrice - entryP) < 5 ? 20 : 0),
                bgcolor: "#00e5ff", font: { color: "#0b0f19", size: 10.5, weight: "bold" },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: currentPrice, xref: "x", yref: "y",
                text: `📍 現在値: ¥${currentPrice.toLocaleString()} (${pnl >= 0 ? '+' : ''}¥${Math.round(pnl).toLocaleString()} / ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#ffd740",
                ax: 75, ay: (currentPrice >= entryP ? -22 : 22),
                bgcolor: "#ffd740", font: { color: "#0b0f19", size: 10.5, weight: "bold" },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: slP, xref: "x", yref: "y",
                text: `🛑 損切ライン: ¥${slP.toFixed(1)} (${slPctStr})<br><span style="font-size:10px;">幅 -${distSl.toFixed(1)}円 (-${distSlPct.toFixed(1)}%)</span>`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#ff5252",
                ax: 75, ay: 0,
                bgcolor: "#ff5252", font: { color: "#ffffff", size: 10.5, weight: "bold" },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            // エントリー足のピンマーカー & 保有期限ガイド
            let entryIndex = -1;
            if (activePosition.entryTime) {
                const entryPrefix = String(activePosition.entryTime).substring(0, 16);
                const entryDatePrefix = String(activePosition.entryTime).substring(0, 10);
                for (let i = times.length - 1; i >= 0; i--) {
                    if (times[i].startsWith(entryPrefix) || times[i] <= entryPrefix) {
                        entryIndex = i;
                        break;
                    }
                }
                // 見つからない場合は日付マッチまたは最新足
                if (entryIndex < 0) {
                    for (let i = times.length - 1; i >= 0; i--) {
                        if (times[i].startsWith(entryDatePrefix)) {
                            entryIndex = i;
                            break;
                        }
                    }
                }
                if (entryIndex < 0) entryIndex = Math.max(0, times.length - 1);
            }

            if (entryIndex >= 0) {
                const entryTimeStr = times[entryIndex];
                const displayEntryTime = activePosition.entryTime || entryTimeStr;
                annotations.push({
                    x: entryTimeStr, y: entryP, xref: "x", yref: "y",
                    text: `◆ ENTRY 約定<br>¥${entryP.toLocaleString()}<br>⏰ ${displayEntryTime}`,
                    showarrow: true, arrowhead: 3, arrowcolor: "#00e5ff",
                    ax: 0, ay: -40,
                    bgcolor: "rgba(0, 229, 255, 0.95)", font: { color: "#0b0f19", size: 10, weight: "bold" },
                    bordercolor: "#ffffff", borderwidth: 1, borderpad: 3
                });

                // 保有バー数リミットの縦ライン
                const timeoutIndex = Math.min(times.length - 1, entryIndex + maxBars - 1);
                const timeoutTimeStr = times[timeoutIndex];
                shapes.push({
                    type: "line",
                    x0: timeoutTimeStr, x1: timeoutTimeStr,
                    y0: 0, y1: 1,
                    yref: "paper",
                    line: { color: "rgba(255, 215, 64, 0.8)", dash: "dashdot", width: 1.5 }
                });

                annotations.push({
                    x: timeoutTimeStr, y: 0.98, xref: "x", yref: "paper",
                    text: `⏰ 決済期限 (${maxBars}本満了)<br>現在保有: ${holdingBars} / ${maxBars}本 (残 ${Math.max(0, maxBars - holdingBars)}本)`,
                    showarrow: true, arrowhead: 2, arrowcolor: "#ffd740",
                    ax: 0, ay: -25,
                    bgcolor: "rgba(17, 24, 39, 0.9)", font: { color: "#ffd740", size: 10, weight: "bold" },
                    bordercolor: "#ffd740", borderwidth: 1, borderpad: 3
                });
            }

        } else {
            // ==========================================
            // 未保有時: 現在レート & 想定決済ライン表示
            // ==========================================
            const simTpPct = isStrategy3 ? 0.025 : 0.060;
            const simSlPct = isStrategy3 ? 0.016 : 0.025;
            const simTp = currentPrice * (1 + simTpPct);
            const simSl = currentPrice * (1 - simSlPct);

            // 想定利確・損切の点線ガイド
            shapes.push(
                { type: "line", x0: times[0], x1: lastTime, y0: simTp, y1: simTp, yref: "y", line: { color: "rgba(0, 230, 118, 0.5)", dash: "dot", width: 1.2 } },
                { type: "line", x0: times[0], x1: lastTime, y0: simSl, y1: simSl, yref: "y", line: { color: "rgba(255, 82, 82, 0.5)", dash: "dot", width: 1.2 } }
            );

            annotations.push({
                x: lastTime, y: currentPrice, xref: "x", yref: "y",
                text: `📍 現在値: ¥${currentPrice.toLocaleString()}<br><span style="font-size:10px;">前足比: ${changeSign}${priceChange.toFixed(1)} (${changeSign}${priceChangePct.toFixed(2)}%)</span>`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#ffd740",
                ax: 75, ay: 0,
                bgcolor: "#ffd740", font: { color: "#0b0f19", size: 10.5, weight: "bold" },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: simTp, xref: "x", yref: "y",
                text: `🎯 想定利確: ¥${simTp.toFixed(1)} (+${(simTpPct * 100).toFixed(1)}%)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "rgba(0, 230, 118, 0.7)",
                ax: 75, ay: 0,
                bgcolor: "rgba(0, 230, 118, 0.85)", font: { color: "#0b0f19", size: 10 },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 3
            });

            annotations.push({
                x: lastTime, y: simSl, xref: "x", yref: "y",
                text: `🛑 想定損切: ¥${simSl.toFixed(1)} (-${(simSlPct * 100).toFixed(1)}%)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "rgba(255, 82, 82, 0.7)",
                ax: 75, ay: 0,
                bgcolor: "rgba(255, 82, 82, 0.85)", font: { color: "#ffffff", size: 10 },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 3
            });
        }

        // ズーム表示基準: 直近のローソク足にフォーカス (PC: 36本, スマホ: 22本)
        const defaultVisibleBars = window.innerWidth < 768 ? 22 : 36;
        const startIdx = Math.max(0, times.length - defaultVisibleBars);
        const xStart = times[startIdx];
        const xEnd = times[times.length - 1];

        // 外部凡例バーの動的更新（チャート内の邪魔な被りを完全解消）
        const legendContainer = document.getElementById("legend-items");
        if (legendContainer) {
            let legendHtml = `
                <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:10px; height:10px; background:#00e676; border-radius:2px;"></span><span style="color:var(--text-muted);">株価 OHLC</span></span>
            `;
            if (isStrategy3) {
                legendHtml += `
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:3px; background:#ffd740; border-radius:2px;"></span><span style="color:#ffd740; font-weight:700;">短期VWAP</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2.5px; background:#00e5ff; border-radius:2px;"></span><span style="color:#00e5ff; font-weight:600;">EMA 10</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2px; background:#b388ff; border-radius:2px;"></span><span style="color:#b388ff;">EMA 25</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:1.5px; background:#ff80ab; border-radius:2px;"></span><span style="color:#ff80ab;">EMA 50</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; background:#4a5568; border-radius:1px;"></span><span style="color:var(--text-muted);">板気配比率</span></span>
                    <span style="display:flex; align-items:center; gap:3px;"><span style="color:#ffd740; font-size:12px;">▲</span><span style="color:#ffd740; font-weight:700;">BUYシグナル</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:#ffd740;"></span><span style="color:#ffd740;">RSI(9)</span></span>
                `;
            } else if (isStrategy2) {
                legendHtml += `
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:3px; background:#ffd740; border-radius:2px;"></span><span style="color:#ffd740; font-weight:700;">VWAP</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2.5px; background:#00e5ff; border-radius:2px;"></span><span style="color:#00e5ff; font-weight:600;">EMA 20</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2px; background:#b388ff; border-radius:2px;"></span><span style="color:#b388ff;">EMA 50</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; background:#00e676; border-radius:1px;"></span><span style="color:var(--text-muted);">板気配</span></span>
                    <span style="display:flex; align-items:center; gap:3px;"><span style="color:#00e676; font-size:12px;">▲</span><span style="color:#00e676; font-weight:700;">BUYシグナル</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:#ffd740;"></span><span style="color:#ffd740;">RSI(14)</span></span>
                `;
            } else {
                legendHtml += `
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2.5px; background:#00e5ff; border-radius:2px;"></span><span style="color:#00e5ff; font-weight:600;">EMA 10</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:14px; height:2px; background:#b388ff; border-radius:2px;"></span><span style="color:#b388ff;">EMA 25</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:8px; height:8px; background:#00e676; border-radius:1px;"></span><span style="color:var(--text-muted);">MACD Hist</span></span>
                    <span style="display:flex; align-items:center; gap:3px;"><span style="color:#00e676; font-size:12px;">▲</span><span style="color:#00e676; font-weight:700;">BUYシグナル</span></span>
                    <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:#ffd740;"></span><span style="color:#ffd740;">RSI(14)</span></span>
                `;
            }
            legendContainer.innerHTML = legendHtml;
        }

        const layout = {
            template: "plotly_dark",
            paper_bgcolor: "#0b0f19",
            plot_bgcolor: "#111827",
            margin: { l: 45, r: 155, t: 15, b: 35 },
            height: window.innerWidth < 768 ? 480 : 580,
            showlegend: false, // チャート内の凡例ボックスを非表示化しクリアな視認性を確保
            dragmode: "pan",   // ドラッグで直感的にチャートを左右・上下に移動 (Pan) 可能に！
            hovermode: "x unified",
            xaxis: {
                range: [xStart, xEnd], // 初期ズーム基準: 直近のローソク足に最適フォーカス！
                rangeslider: { visible: false },
                gridcolor: "#1f293d",
                domain: [0, 1]
            },
            yaxis: {
                domain: [0.45, 1.0],
                gridcolor: "#1f293d",
                title: "株価 (円)",
                autorange: true
            },
            yaxis2: {
                domain: [0.22, 0.40],
                gridcolor: "#1f293d",
                title: y2Title
            },
            yaxis3: {
                domain: [0.0, 0.18],
                gridcolor: "#1f293d",
                title: "RSI",
                range: [10, 90]
            },
            shapes: shapes,
            annotations: annotations
        };

        const config = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
            displaylogo: false,
            scrollZoom: true,   // ホイールスクロールやピンチでスムーズ拡大縮小
            doubleClick: 'reset' // ダブルクリックで直近足基準の最適ズームにリセット
        };

        // Plotly.react を使用してチラつきなく即座に最新レート・インジケーターを再描画
        Plotly.react(this.containerId, traces, layout, config);
    }

    /**
     * 資産推移・複利成長カーブ (Equity Curve) を描画
     */
    renderEquityCurve(equityHistory = [], initialCapital = 300000) {
        if (!equityHistory || equityHistory.length === 0) return;

        const times = equityHistory.map(h => h.time);
        const equities = equityHistory.map(h => Number(h.equity));
        const returnPcts = equityHistory.map(h => Number(h.returnPct));
        const notes = equityHistory.map(h => h.note || "");

        const latestEquity = equities[equities.length - 1] || initialCapital;
        const totalProfit = latestEquity - initialCapital;
        const totalProfitPct = initialCapital > 0 ? (totalProfit / initialCapital) * 100 : 0;
        const isProfitable = totalProfit >= 0;

        const mainColor = isProfitable ? "#00e676" : "#ff5252";
        const fillColor = isProfitable ? "rgba(0, 230, 118, 0.15)" : "rgba(255, 82, 82, 0.15)";

        const traces = [
            // 1. 総資産推移ライン (エリア塗りつぶし)
            {
                type: "scatter",
                mode: "lines+markers",
                x: times,
                y: equities,
                name: "総資産 (円)",
                line: { color: mainColor, width: 2.5 },
                marker: { size: 6, color: mainColor, symbol: "circle" },
                fill: "tozeroy",
                fillcolor: fillColor,
                hovertext: equityHistory.map(h => `日時: ${h.time}<br>総資産: ¥${Number(h.equity).toLocaleString()}<br>確定損益累計: ${Number(h.realizedPnl) >= 0 ? '+' : ''}¥${Number(h.realizedPnl).toLocaleString()}<br>リターン: ${Number(h.returnPct) >= 0 ? '+' : ''}${h.returnPct}%<br>📝 ${h.note || ''}`),
                hoverinfo: "text",
                yaxis: "y"
            },
            // 2. 元本基準ライン
            {
                type: "scatter",
                mode: "lines",
                x: [times[0], times[times.length - 1]],
                y: [initialCapital, initialCapital],
                name: `初期元本 (¥${initialCapital.toLocaleString()})`,
                line: { color: "rgba(255, 255, 255, 0.4)", width: 1.5, dash: "dash" },
                hoverinfo: "skip",
                yaxis: "y"
            }
        ];

        const annotations = [
            {
                x: times[times.length - 1],
                y: latestEquity,
                xref: "x",
                yref: "y",
                text: `💰 現在総資産: ¥${latestEquity.toLocaleString()}<br>(${isProfitable ? '+' : ''}¥${totalProfit.toLocaleString()} / ${isProfitable ? '+' : ''}${totalProfitPct.toFixed(2)}%)`,
                showarrow: true,
                arrowhead: 2,
                arrowsize: 1,
                arrowcolor: mainColor,
                ax: 40,
                ay: -30,
                bgcolor: mainColor,
                font: { color: "#0b0f19", size: 11, weight: "bold" },
                bordercolor: "#ffffff",
                borderwidth: 1,
                borderpad: 5
            }
        ];

        // 外部凡例バーを資産推移用に更新
        const legendContainer = document.getElementById("legend-items");
        if (legendContainer) {
            legendContainer.innerHTML = `
                <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:3px; background:${mainColor}; border-radius:2px;"></span><span style="color:${mainColor}; font-weight:700;">総資産 (運用残高)</span></span>
                <span style="display:flex; align-items:center; gap:4px;"><span style="display:inline-block; width:12px; height:2px; background:rgba(255,255,255,0.4);"></span><span style="color:var(--text-muted);">初期元本ライン (¥${initialCapital.toLocaleString()})</span></span>
            `;
        }

        const layout = {
            template: "plotly_dark",
            paper_bgcolor: "#0b0f19",
            plot_bgcolor: "#111827",
            margin: { l: 60, r: 80, t: 25, b: 40 },
            height: window.innerWidth < 768 ? 480 : 580,
            showlegend: false,
            dragmode: "pan",
            hovermode: "x unified",
            xaxis: {
                gridcolor: "#1f293d",
                title: "トレード日時 / 決済タイミング"
            },
            yaxis: {
                gridcolor: "#1f293d",
                title: "総資産 (円)",
                zerolinecolor: "#1f293d"
            },
            annotations: annotations
        };

        const config = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
            displaylogo: false,
            scrollZoom: true,
            doubleClick: 'reset'
        };

        Plotly.react(this.containerId, traces, layout, config);
    }
}

window.TradingChart = TradingChart;
