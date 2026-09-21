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
     * 推奨ポジションサイズ（株数と投資額）を計算 (100株単元株のみ・複利再投資対応)
     */
    calculateOrderSize(price, availableCash = 300000.0, compoundingEnabled = true) {
        if (!price || price <= 0) {
            return { shares: 0, investment: 0, isUnitLot: false, note: "価格取得エラー" };
        }

        const lotCost = price * 100;
        if (lotCost > availableCash) {
            return {
                shares: 0,
                investment: 0,
                isUnitLot: false,
                note: `資金不足 (100株単元 ¥${Math.round(lotCost).toLocaleString()} > 残高 ¥${Math.round(availableCash).toLocaleString()})`
            };
        }

        // 複利運用モード (ON) の場合は運用残高の約35%を上限にロットを自動拡大 (OFFの場合は1回10万円上限)
        let budget;
        if (compoundingEnabled) {
            const dynamicLimit = Math.max(100000.0, availableCash * 0.35);
            budget = Math.min(dynamicLimit, availableCash);
        } else {
            budget = Math.min(this.params.maxBudget, availableCash);
        }

        // 100株単元（単元未満株は完全排除）
        const maxLots = Math.floor(budget / lotCost);
        const shares = Math.max(100, maxLots * 100);
        
        // 残高超過防止
        const finalShares = (shares * price <= availableCash) ? shares : Math.floor(availableCash / lotCost) * 100;
        const investment = Math.round(finalShares * price);

        if (finalShares <= 0) {
            return { shares: 0, investment: 0, isUnitLot: false, note: `購入不可 (残高 ¥${Math.round(availableCash).toLocaleString()})` };
        }

        return {
            shares: finalShares,
            investment: investment,
            isUnitLot: true,
            note: `${finalShares}株 (100株単元・${compoundingEnabled ? '複利運用' : '固定枠'})`
        };
    }
}

/**
 * 戦略2: 板気配インバランス × VWAP反発押し目戦略 (OrderBookVWAPPullbackStrategy)
 * - 日足・1h足強気環境 (EMA20 > EMA50)
 * - VWAP支持線への押し目タッチ
 * - 板気配インバランス (買い板優勢 1.25倍以上)
 * - 下ヒゲ陽線反発 ＋ RSI健全押し目 (42〜58)
 */
class OrderBookVWAPPullbackStrategy {
    constructor(params = {}) {
        this.id = "orderbook_vwap";
        this.name = "HighWin_OrderBook_VWAP_Pullback";
        this.displayName = "【戦略2】板気配インバランス × VWAP反発押し目";
        this.description = "大局上昇トレンド中のVWAP支持線タッチ ＋ 買い板気配急増(大口買い支え)を狙う高勝率スイング戦略";
        this.params = Object.assign({
            emaFast: 20,
            emaSlow: 50,
            rsiPeriod: 14,
            rsiMin: 42.0,
            rsiMax: 58.0,
            imbalanceThreshold: 1.25,
            stopLossPct: 0.025,
            takeProfitPct: 0.060,
            maxHoldingBars: 15,
            maxBudget: 100000.0
        }, params);
    }

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

    calculateRSI(prices, period = 14) {
        const rsiArray = new Array(prices.length).fill(null);
        if (prices.length <= period) return rsiArray;

        let gains = 0, losses = 0;
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

    analyzeCandles(candles) {
        if (!candles || candles.length < 30) return [];

        const closePrices = candles.map(c => c.close);
        const ema20 = this.calculateEMA(closePrices, this.params.emaFast);
        const ema50 = this.calculateEMA(closePrices, this.params.emaSlow);
        const rsi = this.calculateRSI(closePrices, this.params.rsiPeriod);

        // 1. VWAP の累積計算
        let cumVol = 0;
        let cumTpVol = 0;
        const vwap = [];

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const tp = (c.high + c.low + c.close) / 3.0;
            const vol = c.volume || 1000;
            cumVol += vol;
            cumTpVol += (tp * vol);
            vwap.push(cumVol > 0 ? (cumTpVol / cumVol) : c.close);
        }

        // 2. 板気配・出来高インバランス推計指標
        const buyPressures = candles.map(c => {
            const range = Math.max(0.1, c.high - c.low);
            const vol = c.volume || 1000;
            return ((c.close - c.low) / range) * vol;
        });

        const bidAskRatios = buyPressures.map((bp, i) => {
            if (i < 9) return 1.0;
            let sum = 0;
            for (let j = i - 9; j <= i; j++) sum += buyPressures[j];
            const ma = sum / 10;
            return ma > 0 ? (bp / ma) : 1.0;
        });

        // 3. 出来高20期間平均
        const volMa20 = candles.map((c, i) => {
            if (i < 19) return c.volume;
            let sum = 0;
            for (let j = i - 19; j <= i; j++) sum += candles[j].volume;
            return sum / 20;
        });

        return candles.map((c, i) => {
            const isTrend = ema20[i] >= ema50[i] * 0.998;
            const isVwapSupport = (c.low <= vwap[i] * 1.012) && (c.close >= vwap[i] * 0.992);
            const isReversal = (c.close >= c.open) || ((c.close - c.low) > (c.high - c.close));
            const isOrderBookBullish = bidAskRatios[i] >= this.params.imbalanceThreshold;
            const isRsiValid = rsi[i] !== null && rsi[i] >= this.params.rsiMin && rsi[i] <= this.params.rsiMax;
            const isVolValid = c.volume >= volMa20[i] * 0.8;

            const isBuySignal = isTrend && isVwapSupport && isReversal && isOrderBookBullish && isRsiValid && isVolValid;

            return {
                ...c,
                ema20: ema20[i],
                ema50: ema50[i],
                vwap: vwap[i],
                rsi: rsi[i] || 50,
                bidAskRatio: parseFloat(bidAskRatios[i].toFixed(2)),
                isBuySignal: isBuySignal,
                stopLossPrice: c.close * (1 - this.params.stopLossPct),
                takeProfitPrice: c.close * (1 + this.params.takeProfitPct)
            };
        });
    }

