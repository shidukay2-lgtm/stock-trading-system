/**
 * インタラクティブチャート描画モジュール (web/js/chart.js)
 * Plotly.js を使用したローソク足、EMA10/EMA25、MACD、RSI、シグナルマーカー描画
 */

class TradingChart {
    constructor(containerId = "main-chart-container") {
        this.containerId = containerId;
    }

    render(analyzedCandles, symbolInfo, activePosition = null) {
        if (!analyzedCandles || analyzedCandles.length === 0) return;

        const times = analyzedCandles.map(c => c.time);
        const opens = analyzedCandles.map(c => c.open);
        const highs = analyzedCandles.map(c => c.high);
        const lows = analyzedCandles.map(c => c.low);
        const closes = analyzedCandles.map(c => c.close);
        const volumes = analyzedCandles.map(c => c.volume);
        const ema10 = analyzedCandles.map(c => c.ema10);
        const ema25 = analyzedCandles.map(c => c.ema25);
        const macdHist = analyzedCandles.map(c => c.macdHist);
        const rsi = analyzedCandles.map(c => c.rsi);

        // 買いシグナルポイント抽出
        const buySignals = analyzedCandles.filter(c => c.isBuySignal);
        const buyTimes = buySignals.map(c => c.time);
        const buyPrices = buySignals.map(c => c.close);

        // 3段サブプロット構成
        // 1. ローソク足 + EMA10 + EMA25 + 買いシグナルマーカー
        // 2. MACD ヒストグラム
        // 3. RSI(14)

        const traces = [
            // (1) ローソク足
            {
                type: "candlestick",
                x: times,
                open: opens,
                high: highs,
                low: lows,
                close: closes,
                name: "OHLC",
                increasing: { line: { color: "#00e676", width: 1.5 }, fillcolor: "rgba(0, 230, 118, 0.4)" },
                decreasing: { line: { color: "#ff5252", width: 1.5 }, fillcolor: "rgba(255, 82, 82, 0.4)" },
                xaxis: "x",
                yaxis: "y"
            },
            // (2) EMA10
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
            // (3) EMA25
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
            // (4) 買いシグナルマーカー (▲)
            {
                type: "scatter",
                mode: "markers",
                x: buyTimes,
                y: buyPrices,
                name: "BUY シグナル (▲)",
                marker: { symbol: "triangle-up", size: 12, color: "#00e676", line: { width: 1.5, color: "#ffffff" } },
                hovertext: buySignals.map(s => `【BUY推奨】<br>株価: ¥${s.close}<br>利確目標(+6%): ¥${s.takeProfitPrice.toFixed(1)}<br>損切ライン(-2.5%): ¥${s.stopLossPrice.toFixed(1)}`),
                hoverinfo: "text",
                xaxis: "x",
                yaxis: "y"
            },
            // (5) MACD ヒストグラム (サブプロット2)
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
            },
            // (6) RSI(14) (サブプロット3)
            {
                type: "scatter",
                mode: "lines",
                x: times,
                y: rsi,
                name: "RSI(14)",
                line: { color: "#ffd740", width: 1.8 },
                xaxis: "x",
                yaxis: "y3"
            }
        ];

        // 保有中ポジションの損切り・利確・買値ラインおよび領域シェード
        const shapes = [
            // RSI 70過熱ライン & 30売られすぎライン & 48基準ライン
            { type: "line", x0: times[0], x1: times[times.length - 1], y0: 70, y1: 70, yref: "y3", line: { color: "rgba(255, 82, 82, 0.4)", dash: "dot", width: 1 } },
            { type: "line", x0: times[0], x1: times[times.length - 1], y0: 48, y1: 48, yref: "y3", line: { color: "rgba(0, 229, 255, 0.6)", dash: "dash", width: 1 } },
            { type: "line", x0: times[0], x1: times[times.length - 1], y0: 30, y1: 30, yref: "y3", line: { color: "rgba(0, 230, 118, 0.4)", dash: "dot", width: 1 } }
        ];

