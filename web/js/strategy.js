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
 * 【戦略3】プロ仕様 高速スキャルピング・利益ロック＆勝ち逃げデイトレ戦略 (MTFScalpingStrategy)
 * - 上位足トレンド × 下位足VWAP/EMA10支持線反発 ＋ 買い板気配急増（1.20倍以上） ＋ 短期RSI(9) 44〜62
 * - 利食い: +1.5% (高速利食い)
 * - プロフィットロック: 含み益+0.7%到達で損切りを買値+0.1%へ引き上げ（損失転落完全防止）
 * - 動的トレーリング利食い: +1.0%到達後、ピーク最高値から-0.3%反落で勝ち逃げ成行利食い
 * - 損切り: -1.2%
 * - 最大保有: 6バー (短時間完結・当日大引け手仕舞い・持ち越しゼロ)
 */
class MTFScalpingStrategy {
    constructor(params = {}) {
        this.params = Object.assign({
            stopLossPct: 0.012,        // 損切り: -1.2%
            takeProfitPct: 0.015,      // 基本利確目標: +1.5% (高速利食い)
            profitLockTrigger: 0.007,  // プロフィットロック発動: +0.7% 到達
            profitLockPricePct: 0.001, // ロック後損切り: 買値+0.1% (同値微益ガード)
            trailingTriggerPct: 0.010, // トレーリング発動: +1.0% 到達
            trailingFallPct: 0.003,    // ピークから-0.3%反落で勝ち逃げ利食い
            maxHoldingBars: 6,         // 最大保有: 6バー (短時間完結・当日大引け手仕舞い)
            maxBudget: 100000.0,       // 1回の投資上限: 10万円
            rsiPeriod: 9,
            rsiMin: 44.0,
            rsiMax: 62.0,
            emaFast: 5,
            emaMid: 10,
            emaSlow: 25,
            imbalanceThreshold: 1.20
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

    calculateRSI(prices, period = 9) {
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

    calculateVWAP(candles) {
        let cumVol = 0;
        let cumTpVol = 0;
        return candles.map(c => {
            const vol = Number(c.volume) || 1000;
            const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
            cumVol += vol;
            cumTpVol += (tp * vol);
            return cumVol > 0 ? (cumTpVol / cumVol) : Number(c.close);
        });
    }

    analyzeCandles(candles) {
        if (!candles || candles.length < 20) return [];

        const closePrices = candles.map(c => Number(c.close));
        const highPrices = candles.map(c => Number(c.high));
        const lowPrices = candles.map(c => Number(c.low));

        const ema5 = this.calculateEMA(closePrices, this.params.emaFast);
        const ema10 = this.calculateEMA(closePrices, this.params.emaMid);
        const ema25 = this.calculateEMA(closePrices, this.params.emaSlow);
        const rsi = this.calculateRSI(closePrices, this.params.rsiPeriod);
        const vwap = this.calculateVWAP(candles);

        // 出来高移動平均
        const volMa15 = candles.map((c, i) => {
            if (i < 14) return Number(c.volume) || 1000;
            let sum = 0;
            for (let j = i - 14; j <= i; j++) sum += (Number(candles[j].volume) || 1000);
            return sum / 15;
        });

        return candles.map((c, i) => {
            const currentClose = Number(c.close);
            const currentOpen = Number(c.open);
            const currentLow = Number(c.low);
            const currentHigh = Number(c.high);
            const currentVol = Number(c.volume) || 0;

            // 板気配インバランス比率
            const bidAskRatio = c.bid_ask_imbalance !== undefined ? Number(c.bid_ask_imbalance) : (c.bidAskRatio !== undefined ? Number(c.bidAskRatio) : 1.25);

            // (1) 大局・超短期トレンド同期 (EMA5 >= EMA10 または 終値 >= VWAP)
            const isTrendBullish = (ema5[i] >= ema10[i] * 0.999) && (currentClose >= vwap[i] * 0.998);
            // (2) 短期押し目反発 (EMA10またはVWAP支持線タッチ反発)
            const isSupportTouch = (currentLow <= ema10[i] * 1.006) || (currentLow <= vwap[i] * 1.006);
            // (3) 陽線または強反発下ヒゲ
            const isCandleValid = (currentClose >= currentOpen) || ((currentClose - currentLow) > (currentHigh - currentClose) * 1.1);
            // (4) 出来高動意 or 板気配インバランス急増 (1.20倍以上)
            const isOrderBookValid = (currentVol >= volMa15[i] * 1.1) || (bidAskRatio >= this.params.imbalanceThreshold);
            // (5) RSI健全圏 (44〜62)
            const isRsiValid = rsi[i] !== null && rsi[i] >= this.params.rsiMin && rsi[i] <= this.params.rsiMax;

            const isBuySignal = isTrendBullish && isSupportTouch && isCandleValid && isOrderBookValid && isRsiValid;

            return {
                time: c.time,
                open: currentOpen,
                high: currentHigh,
                low: currentLow,
                close: currentClose,
                volume: currentVol,
                vwap: vwap[i],
                ema5: ema5[i],
                ema10: ema10[i],
                ema25: ema25[i],
                rsi: rsi[i],
                bidAskRatio: bidAskRatio,
                isBuySignal: isBuySignal,
                stopLossPrice: currentClose * (1 - this.params.stopLossPct),
                takeProfitPrice: currentClose * (1 + this.params.takeProfitPct),
                profitLockTriggerPrice: currentClose * (1 + this.params.profitLockTrigger),
                trailingTriggerPrice: currentClose * (1 + this.params.trailingTriggerPct),
                strategyName: "HighWin_MTF_Scalping_Breakout"
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
 * 戦略レジストリ・マネージャー (個別監視ON/OFF対応)
 */
class StrategyRegistry {
    constructor() {
        this.strategies = {
            "triple_confluence": {
                id: "triple_confluence",
                name: "HighWin_TripleConfluence",
                displayName: "【戦略1】TripleConfluence (EMA×MACD×RSI同期)",
                shortName: "戦略1: スイング",
                badgeColor: "#00e5ff",
                description: "EMA10/25ゴールデンクロス × MACD好転 × RSIモメンタムの3指標合致によるダマシ排除スイング戦略 (利確+6% / 損切-2.5% / 最大3日)",
                enabled: true,
                instance: new TripleConfluenceStrategy()
            },
            "orderbook_vwap": {
                id: "orderbook_vwap",
                name: "HighWin_OrderBook_VWAP_Pullback",
                displayName: "【戦略2】板気配インバランス × VWAP反発押し目",
                shortName: "戦略2: 板気配VWAP",
                badgeColor: "#b388ff",
                description: "大局上昇トレンド中のVWAP支持線タッチ ＋ 買い板気配急増(大口買い支え)を狙う高勝率スイング戦略 (利確+6% / 損切-2.5% / 最大3日)",
                enabled: true,
                instance: new OrderBookVWAPPullbackStrategy()
            },
            "mtf_scalping": {
                id: "mtf_scalping",
                name: "HighWin_MTF_Scalping_Breakout",
                displayName: "【戦略3】プロ仕様 高速スキャルピング・利益ロック＆勝ち逃げデイトレ",
                shortName: "戦略3: プロスキャル",
                badgeColor: "#ffd740",
                description: "短期VWAP反発・板気配急増でエントリー。含み益+0.7%で買値プロフィットロック、+1.0%後反落で動的トレーリング利食い、基本目標+1.5%で素早く利確（当日大引け手仕舞い・持ち越しゼロ）",
                enabled: true,
                instance: new MTFScalpingStrategy()
            }
        };
        this.activeStrategyId = "mtf_scalping"; // デフォルトでプロスキャルピング戦略をアクティブに
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

    setStrategyEnabled(id, enabled) {
        if (this.strategies[id]) {
            this.strategies[id].enabled = Boolean(enabled);
            return true;
        }
        return false;
    }

    isStrategyEnabled(id) {
        return this.strategies[id] ? Boolean(this.strategies[id].enabled) : false;
    }

    getEnabledStrategies() {
        return Object.values(this.strategies).filter(s => s.enabled);
    }

    getStrategyList() {
        return Object.values(this.strategies);
    }

    getStrategyToggles() {
        const toggles = {};
        Object.keys(this.strategies).forEach(id => {
            toggles[id] = this.strategies[id].enabled;
        });
        return toggles;
    }

    loadStrategyToggles(toggles) {
        if (!toggles || typeof toggles !== "object") return;
        Object.keys(toggles).forEach(id => {
            if (this.strategies[id]) {
                this.strategies[id].enabled = Boolean(toggles[id]);
            }
        });
    }
}

// グローバル公開
window.TripleConfluenceStrategy = TripleConfluenceStrategy;
window.OrderBookVWAPPullbackStrategy = OrderBookVWAPPullbackStrategy;
window.MTFScalpingStrategy = MTFScalpingStrategy;
window.StrategyRegistry = StrategyRegistry;
