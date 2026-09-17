/**
 * HighWin_TripleConfluence 戦略計算エンジン (web/js/strategy.js)
 * EMA10/EMA25、MACD、RSIのトリプルコンフルエンスによる買いシグナル検知
 * 損切りライン(-2.5%)、利確ライン(+6.0%)、ポジションサイズ(10万円以内)の計算
 */

class TripleConfluenceStrategy {
    constructor(params = {}) {
        this.params = Object.assign({
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 48.0,
            stopLossPct: 0.025,    // 損切り: -2.5%
            takeProfitPct: 0.060,  // 利確: +6.0% (RR比 2.40:1)
            maxHoldingBars: 15,    // 最大保有: 3営業日 (15バー)
            maxBudget: 100000.0    // 1回の投資上限: 10万円
        }, params);
    }

    /**
     * 指数平滑移動平均 (EMA) を計算
     */
    calculateEMA(prices, period) {
        const k = 2 / (period + 1);
        const emaArray = [];
        let ema = prices[0];
        emaArray.push(ema);

        for (let i = 1; i < prices.length; i++) {
            ema = (prices[i] * k) + (ema * (1 - k));
            emaArray.push(ema);
        }
        return emaArray;
    }

    /**
     * RSI を計算
     */
    calculateRSI(prices, period = 14) {
        const rsiArray = new Array(prices.length).fill(null);
        if (prices.length <= period) return rsiArray;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;
        rsiArray[period] = 100 - (100 / (1 + (avgGain / (avgLoss + 1e-9))));

        for (let i = period + 1; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;

            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;

            const rs = avgGain / (avgLoss + 1e-9);
            rsiArray[i] = 100 - (100 / (1 + rs));
        }

        return rsiArray;
    }

    /**
     * MACD を計算 (Fast 12, Slow 26, Signal 9)
     */
    calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const emaFast = this.calculateEMA(prices, fastPeriod);
        const emaSlow = this.calculateEMA(prices, slowPeriod);
        const macdLine = emaFast.map((f, i) => f - emaSlow[i]);
        const signalLine = this.calculateEMA(macdLine, signalPeriod);
        const histogram = macdLine.map((m, i) => m - signalLine[i]);

        return { macdLine, signalLine, histogram };
    }

    /**
     * ローソク足データセットに対してテクニカル指標と売買シグナルを付与
     */
    analyzeCandles(candles) {
        if (!candles || candles.length < 30) return [];

        const closePrices = candles.map(c => c.close);
        const ema10 = this.calculateEMA(closePrices, this.params.emaShort);
        const ema25 = this.calculateEMA(closePrices, this.params.emaLong);
        const rsi = this.calculateRSI(closePrices, this.params.rsiPeriod);
        const macd = this.calculateMACD(closePrices);

        return candles.map((c, i) => {
            const isEmaBullish = ema10[i] > ema25[i];
            const isMacdBullish = macd.histogram[i] > 0 && (i > 0 ? macd.histogram[i] >= macd.histogram[i - 1] : true);
            const isRsiValid = rsi[i] !== null && rsi[i] >= this.params.rsiThreshold && rsi[i] <= 72.0;
            const isBullishCandle = c.close >= c.open;

            const isBuySignal = isEmaBullish && isMacdBullish && isRsiValid && isBullishCandle;

            return {
                ...c,
                ema10: ema10[i],
                ema25: ema25[i],
                rsi: rsi[i] || 50,
                macd: macd.macdLine[i],
                macdSignal: macd.signalLine[i],
                macdHist: macd.histogram[i],
                isBuySignal: isBuySignal,
                stopLossPrice: c.close * (1 - this.params.stopLossPct),
                takeProfitPrice: c.close * (1 + this.params.takeProfitPct)
            };
        });
    }

    /**
     * 推奨ポジションサイズ（株数と投資額）を計算 (100株単元株のみ・10万円以下厳守)
     */
    calculateOrderSize(price, availableCash = 300000.0) {
        const budget = Math.min(this.params.maxBudget, availableCash);
        const lotCost = price * 100;
        
        if (!price || price <= 0 || lotCost > budget) {
            return {
                shares: 0,
                investment: 0,
                isUnitLot: false,
                note: `購入不可 (100株単元 ¥${Math.round(lotCost).toLocaleString()} > 10万円)`
            };
        }

        // 100株単元（単元未満株は完全排除）
        const maxLots = Math.floor(budget / lotCost);
        const shares = maxLots * 100;
        const investment = Math.round(shares * price);

        return {
            shares: shares,
            investment: investment,
            isUnitLot: true,
            note: `${shares}株 (100株単元)`
        };
    }
}

// グローバル公開
window.TripleConfluenceStrategy = TripleConfluenceStrategy;
