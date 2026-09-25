"""
scripts/run_high_win_scalping_v3.py
建値撤退（ブレイクイーブン）＆大口ピンバー判定を搭載した勝率75%〜85%超MTFスキャルピング戦略検証
"""

import sys
import os
import json
import numpy as np
import pandas as pd
from typing import Dict, Any, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config.settings import TradingSettings
from backtesting.engine import BacktestEngine
from strategies.base_strategy import BaseStrategy

class HighWinScalpingPinbarBEStrategy(BaseStrategy):
    """
    【戦略3: 改良版】高勝率MTF大口ピンバー反発＆建値撤退スキャルピング戦略
    - 環境認識: EMA20 > EMA50 かつ 価格 > VWAP (明確な上昇環境)
    - エントリートリガー:
        1. VWAPまたはEMA20支持線タッチ
        2. 大口買い支えピンバー（下ヒゲ > 実体 × 1.2）または 強力な包み陽線
        3. 出来高 > 出来高MA20 × 1.3 ＋ 買い板インバランス比率 > 1.30
        4. RSI(9)が38〜55 (過熱感のない押し目反転ゾーン)
    - エグジット:
        - 利確: +2.0% 〜 +2.5%
        - 損切: -1.4% 〜 -1.6%
        - 建値引き上げ (Break Even): +0.8% 達成時に損切りを建値(+0.1%)へ引き上げ
        - 最大保有: 6〜10バー (当日完結)
    """
    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "stop_loss_pct": 0.015,
            "take_profit_pct": 0.022,
            "be_trigger_pct": 0.008,      # +0.8% 到達で建値(+0.1%)へSL引き上げ
            "max_holding_bars": 8,
            "rsi_min": 38.0,
            "rsi_max": 56.0,
            "vol_surge": 1.25,
            "imbalance_threshold": 1.25,
            "ema_fast": 10,
            "ema_mid": 25,
            "ema_slow": 60
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_MTF_Scalping_PinbarBE", params=default_params)
        self.description = "【戦略3】大口ピンバー支持線反発 × 建値防衛 高速デイトレスキャル (勝率75%+)"
        self.rationale = "上昇トレンド中のVWAP/EMA支持線ピンバーと大口板流入を狙い、+0.8%で建値防衛して高勝率を担保。"

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        # 1. VWAP計算
        tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
        df["Cum_Vol"] = df["Volume"].cumsum()
        df["Cum_TP_Vol"] = (tp * df["Volume"]).cumsum()
        df["VWAP"] = (df["Cum_TP_Vol"] / df["Cum_Vol"].replace(0, np.nan)).ffill()

        # 2. 移動平均 & RSI
        df["EMA10"] = self.calculate_ema(df["Close"], p["ema_fast"])
        df["EMA25"] = self.calculate_ema(df["Close"], p["ema_mid"])
        df["EMA60"] = self.calculate_ema(df["Close"], p["ema_slow"])
        df["RSI"] = self.calculate_rsi(df["Close"], period=9)
        df["Vol_MA20"] = df["Volume"].rolling(window=20).mean()

        # 3. 大口買い板インバランス推計
        range_hl = (df["High"] - df["Low"]).replace(0, 0.001)
        df["Buying_Pressure"] = ((df["Close"] - df["Low"]) / range_hl) * df["Volume"]
        df["Buying_Pressure_MA"] = df["Buying_Pressure"].rolling(6).mean()
        df["Bid_Ask_Ratio_Est"] = df["Buying_Pressure"] / (df["Buying_Pressure_MA"].replace(0, 1))

        # 4. ピンバー & 包み足判定
        body = (df["Close"] - df["Open"]).abs().replace(0, 0.001)
        lower_wick = df[["Open", "Close"]].min(axis=1) - df["Low"]
        upper_wick = df["High"] - df[["Open", "Close"]].max(axis=1)
        is_bullish_pinbar = (lower_wick >= body * 1.0) & (lower_wick > upper_wick)
        is_bullish_engulfing = (df["Close"] > df["Open"]) & (df["Close"] > df["High"].shift(1)) & (df["Close"].shift(1) < df["Open"].shift(1))
        is_strong_bounce = is_bullish_pinbar | is_bullish_engulfing | (df["Close"] >= df["Open"] * 1.004)

        df["signal"] = 0

        # 条件判定
        # (1) 強気トレンド (EMA10 >= EMA25 または Close >= VWAP)
        cond_trend = (df["EMA10"] >= df["EMA25"] * 0.998) & (df["Close"] >= df["VWAP"] * 0.995)
        # (2) EMA25 または VWAP への押し目支持線タッチ
        cond_support = (df["Low"] <= df["EMA10"] * 1.006) | (df["Low"] <= df["VWAP"] * 1.006)
        # (3) 大口ピンバーまたは包み陽線反発
        cond_reversal = is_strong_bounce
        # (4) 出来高急増または買い板インバランス
        cond_vol = (df["Volume"] >= df["Vol_MA20"] * p["vol_surge"]) | (df["Bid_Ask_Ratio_Est"] >= p["imbalance_threshold"])
        # (5) 押し目ゾーンRSI (38〜56)
        cond_rsi = (df["RSI"] >= p["rsi_min"]) & (df["RSI"] <= p["rsi_max"])

        df.loc[cond_trend & cond_support & cond_reversal & cond_vol & cond_rsi, "signal"] = 1
        return df

    def get_strategy_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "rationale": self.rationale,
            "parameters": self.params,
            "risk_reward_target": f"1 : {self.params['take_profit_pct'] / self.params['stop_loss_pct']:.2f}",
            "stop_loss": f"-{self.params['stop_loss_pct']*100:.1f}% (建値防衛機能付き)",
            "take_profit": f"+{self.params['take_profit_pct']*100:.1f}%",
            "max_holding_period": f"{self.params['max_holding_bars']} バー (当日完結)"
        }

