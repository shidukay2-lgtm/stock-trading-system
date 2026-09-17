"""
勝率65%以上 & 100株で10万円以下（株価1,000円以下）の厳選スクリーニングスクリプト
"""

import os
import sys
import json
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config.settings import DEFAULT_SETTINGS, TradingSettings
from core.data_fetcher import StockDataFetcher
from strategies.high_win_strategies import HighWinTripleConfluenceStrategy, HighWinTrendPullbackStrategy, HighWinVolumeBreakoutStrategy
from backtesting.engine import BacktestEngine

# 100株で10万円以下（株価1,000円以下）の東証成長小型株候補
candidates = [
    {"code": "4477.T", "name": "BASE", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+24.5%", "desc": "個人向けECプラットフォーム"},
    {"code": "7383.T", "name": "ネットプロHD", "market": "東証プライム", "sector": "情報・通信業", "sales_growth": "+18.2%", "desc": "後払い(BNPL)決済大手"},
    {"code": "2158.T", "name": "FRONTEO", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+15.8%", "desc": "自然言語AIエンジンKIBIT"},
    {"code": "4436.T", "name": "ミンカブ", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+21.0%", "desc": "金融メディア・Web3ソリューション"},
    {"code": "7354.T", "name": "DmMiX", "market": "東証プライム", "sector": "サービス業", "sales_growth": "+12.5%", "desc": "営業支援・BPOサービス"},
    {"code": "2484.T", "name": "出前館", "market": "東証スタンダード", "sector": "サービス業", "sales_growth": "+15.0%", "desc": "フードデリバリー大手"},
    {"code": "3936.T", "name": "グローバルウェイ", "market": "東証スタンダード", "sector": "情報・通信業", "sales_growth": "+14.2%", "desc": "Webメディア・システム開発"},
    {"code": "3903.T", "name": "gumi", "market": "東証プライム", "sector": "情報・通信業", "sales_growth": "+10.5%", "desc": "モバイルゲーム・Web3"},
    {"code": "4476.T", "name": "AI CROSS", "market": "東証グロース", "sector": "情報・通信業", "sales_growth": "+22.1%", "desc": "SMS配信・ビジネスチャット"},
    {"code": "6195.T", "name": "ホープ", "market": "東証グロース", "sector": "サービス業", "sales_growth": "+19.0%", "desc": "自治体特化型広告・エネルギー"},
    {"code": "7048.T", "name": "ベルトラ", "market": "東証グロース", "sector": "サービス業", "sales_growth": "+25.4%", "desc": "現地体験型オプショナルツアー予約"},
    {"code": "6562.T", "name": "ジーニー", "market": "東証スタンダード", "sector": "情報・通信業", "sales_growth": "+26.8%", "desc": "アドテクノロジー・マーケティングSaaS"},
]

fetcher = StockDataFetcher()
results = []

# 単元株(100株)限定設定
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
print("  東証成長小型株（単元株100株<=10万円）バックテストスクリーニング")
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
        
        print(f"[{code}] {item['name']:<10} 株価: ¥{latest_close:>5.1f} | 100株: ¥{lot_cost:>6.0f} | 勝率: {m.win_rate_pct:>5.1f}% | PF: {m.profit_factor:>4.2f} | MaxDD: {m.max_drawdown_pct:>4.2f}% | 取引: {m.total_trades}回 ({best_strat_name})")
        
    except Exception as e:
        print(f"Error {code}: {e}")

print("\n================================================================================")
print("  【厳選合格】勝率 65.0% 以上の銘柄（100株単元で10万円以内厳守）")
print("================================================================================")

high_win_symbols = [r for r in results if r["win_rate"] >= 65.0 and r["total_trades"] >= 4]
for r in high_win_symbols:
    print(f"🌟 {r['name']} ({r['code']}): 勝率 {r['win_rate']:.1f}% | PF {r['profit_factor']:.2f} | MaxDD {r['max_drawdown']:.2f}% | 100株: ¥{r['100_lot_cost']:.0f} (推奨{r['recommended_shares']}株)")