    calculateOrderSize(price, availableCash = 300000.0, compoundingEnabled = true) {
        if (!price || price <= 0) {
            return { shares: 0, investment: 0, isUnitLot: false, note: "価格取得エラー" };
        }

        const lotCost = price * 100;
        if (lotCost > availableCash) {
            return {
                shares: 0,
                investment: 0,
                isUnitLot: false,
                note: `資金不足 (100株単元 ¥${Math.round(lotCost).toLocaleString()} > 残高 ¥${Math.round(availableCash).toLocaleString()})`
            };
        }

        let budget;
        if (compoundingEnabled) {
            const dynamicLimit = Math.max(100000.0, availableCash * 0.35);
            budget = Math.min(dynamicLimit, availableCash);
        } else {
            budget = Math.min(this.params.maxBudget, availableCash);
        }

        const maxLots = Math.floor(budget / lotCost);
        const shares = Math.max(100, maxLots * 100);
        const finalShares = (shares * price <= availableCash) ? shares : Math.floor(availableCash / lotCost) * 100;
        const investment = Math.round(finalShares * price);

        if (finalShares <= 0) {
            return { shares: 0, investment: 0, isUnitLot: false, note: `購入不可 (残高 ¥${Math.round(availableCash).toLocaleString()})` };
        }

        return {
            shares: finalShares,
            investment: investment,
            isUnitLot: true,
            note: `${finalShares}株 (100株単元・${compoundingEnabled ? '複利運用' : '固定枠'})`
        };
    }
}

/**
 * 戦略レジストリ・マネージャー
 */
class StrategyRegistry {
    constructor() {
        this.strategies = {
            "triple_confluence": {
                id: "triple_confluence",
                name: "HighWin_TripleConfluence",
                displayName: "【戦略1】TripleConfluence (EMA×MACD×RSI同期)",
                description: "EMA10/25ゴールデンクロス × MACD好転 × RSIモメンタムの3指標合致によるダマシ排除スイング戦略",
                instance: new TripleConfluenceStrategy()
            },
            "orderbook_vwap": {
                id: "orderbook_vwap",
                name: "HighWin_OrderBook_VWAP_Pullback",
                displayName: "【戦略2】板気配インバランス × VWAP反発押し目",
                description: "大局上昇トレンド中のVWAP支持線タッチ ＋ 買い板気配急増(大口買い支え)を狙う高勝率スイング戦略",
                instance: new OrderBookVWAPPullbackStrategy()
            }
        };
        this.activeStrategyId = "triple_confluence";
    }

    getActiveStrategy() {
        return this.strategies[this.activeStrategyId] ? this.strategies[this.activeStrategyId].instance : this.strategies["triple_confluence"].instance;
    }

    getActiveStrategyMeta() {
        return this.strategies[this.activeStrategyId] || this.strategies["triple_confluence"];
    }

    setActiveStrategy(id) {
        if (this.strategies[id]) {
            this.activeStrategyId = id;
            return true;
        }
        return false;
    }

    getStrategyList() {
        return Object.values(this.strategies);
    }
}

// グローバル公開
window.TripleConfluenceStrategy = TripleConfluenceStrategy;
window.OrderBookVWAPPullbackStrategy = OrderBookVWAPPullbackStrategy;
window.StrategyRegistry = StrategyRegistry;
