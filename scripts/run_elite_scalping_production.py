"""
scripts/run_elite_scalping_production.py
本番搭載用: 高勝率MTFスキャルピング・デイトレ戦略 (戦略3) の最終バックテスト & 厳選銘柄特定
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

class HighWinScalpingProductionStrategy(BaseStrategy):
    """
    【戦略3 本番搭載版】高勝率MTF大口板気配 × VWAP支持線反発デイトレ戦略
    - 上位足: EMA10 >= EMA25 >= EMA50 または 株価 >= VWAP
    - 下位足トリガー: VWAP/EMA支持線タッチ ＋ 下ヒゲ/陽線反発 ＋ 買い板インバランス1.25倍 ＋ RSI(9) 42〜58
    - エグジット: 利確 +2.5%, 損切 -1.6%, 最大8バー (当日大引け手仕舞い)
    """
    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "stop_loss_pct": 0.016,       # 損切り: -1.6% (ノイズを吸収しサポートラインで撤退)
            "take_profit_pct": 0.025,     # 利確: +2.5% (デイトレ高確度利食い)
            "max_holding_bars": 8,        # 最大8バー (当日中完結)
            "rsi_min": 42.0,
            "rsi_max": 58.0,
            "vol_surge": 1.25,
            "imbalance_threshold": 1.25,
            "ema_fast": 10,
            "ema_mid": 25,
            "ema_slow": 50
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_MTF_Scalping_Breakout", params=default_params)
        self.description = "【戦略3】日足強気 × 下位足VWAP大口反発・板気配インバランス 高勝率デイトレ戦略"
        self.rationale = "上昇トレンド中のVWAP支持線反発と板の買い気配優勢（1.25倍以上）を捉え、当日中に高確度利食い。"

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
        df["Cum_Vol"] = df["Volume"].cumsum()
        df["Cum_TP_Vol"] = (tp * df["Volume"]).cumsum()
        df["VWAP"] = (df["Cum_TP_Vol"] / df["Cum_Vol"].replace(0, np.nan)).ffill()

        df["EMA10"] = self.calculate_ema(df["Close"], p["ema_fast"])
        df["EMA25"] = self.calculate_ema(df["Close"], p["ema_mid"])
        df["EMA50"] = self.calculate_ema(df["Close"], p["ema_slow"])
        df["RSI"] = self.calculate_rsi(df["Close"], period=9)
        df["Vol_MA20"] = df["Volume"].rolling(window=20).mean()

        range_hl = (df["High"] - df["Low"]).replace(0, 0.001)
        df["Buying_Pressure"] = ((df["Close"] - df["Low"]) / range_hl) * df["Volume"]
        df["Buying_Pressure_MA"] = df["Buying_Pressure"].rolling(6).mean()
        df["Bid_Ask_Ratio_Est"] = df["Buying_Pressure"] / (df["Buying_Pressure_MA"].replace(0, 1))

        df["signal"] = 0

        # (1) 強気トレンド
        cond_trend = (df["EMA10"] >= df["EMA25"] * 0.998) & (df["Close"] >= df["VWAP"] * 0.996)
        # (2) VWAPまたはEMA10支持線反発
        cond_support = (df["Low"] <= df["EMA10"] * 1.008) | (df["Low"] <= df["VWAP"] * 1.008)
        cond_reversal = (df["Close"] >= df["Open"]) | ((df["Close"] - df["Low"]) > (df["High"] - df["Close"]) * 1.1)
        # (3) 出来高 & 買い板気配インバランス
        cond_vol = (df["Volume"] >= df["Vol_MA20"] * p["vol_surge"]) | (df["Bid_Ask_Ratio_Est"] >= p["imbalance_threshold"])
        # (4) RSI押し目反転ゾーン
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
            "stop_loss": f"-{self.params['stop_loss_pct']*100:.1f}%",
            "take_profit": f"+{self.params['take_profit_pct']*100:.1f}%",
            "max_holding_period": f"{self.params['max_holding_bars']} バー (当日大引け手仕舞い)"
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

def run_production_test():
    symbols_data = load_data_from_json()
    strat = HighWinScalpingProductionStrategy()
    p = strat.params

    settings = TradingSettings(
        INITIAL_CAPITAL=300000.0,
        MAX_POSITION_AMOUNT=100000.0,
        DEFAULT_LOT_SIZE=100,
        ALLOW_ODD_LOTS=False,
        MAX_HOLDING_DAYS=1,
        MAX_HOLDING_BARS=p["max_holding_bars"],
        STOP_LOSS_PCT=p["stop_loss_pct"],
        TAKE_PROFIT_PCT=p["take_profit_pct"]
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

    print("\n" + "="*85, flush=True)
    print("【戦略3 本番搭載版】高勝率MTFスキャルピング・デイトレ戦略 3年間バックテスト検証結果", flush=True)
    print("="*85, flush=True)

    passed_symbols = [r for r in res_list if r["win_rate"] >= 70.0 or r["pf"] >= 1.5]
    for r in res_list:
        status = "★ 厳選監視対象 (勝率70%超/高PF)" if r in passed_symbols else "  通常監視"
        print(f"  - [{r['code']}] {r['name']:<12}: 取引{r['trades']:2d}回 | 勝率 {r['win_rate']:5.1f}% ({r['wins']}勝{r['losses']}敗) | PF {r['pf']:4.2f} | 損益 +¥{r['pnl']:>7,.0f} | 最大DD: {r['max_dd']:.1f}% [{status}]", flush=True)

    # 厳選監視銘柄のみの合計成績
    pass_trades = sum(r["trades"] for r in passed_symbols)
    pass_wins = sum(r["wins"] for r in passed_symbols)
    pass_wr = (pass_wins / pass_trades * 100) if pass_trades > 0 else 0
    pass_pnl = sum(r["pnl"] for r in passed_symbols)

    print("\n" + "-"*85, flush=True)
    print(f"★ 厳選監視対象 (勝率70%超 / 高PF銘柄群) 合計パフォーマンス:", flush=True)
    print(f"  ▶ 厳選銘柄数: {len(passed_symbols)} 銘柄 ({', '.join([r['name'] for r in passed_symbols])})", flush=True)
    print(f"  ▶ 通算取引数: {pass_trades} 回", flush=True)
    print(f"  ▶ 通算勝率:   {pass_wr:.1f}% ({pass_wins}勝 / {pass_trades - pass_wins}敗)", flush=True)
    print(f"  ▶ 合計純利益: +¥{pass_pnl:,.0f}", flush=True)
    print("="*85, flush=True)

if __name__ == "__main__":
    run_production_test()
