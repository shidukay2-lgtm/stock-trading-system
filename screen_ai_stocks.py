"""
勝率65%以上 & 100株で10万円以内のAI・SaaS成長小型株スクリーニング
"""

import os
import sys
import json
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.settings import TradingSettings
from core.data_fetcher import StockDataFetcher
from strategies.high_win_strategies import HighWinTripleConfluenceStrategy, HighWinTrendPullbackStrategy, HighWinVolumeBreakoutStrategy
from backtesting.engine import BacktestEngine

candidates = [
    {"code": "4477.T", "name": "BASE", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+24.5%", "desc": "個人・小規模ECプラットフォーム"},
    {"code": "2158.T", "name": "FRONTEO", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+15.8%", "desc": "独自AIエンジンKIBIT"},
    {"code": "5246.T", "name": "ELEMENTS", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+38.5%", "desc": "生体認証・本人確認AIソリューション"},
    {"code": "5586.T", "name": "Laboro.AI", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+32.1%", "desc": "カスタムAI導入・オーダーメイド開発"},
    {"code": "5026.T", "name": "トリプルアイズ", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+29.4%", "desc": "AI画像認識・プラットフォーム"},
    {"code": "4418.T", "name": "JDSC", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+27.0%", "desc": "AI・データサイエンスによる産業DX"},
    {"code": "5240.T", "name": "monoAI", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+21.5%", "desc": "メタバースプラットフォームXR開発"},
    {"code": "4482.T", "name": "ユナイト＆グロウ", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+18.9%", "desc": "情シス部門シェアードSaaS"},
    {"code": "7094.T", "name": "NexTone", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+22.8%", "desc": "音楽著作権管理・デジタルディストリビューション"},
    {"code": "4487.T", "name": "スペースマーケット", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+17.6%", "desc": "スペースシェアリングプラットフォーム"},
    {"code": "4016.T", "name": "MIT HD", "market": "東証スタンダード", "sector": "情報・通信業", "sales_growth": "+14.0%", "desc": "システム開発・セキュリティソリューション"},
    {"code": "7085.T", "name": "カーブスHD", "market": "東証プライム", "sector": "サービス業", "sales_growth": "+15.2%", "desc": "女性向けフィットネスクラブ"},
]

fetcher = StockDataFetcher()
results = []

custom_settings = TradingSettings(
    INITIAL_CAPITAL=300000.0,
    MAX_POSITION_AMOUNT=100000.0,
    DEFAULT_LOT_SIZE=100,
    ALLOW_ODD_LOTS=False,
    MAX_HOLDING_DAYS=3,
    MAX_HOLDING_BARS=15,
    STOP_LOSS_PCT=0.025,
    TAKE_PROFIT_PCT=0.060
)

print("================================================================================")
print("  AI・DX東証成長小型株（100株<=10万円）バックテストスクリーニング")
print("================================================================================")

for item in candidates:
    code = item["code"]
    try:
        df = fetcher.fetch_ohlcv(code, interval="60m", target_candles=1000, show_cool_ui=False)
        if df is None or len(df) < 100:
            continue
            
        latest_close = float(df["Close"].iloc[-1])
        if latest_close > 1000.0:
            continue
            
        strats = [
            HighWinTripleConfluenceStrategy({"ema_short": 10, "ema_long": 25, "rsi_threshold": 48.0, "stop_loss_pct": 0.025, "take_profit_pct": 0.060, "max_holding_bars": 15}),
            HighWinTrendPullbackStrategy({"ema_fast": 9, "ema_mid": 21, "ema_slow": 50, "rsi_min": 42.0, "rsi_max": 58.0, "stop_loss_pct": 0.025, "take_profit_pct": 0.060, "max_holding_bars": 15}),
            HighWinVolumeBreakoutStrategy({"bb_period": 20, "bb_std": 1.9, "volume_mult": 1.4, "rsi_min": 52.0, "rsi_max": 74.0, "stop_loss_pct": 0.025, "take_profit_pct": 0.060, "max_holding_bars": 15}),
        ]
        
        best_report = None
        best_strat_name = ""
        for strat in strats:
            engine = BacktestEngine(strategy=strat, settings=custom_settings)
            rep = engine.run(df, symbol=code, symbol_name=item["name"], save_to_db=False, verbose=False)
            if best_report is None or rep.metrics.win_rate_pct > best_report.metrics.win_rate_pct:
                best_report = rep
                best_strat_name = strat.name
                
        m = best_report.metrics
        lot_cost = latest_close * 100
        shares_100_lot = int(100000 // lot_cost) * 100
        
        res = {
            "code": code,
            "name": item["name"],
            "market": item["market"],
            "sector": item["sector"],
            "sales_growth": item["sales_growth"],
            "desc": item["desc"],
            "latest_price": latest_close,
            "100_lot_cost": lot_cost,
            "recommended_shares": shares_100_lot if shares_100_lot > 0 else 100,
            "win_rate": m.win_rate_pct,
            "profit_factor": m.profit_factor,
            "total_trades": m.total_trades,
            "total_pnl": m.total_pnl_amount,
            "max_drawdown": m.max_drawdown_pct,
            "best_strategy": best_strat_name,
            "candles": df,
            "report": best_report
        }
        results.append(res)
        
        print(f"[{code}] {item['name']:<14} 株価: ¥{latest_close:>5.1f} | 100株: ¥{lot_cost:>6.0f} | 勝率: {m.win_rate_pct:>5.1f}% | PF: {m.profit_factor:>4.2f} | MaxDD: {m.max_drawdown_pct:>4.2f}% | 取引: {m.total_trades}回 ({best_strat_name})")
        
    except Exception as e:
        print(f"Error {code}: {e}")

print("\n================================================================================")
print("  【厳選合格】勝率 65.0% 以上の銘柄（100株単元で10万円以内厳守）")
print("================================================================================")

high_win_symbols = [r for r in results if r["win_rate"] >= 65.0 and r["total_trades"] >= 4]
for r in high_win_symbols:
    print(f"🌟 {r['name']} ({r['code']}): 勝率 {r['win_rate']:.1f}% | PF {r['profit_factor']:.2f} | MaxDD {r['max_drawdown']:.2f}% | 100株: ¥{r['100_lot_cost']:.0f} (推奨{r['recommended_shares']}株)")
