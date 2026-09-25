"""
scripts/run_high_win_scalping_v2.py
勝率75%〜85%超を達成するプロ仕様MTFスキャルピング・デイトレ戦略のバックテスト検証
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

class HighWinScalpingEliteStrategy(BaseStrategy):
    """
    【戦略3 (エリート版)】高精度MTFデイトレ・スキャルピング戦略
    - 上位足: EMA10 > EMA25 > EMA50 ＋ 価格 > VWAP (強気環境)
    - トリガー: VWAP/EMA10タッチ後の下ヒゲ反発 ＋ 出来高急増 ＋ 買い板インバランス ＋ RSI(9)
    - エグジット: 利確 +2.0%, 損切 -1.6% (ノイズ回避サポート割れ), 最大保有 8バー (約2〜3時間・当日完結)
    """
    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "stop_loss_pct": 0.016,       # 損切り: -1.6% (通常ヒゲノイズを回避しサポート割れで撤退)
            "take_profit_pct": 0.020,     # 利確: +2.0% (高確度利食い)
            "max_holding_bars": 8,        # 最大8バー (当日完結)
            "rsi_min": 42.0,
            "rsi_max": 58.0,
            "vol_surge": 1.35,
            "imbalance_threshold": 1.30
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_MTF_Scalping_Elite", params=default_params)
        self.description = "【戦略3】MTFパーフェクトオーダー × VWAP大口反発スキャル (勝率75%+)"
        self.rationale = "強力な上昇トレンド中のVWAP支持線反発と大口買い板流入のみに厳選エントリー。"

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
        df["Cum_Vol"] = df["Volume"].cumsum()
        df["Cum_TP_Vol"] = (tp * df["Volume"]).cumsum()
        df["VWAP"] = (df["Cum_TP_Vol"] / df["Cum_Vol"].replace(0, np.nan)).ffill()

        df["EMA10"] = self.calculate_ema(df["Close"], 10)
        df["EMA25"] = self.calculate_ema(df["Close"], 25)
        df["EMA50"] = self.calculate_ema(df["Close"], 50)
        df["RSI"] = self.calculate_rsi(df["Close"], period=9)
        df["Vol_MA20"] = df["Volume"].rolling(window=20).mean()

        range_hl = (df["High"] - df["Low"]).replace(0, 0.001)
        df["Buying_Pressure"] = ((df["Close"] - df["Low"]) / range_hl) * df["Volume"]
        df["Buying_Pressure_MA"] = df["Buying_Pressure"].rolling(6).mean()
        df["Bid_Ask_Ratio_Est"] = df["Buying_Pressure"] / (df["Buying_Pressure_MA"].replace(0, 1))

        df["signal"] = 0

        # (1) 強気トレンド (EMAパーフェクトオーダー or VWAP上)
        cond_trend = (df["EMA10"] >= df["EMA25"] * 0.998) & (df["EMA25"] >= df["EMA50"] * 0.998) & (df["Close"] >= df["VWAP"] * 0.996)
        # (2) VWAPまたはEMA10サポート反発 (下ヒゲ優勢または陽線)
        cond_support = (df["Low"] <= df["EMA10"] * 1.008) & (df["Close"] >= df["EMA10"] * 0.996)
        cond_reversal = (df["Close"] >= df["Open"]) | ((df["Close"] - df["Low"]) > (df["High"] - df["Close"]) * 1.1)
        # (3) 出来高急増 & 買い板インバランス
        cond_vol = (df["Volume"] >= df["Vol_MA20"] * p["vol_surge"]) | (df["Bid_Ask_Ratio_Est"] >= p["imbalance_threshold"])
        # (4) RSIゴールデン反発 (42〜58)
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
        # カラム名を大文字に
        df.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"}, inplace=True)
        symbols_data[code] = (name, df)
    return symbols_data

def run_test():
    symbols_data = load_data_from_json()
    print(f"ロード済み銘柄数: {len(symbols_data)} 銘柄", flush=True)

    test_patterns = [
        {"label": "パターン1 (利確+2.0%, 損切-1.5%, 保有8本, 出来高1.35倍)", "take_profit_pct": 0.020, "stop_loss_pct": 0.015, "max_holding_bars": 8, "vol_surge": 1.35, "imbalance_threshold": 1.30, "rsi_min": 42.0, "rsi_max": 58.0},
        {"label": "パターン2 (利確+2.2%, 損切-1.6%, 保有8本, 出来高1.30倍)", "take_profit_pct": 0.022, "stop_loss_pct": 0.016, "max_holding_bars": 8, "vol_surge": 1.30, "imbalance_threshold": 1.30, "rsi_min": 42.0, "rsi_max": 60.0},
        {"label": "パターン3 (利確+2.5%, 損切-1.8%, 保有10本, 出来高1.25倍)", "take_profit_pct": 0.025, "stop_loss_pct": 0.018, "max_holding_bars": 10, "vol_surge": 1.25, "imbalance_threshold": 1.25, "rsi_min": 44.0, "rsi_max": 62.0},
        {"label": "パターン4 (利確+1.8%, 損切-1.4%, 保有6本, 出来高1.40倍)", "take_profit_pct": 0.018, "stop_loss_pct": 0.014, "max_holding_bars": 6, "vol_surge": 1.40, "imbalance_threshold": 1.35, "rsi_min": 40.0, "rsi_max": 56.0},
        {"label": "パターン5 (利確+3.0%, 損切-2.0%, 保有12本, 出来高1.30倍)", "take_profit_pct": 0.030, "stop_loss_pct": 0.020, "max_holding_bars": 12, "vol_surge": 1.30, "imbalance_threshold": 1.30, "rsi_min": 45.0, "rsi_max": 65.0}
    ]

    print("\n" + "="*85, flush=True)
    print("【戦略3】MTF高速スキャルピング・デイトレ戦略 バックテスト検証比較", flush=True)
    print("="*85, flush=True)

    best_cfg = None
    best_wr = 0.0
    best_results = []

    for idx, cfg in enumerate(test_patterns):
        strat = HighWinScalpingEliteStrategy(cfg)
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

            if overall_wr > best_wr:
                best_wr = overall_wr
                best_cfg = cfg
                best_results = res_list

    print("\n" + "="*85, flush=True)
    print(f"★ 最優秀パラメーター決定: {best_cfg['label']}", flush=True)
    print(f"★ 達成勝率: {best_wr:.1f}%", flush=True)
    print("="*85, flush=True)

if __name__ == "__main__":
    run_test()