        const annotations = [];

        if (activePosition) {
            const fallbackPrice = closes[closes.length - 1] || 500;
            const entryP = Number(activePosition.entryPrice) || fallbackPrice;
            const tpP = Number(activePosition.takeProfitPrice) || (entryP * 1.06);
            const slP = Number(activePosition.stopLossPrice) || (entryP * 0.975);
            const posShares = Number(activePosition.shares) || 100;
            const lastTime = times[times.length - 1];

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
                line: { color: "#00e5ff", dash: "solid", width: 2 }
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

            // アノテーションラベル（右端に価格と目標を明示）
            annotations.push({
                x: lastTime, y: tpP, xref: "x", yref: "y",
                text: `🎯 利確目標: ¥${tpP.toFixed(1)} (+6.0%)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#00e676",
                ax: 60, ay: 0,
                bgcolor: "#00e676", font: { color: "#0b0f19", size: 11 },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: entryP, xref: "x", yref: "y",
                text: `💼 買値: ¥${entryP.toLocaleString()} (${posShares}株)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#00e5ff",
                ax: 60, ay: 0,
                bgcolor: "#00e5ff", font: { color: "#0b0f19", size: 11 },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            annotations.push({
                x: lastTime, y: slP, xref: "x", yref: "y",
                text: `🛑 損切ライン: ¥${slP.toFixed(1)} (-2.5%)`,
                showarrow: true, arrowhead: 2, arrowsize: 1, arrowcolor: "#ff5252",
                ax: 60, ay: 0,
                bgcolor: "#ff5252", font: { color: "#ffffff", size: 11 },
                bordercolor: "#ffffff", borderwidth: 1, borderpad: 4
            });

            // エントリー日時の足へのマーカー
            if (activePosition.entryTime) {
                const entryCandleTime = String(activePosition.entryTime).substring(0, 16);
                annotations.push({
                    x: entryCandleTime, y: entryP, xref: "x", yref: "y",
                    text: `◆ ENTRY 約定<br>¥${entryP.toLocaleString()}`,
                    showarrow: true, arrowhead: 3, arrowcolor: "#00e5ff",
                    ax: 0, ay: -35,
                    bgcolor: "rgba(0, 229, 255, 0.9)", font: { color: "#0b0f19", size: 10 },
                    bordercolor: "#ffffff", borderwidth: 1, borderpad: 3
                });
            }
        }

        const layout = {
            template: "plotly_dark",
            paper_bgcolor: "#0b0f19",
            plot_bgcolor: "#111827",
            margin: { l: 45, r: 120, t: 30, b: 35 },
            height: window.innerWidth < 768 ? 480 : 580,
            showlegend: window.innerWidth >= 768,
            legend: { orientation: "h", y: 1.05, x: 1, xanchor: "right" },
            hovermode: "x unified",
            xaxis: {
                rangeslider: { visible: false },
                gridcolor: "#1f293d",
                domain: [0, 1]
            },
            yaxis: {
                domain: [0.45, 1.0],
                gridcolor: "#1f293d",
                title: "株価 (円)"
            },
            yaxis2: {
                domain: [0.22, 0.40],
                gridcolor: "#1f293d",
                title: "MACD"
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
            displayModeBar: false,
            scrollZoom: true
        };

        Plotly.newPlot(this.containerId, traces, layout, config);
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

        const layout = {
            template: "plotly_dark",
            paper_bgcolor: "#0b0f19",
            plot_bgcolor: "#111827",
            margin: { l: 60, r: 80, t: 40, b: 40 },
            height: window.innerWidth < 768 ? 480 : 580,
            showlegend: true,
            legend: { orientation: "h", y: 1.05, x: 1, xanchor: "right" },
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
            displayModeBar: false,
            scrollZoom: true
        };

        Plotly.newPlot(this.containerId, traces, layout, config);
    }
}

window.TradingChart = TradingChart;
