"""
scripts/run_all_strategies_comparison.py
全戦略（戦略1, 戦略2, 戦略3, 戦略4）のバックテスト詳細成績比較
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
from strategies.high_win_strategies import (
    HighWinTrendPullbackStrategy,
    HighWinVolumeBreakoutStrategy,
    HighWinTripleConfluenceStrategy,
    HighWinOrderBookVWAPPullbackStrategy,
    HighWinMTFScalpingStrategy
)

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

def run_comparison():
    symbols_data = load_data_from_json()

    strategies = [
        ("【戦略1】トレンド押し目買い (HighWin_TrendPullback)", HighWinTrendPullbackStrategy()),
        ("【戦略2】出来高ブレイクアウト (HighWin_VolumeBreakout)", HighWinVolumeBreakoutStrategy()),
        ("【戦略4】板気配×VWAP反発 (HighWin_OrderBook_VWAP)", HighWinOrderBookVWAPPullbackStrategy()),
        ("【戦略3: 現行】高速スキャル (HighWin_MTF_Scalping)", HighWinMTFScalpingStrategy())
    ]

    for strat_label, strat in strategies:
        p = strat.params
        settings = TradingSettings(
            INITIAL_CAPITAL=300000.0,
            MAX_POSITION_AMOUNT=100000.0,
            DEFAULT_LOT_SIZE=100,
            ALLOW_ODD_LOTS=False,
            MAX_HOLDING_DAYS=1 if "Scalp" in strat.name else 3,
            MAX_HOLDING_BARS=p.get("max_holding_bars", 15),
            STOP_LOSS_PCT=p.get("stop_loss_pct", 0.028),
            TAKE_PROFIT_PCT=p.get("take_profit_pct", 0.060)
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

            print(f"\n=======================================================", flush=True)
            print(f"{strat_label}", flush=True)
            print(f"=======================================================", flush=True)
            print(f"  ▶ 全体取引: {total_trades}回 | 勝: {total_wins}回 / 負: {total_trades - total_wins}回", flush=True)
            print(f"  ▶ 通算勝率: {overall_wr:.1f}% | 銘柄平均勝率: {avg_wr:.1f}% | 70%以上達成銘柄: {pass_70_cnt}/{len(res_list)}", flush=True)
            print(f"  ▶ 合計純利益: +¥{total_pnl:,.0f}", flush=True)
            for r in res_list:
                status = "★70%超" if r['win_rate'] >= 70.0 else "  未達 "
                print(f"    - [{r['code']}] {r['name']:<12}: 取引{r['trades']:2d}回 | 勝率 {r['win_rate']:5.1f}% ({r['wins']}勝{r['losses']}敗) | PF {r['pf']:4.2f} | 損益 +¥{r['pnl']:>7,.0f} [{status}]", flush=True)

if __name__ == "__main__":
    run_comparison()
