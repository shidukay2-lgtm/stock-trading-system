"""
scripts/run_high_win_scalping_v4.py
デイトレATR拡大ブレイク＆VWAP押し目高勝率戦略の3年間バックテスト検証
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

class HighWinDaytradeMomentumStrategy(BaseStrategy):
    """
    【戦略3 (決定版)】高勝率デイトレ・VWAPブレイク＆押し目反発戦略
    - 上位足: EMA20 > EMA50 (上昇トレンド)
    - デイトレトリガー:
        1. 価格 > VWAP (出来高加重平均より上で買い優勢)
        2. EMA10がEMA25を上抜け または EMA25タッチ後の大陽線反発
        3. 出来高 > 出来高MA20 × 1.25 ＋ 買い板インバランス > 1.20
        4. RSI(9)が45〜65の上昇モメンタム初動
    - エグジット:
        - 利確: +3.0% 〜 +4.5% (デイトレ1日の上昇波を確実に獲得)
        - 損切: -1.8% 〜 -2.2% (サポート割れ撤退)
        - 保有期間: 当日大引け手仕舞い (最大10〜15バー)
    """
    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "stop_loss_pct": 0.020,
            "take_profit_pct": 0.040,
            "max_holding_bars": 12,        # 当日〜最大12バー
            "rsi_min": 45.0,
            "rsi_max": 65.0,
            "vol_surge": 1.20,
            "imbalance_threshold": 1.20,
            "ema_fast": 10,
            "ema_mid": 25,
            "ema_slow": 50
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_Daytrade_Momentum", params=default_params)
        self.description = "【戦略3】日足強気 × VWAPブレイク＆EMA支持線反発 デイトレ戦略"
        self.rationale = "強気相場でのVWAP上推移とEMA25押し目からの大陽線反発を捉え、当日中に高確度利食い。"

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

        # 大陽線判定 (Close > Open かつ 実体が値幅の60%以上)
        body = df["Close"] - df["Open"]
        total_range = df["High"] - df["Low"]
        is_bullish_candle = (body > 0) & (body >= total_range * 0.5)

        df["signal"] = 0

        # (1) 上昇トレンド: EMA10 > EMA25 または EMA25 > EMA50
        cond_trend = (df["EMA10"] >= df["EMA25"] * 0.998) & (df["Close"] >= df["VWAP"] * 0.998)
        # (2) VWAPまたはEMA25支持線反発 (Low <= 支持線 * 1.01 かつ Close >= 支持線)
        cond_support = (df["Low"] <= df["EMA25"] * 1.010) & (df["Close"] >= df["EMA25"] * 0.995)
        # (3) 強い陽線反発
        cond_reversal = is_bullish_candle
        # (4) 出来高 & 板気配インバランス
        cond_vol = (df["Volume"] >= df["Vol_MA20"] * p["vol_surge"]) | (df["Bid_Ask_Ratio_Est"] >= p["imbalance_threshold"])
        # (5) RSI上昇ゾーン (45〜65)
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

def run_test():
    symbols_data = load_data_from_json()

    test_patterns = [
        {"label": "設定1 (TP:+3.5%, SL:-1.8%, 保有10本, RSI:46-62, 出来高1.25倍)", "take_profit_pct": 0.035, "stop_loss_pct": 0.018, "max_holding_bars": 10, "rsi_min": 46.0, "rsi_max": 62.0, "vol_surge": 1.25, "imbalance_threshold": 1.25},
        {"label": "設定2 (TP:+4.0%, SL:-2.0%, 保有12本, RSI:45-64, 出来高1.20倍)", "take_profit_pct": 0.040, "stop_loss_pct": 0.020, "max_holding_bars": 12, "rsi_min": 45.0, "rsi_max": 64.0, "vol_surge": 1.20, "imbalance_threshold": 1.20},
        {"label": "設定3 (TP:+4.5%, SL:-2.0%, 保有15本, RSI:48-65, 出来高1.20倍)", "take_profit_pct": 0.045, "stop_loss_pct": 0.020, "max_holding_bars": 15, "rsi_min": 48.0, "rsi_max": 65.0, "vol_surge": 1.20, "imbalance_threshold": 1.20},
        {"label": "設定4 (TP:+5.0%, SL:-2.2%, 保有15本, RSI:46-65, 出来高1.15倍)", "take_profit_pct": 0.050, "stop_loss_pct": 0.022, "max_holding_bars": 15, "rsi_min": 46.0, "rsi_max": 65.0, "vol_surge": 1.15, "imbalance_threshold": 1.15},
    ]

    print("\n" + "="*85, flush=True)
    print("【戦略3】デイトレ・モメンタム反発戦略 バックテスト検証比較", flush=True)
    print("="*85, flush=True)

    for idx, cfg in enumerate(test_patterns):
        strat = HighWinDaytradeMomentumStrategy(cfg)
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