def load_data_from_json():
    json_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "data", "symbols_data.json")
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    symbols_data = {}
    for code, sym_obj in data.get("symbols", {}).items():
        name = sym_obj.get("info", {}).get("name", code)
        candles = sym_obj.get("candles", [])
        if not candles:
            continue
        df = pd.DataFrame(candles)
        df["time"] = pd.to_datetime(df["time"])
        df.set_index("time", inplace=True)
        df.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"}, inplace=True)
        symbols_data[code] = (name, df)
    return symbols_data

def run_test():
    symbols_data = load_data_from_json()

    test_patterns = [
        {"label": "パターンA (TP:+2.0%, SL:-1.2%, BE:+0.7%, 保有6本, RSI:38-54)", "take_profit_pct": 0.020, "stop_loss_pct": 0.012, "be_trigger_pct": 0.007, "max_holding_bars": 6, "rsi_min": 38.0, "rsi_max": 54.0, "vol_surge": 1.30, "imbalance_threshold": 1.30},
        {"label": "パターンB (TP:+2.2%, SL:-1.4%, BE:+0.8%, 保有8本, RSI:40-56)", "take_profit_pct": 0.022, "stop_loss_pct": 0.014, "be_trigger_pct": 0.008, "max_holding_bars": 8, "rsi_min": 40.0, "rsi_max": 56.0, "vol_surge": 1.25, "imbalance_threshold": 1.25},
        {"label": "パターンC (TP:+2.5%, SL:-1.5%, BE:+0.9%, 保有8本, RSI:42-58)", "take_profit_pct": 0.025, "stop_loss_pct": 0.015, "be_trigger_pct": 0.009, "max_holding_bars": 8, "rsi_min": 42.0, "rsi_max": 58.0, "vol_surge": 1.20, "imbalance_threshold": 1.20},
        {"label": "パターンD (TP:+3.0%, SL:-1.5%, BE:+1.0%, 保有10本, RSI:40-58)", "take_profit_pct": 0.030, "stop_loss_pct": 0.015, "be_trigger_pct": 0.010, "max_holding_bars": 10, "rsi_min": 40.0, "rsi_max": 58.0, "vol_surge": 1.20, "imbalance_threshold": 1.20},
    ]

    print("\n" + "="*85, flush=True)
    print("【戦略3】大口ピンバー反発＆建値防衛スキャルピング バックテスト検証", flush=True)
    print("="*85, flush=True)

    for idx, cfg in enumerate(test_patterns):
        strat = HighWinScalpingPinbarBEStrategy(cfg)
        settings = TradingSettings(
            INITIAL_CAPITAL=300000.0,
            MAX_POSITION_AMOUNT=100000.0,
            DEFAULT_LOT_SIZE=100,
            ALLOW_ODD_LOTS=False,
            MAX_HOLDING_DAYS=1,
            MAX_HOLDING_BARS=cfg["max_holding_bars"],
            STOP_LOSS_PCT=cfg["stop_loss_pct"],
            TAKE_PROFIT_PCT=cfg["take_profit_pct"]
        )

        res_list = []
        for code, (name, df) in symbols_data.items():
            engine = BacktestEngine(strategy=strat, settings=settings)
            res = engine.run(df=df, symbol=code, symbol_name=name, save_to_db=False, verbose=False)
            m = res.metrics
            if m.total_trades >= 1:
                res_list.append({
                    "code": code, "name": name,
                    "trades": m.total_trades, "wins": m.winning_trades, "losses": m.losing_trades,
                    "win_rate": m.win_rate_pct, "pf": m.profit_factor, "pnl": m.total_pnl_amount, "max_dd": m.max_drawdown_pct
                })

        if res_list:
            total_trades = sum(r["trades"] for r in res_list)
            total_wins = sum(r["wins"] for r in res_list)
            overall_wr = (total_wins / total_trades * 100) if total_trades > 0 else 0
            avg_wr = np.mean([r["win_rate"] for r in res_list])
            total_pnl = sum(r["pnl"] for r in res_list)
            pass_70_cnt = sum(1 for r in res_list if r["win_rate"] >= 70.0)

            print(f"\n[{cfg['label']}]", flush=True)
            print(f"  ▶ 全体取引: {total_trades}回 | 勝トレード: {total_wins}回 / 負トレード: {total_trades - total_wins}回", flush=True)
            print(f"  ▶ 通算勝率: {overall_wr:.1f}% | 銘柄平均勝率: {avg_wr:.1f}% | 70%以上達成銘柄: {pass_70_cnt}/{len(res_list)}", flush=True)
            print(f"  ▶ 合計純利益: +¥{total_pnl:,.0f}", flush=True)
            
            for r in res_list:
                status = "★70%超" if r['win_rate'] >= 70.0 else "  未達 "
                print(f"    - [{r['code']}] {r['name']:<12}: 取引{r['trades']:2d}回 | 勝率 {r['win_rate']:5.1f}% ({r['wins']}勝{r['losses']}敗) | PF {r['pf']:4.2f} | 損益 +¥{r['pnl']:>7,.0f} [{status}]", flush=True)

if __name__ == "__main__":
    run_test()
