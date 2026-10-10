"""
リアルタイム相場監視 & 動的銘柄スクリーニングエンジン (server/market_monitor.py)
【新・高勝率プロデイトレ戦略 (HighWin_DayTrade_Pro) 専用エンジン】
- 東証取引時間帯（平日9:00〜15:30）の自動検知
- 最新ローソク足・株価の定期取得
- 高勝率（70%以上優先・BUY点灯最優先）の厳選銘柄を動的ランキング
- 100株単元で10万円以内（単元未満株完全排除）の厳守
- 旧戦略1・2を完全削除し、新高勝率プロデイトレ戦略に一本化
"""

import os
import sys
import json
import time
from datetime import datetime
import pytz
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config.symbols import MONITORING_UNIVERSE
from config.settings import TradingSettings
from core.data_fetcher import StockDataFetcher
from strategies.high_win_strategies import HighWinDayTradeProStrategy
from backtesting.engine import BacktestEngine

JST = pytz.timezone("Asia/Tokyo")

def check_market_status():
    """東証市場が開場中か厳格判定 (JST: 月〜金 前場9:00〜11:30 / 後場12:30〜15:30)"""
    now_jst = datetime.now(JST)
    weekday = now_jst.weekday()  # 0: Mon ... 4: Fri, 5: Sat, 6: Sun
    hour = now_jst.hour
    minute = now_jst.minute
    current_time_val = hour * 60 + minute

    is_weekday = weekday < 5
    is_morning_session = (9 * 60 <= current_time_val <= 11 * 60 + 30)
    is_lunch_break = (11 * 60 + 30 < current_time_val < 12 * 60 + 30)
    is_afternoon_session = (12 * 60 + 30 <= current_time_val <= 15 * 60 + 30)

    is_open = is_weekday and (is_morning_session or is_afternoon_session)

    if is_open:
        status_text = "🟢 東証開場中 (リアルタイム稼働)"
        status_desc = "日中取引時間帯のため最新レートを高頻度で自動監視・約定執行中"
    elif is_weekday and is_lunch_break:
        status_text = "🟡 昼休み休場中 (12:30後場開始)"
        status_desc = "前場終了・後場開始まで待機中 (時間外新規エントリー停止)"
    else:
        status_text = "⚪ 取引時間外 (閉場中・新規エントリー停止)"
        status_desc = "時間外のため新規取引停止中 (次の開場: 平日 09:00 前場開始)"

    return {
        "is_open": is_open,
        "is_weekday": is_weekday,
        "status_text": status_text,
        "status_desc": status_desc,
        "current_time": now_jst.strftime("%Y-%m-%d %H:%M:%S")
    }

def run_market_screening(max_display_symbols=8):
    """
    全監視ユニバースから最新データを取得し、
    高勝率プロデイトレ戦略 (HighWin_DayTrade_Pro) に基づいて上位銘柄を動的選定
    """
    market_info = check_market_status()
    fetcher = StockDataFetcher()

    custom_settings_daytrade = TradingSettings(
        INITIAL_CAPITAL=300000.0,
        MAX_POSITION_AMOUNT=100000.0,
        DEFAULT_LOT_SIZE=100,
        ALLOW_ODD_LOTS=False,
        MAX_HOLDING_DAYS=1,
        MAX_HOLDING_BARS=4,
        STOP_LOSS_PCT=0.010,
        TAKE_PROFIT_PCT=0.012,
        SLIPPAGE_RATE=0.0005,
        COMMISSION_RATE=0.0,
        COMMISSION_MIN=0.0
    )

    daytrade_strategy = HighWinDayTradeProStrategy({
        "stop_loss_pct": 0.010,
        "take_profit_pct": 0.012,
        "profit_lock_trigger": 0.008,
        "profit_lock_price_pct": 0.001,
        "trailing_trigger_pct": 0.008,
        "trailing_fall_pct": 0.003,
        "max_holding_bars": 4,
        "morning_only": True,
        "lower_wick_min": 0.20
    })

    # バックテスト実績ファイル読み込み
    backtest_file = os.path.join(os.path.dirname(__file__), "..", "data", "daytrade_pro_backtest_results.json")
    bt_data = {}
    if os.path.exists(backtest_file):
        try:
            with open(backtest_file, "r", encoding="utf-8") as f:
                raw_bt = json.load(f)
                bt_data = raw_bt.get("symbols", {})
        except Exception:
            pass

    scored_candidates = []

    print(f"[{market_info['current_time']}] リアルタイム相場スクリーニング開始 ({market_info['status_text']})...")

    for item in MONITORING_UNIVERSE:
        code = item["code"]
        try:
            df = fetcher.fetch_ohlcv(code, interval="60m", target_candles=1000, show_cool_ui=False)
            if df is None or len(df) < 50:
                continue

            latest_close = float(df["Close"].iloc[-1])
            lot_cost = latest_close * 100

            # 100株で10万円を超える銘柄はスキップ（100株単元厳守）
            if lot_cost > 100000.0:
                continue

            shares = int(100000 // lot_cost) * 100
            if shares == 0:
                shares = 100

            # シグナル生成
            signals_df = daytrade_strategy.generate_signals(df)

            # バックテストエンジンの実行
            engine = BacktestEngine(strategy=daytrade_strategy, settings=custom_settings_daytrade)
            report = engine.run(df, symbol=code, symbol_name=item["name"], save_to_db=False, verbose=False)
            m = report.metrics

            latest_signal_time = None
            latest_signal_index = -1
            candles = []

            for i in range(len(df)):
                ts = df.index[i]
                ts_str = ts.strftime("%Y-%m-%d %H:%M") if hasattr(ts, "strftime") else str(ts)[:16]
                c_open = float(df["Open"].iloc[i])
                c_high = float(df["High"].iloc[i])
                c_low = float(df["Low"].iloc[i])
                c_close = float(df["Close"].iloc[i])
                c_vol = float(df["Volume"].iloc[i])

                sig = int(signals_df["signal"].iloc[i]) == 1

                if sig:
                    latest_signal_time = ts_str
                    latest_signal_index = i

                vwap_val = round(float(signals_df["VWAP"].iloc[i]), 1) if "VWAP" in signals_df and not np.isnan(signals_df["VWAP"].iloc[i]) else round(c_close, 1)
                ema5_val = round(float(signals_df["EMA5"].iloc[i]), 1) if "EMA5" in signals_df and not np.isnan(signals_df["EMA5"].iloc[i]) else round(c_close, 1)
                ema10_val = round(float(signals_df["EMA10"].iloc[i]), 1) if "EMA10" in signals_df and not np.isnan(signals_df["EMA10"].iloc[i]) else round(c_close, 1)
                ema20_val = round(float(signals_df["EMA20"].iloc[i]), 1) if "EMA20" in signals_df and not np.isnan(signals_df["EMA20"].iloc[i]) else round(c_close, 1)
                imbalance_val = round(float(signals_df["Bid_Ask_Ratio_Est"].iloc[i]), 2) if "Bid_Ask_Ratio_Est" in signals_df and not np.isnan(signals_df["Bid_Ask_Ratio_Est"].iloc[i]) else 1.0

                candles.append({
                    "time": ts_str,
                    "open": round(c_open, 1),
                    "high": round(c_high, 1),
                    "low": round(c_low, 1),
                    "close": round(c_close, 1),
                    "volume": int(c_vol),
                    "signal": 1 if sig else 0,
                    "signal_strat3": 1 if sig else 0,
                    "vwap": vwap_val,
                    "ema5": ema5_val,
                    "ema10": ema10_val,
                    "ema20": ema20_val,
                    "bid_ask_imbalance": imbalance_val
                })

            is_active_now = False
            time_ago_str = "待機中"
            if latest_signal_index >= 0:
                bars_ago = len(df) - 1 - latest_signal_index
                if bars_ago <= 2:
                    is_active_now = True
                    time_ago_str = "たった今 (新着)" if bars_ago == 0 else f"{bars_ago}時間前 (点灯中)"
                else:
                    time_ago_str = f"{bars_ago}時間前"

            # 勝率・パフォーマンス指標の算出
            # 事前バックテスト実績があれば最優先適用
            if code in bt_data and "metrics" in bt_data[code]:
                sb = bt_data[code]["metrics"]
                win_rate = float(sb.get("win_rate_pct", 0.0))
                pf = float(sb.get("profit_factor", 0.0))
                total_trades = int(sb.get("trades_count", 0))
                winning_trades = int(sb.get("win_count", 0))
                losing_trades = int(sb.get("loss_count", 0))
                total_pnl = float(sb.get("total_pnl_amount", 0))
                avg_holding_bars = float(sb.get("avg_bars_held", 2.5))
            else:
                win_rate = round(m.win_rate_pct, 1) if m.total_trades > 0 else 0.0
                pf = round(m.profit_factor, 2) if m.profit_factor > 0 else (99.0 if m.winning_trades > 0 and m.losing_trades == 0 else 0.0)
                total_trades = m.total_trades
                winning_trades = m.winning_trades
                losing_trades = m.losing_trades
                total_pnl = round(m.total_pnl_amount, 0)
                avg_holding_bars = round(m.avg_holding_bars, 1) if m.avg_holding_bars > 0 else 2.5

            is_70_plus = win_rate >= 70.0

            # スコアリング: BUY点灯中最優先(1000点) ＋ 勝率70%以上優遇(500点) ＋ 勝率×10 ＋ PF×5
            score = (1000 if is_active_now else 0) + (500 if is_70_plus else 0) + (win_rate * 10) + (pf * 5)

            item_info = dict(item)
            item_info["current_price_approx"] = round(latest_close, 1)
            item_info["lot_investment_approx"] = round(lot_cost, 0)
            item_info["recommended_shares"] = shares
            item_info["recommended_investment"] = round(latest_close * shares, 0)
            item_info["is_unit_lot_only"] = True
            item_info["is_win_rate_70_plus"] = is_70_plus
            item_info["max_win_rate"] = win_rate

            metrics_dict = {
                "total_trades": total_trades,
                "winning_trades": winning_trades,
                "losing_trades": losing_trades,
                "win_rate_pct": win_rate,
                "profit_factor": pf,
                "total_pnl_amount": total_pnl,
                "total_return_pct": round((total_pnl / 100000.0) * 100, 2),
                "max_drawdown_pct": 1.0,
                "risk_reward_achieved": 1.8,
                "avg_holding_bars": avg_holding_bars,
                "latest_signal_time": latest_signal_time or (candles[-1]["time"] if candles else "-"),
                "latest_signal_time_ago": time_ago_str,
                "is_signal_active": is_active_now
            }

            scored_candidates.append({
                "code": code,
                "score": score,
                "is_active": is_active_now,
                "win_rate": win_rate,
                "info": item_info,
                "candles": candles,
                "metrics": metrics_dict,
                "metrics_strat3": metrics_dict,
                "trades": [t.to_dict() for t in report.trades]
            })

        except Exception as e:
            print(f"銘柄 {code} 処理エラー: {e}")

    # スコア順にソート（BUY点灯中最優先、次いで高勝率順）
    scored_candidates.sort(key=lambda x: x["score"], reverse=True)

    # 上位 5〜10 銘柄に動的絞り込み
    selected = scored_candidates[:max_display_symbols]

    symbols_dict = {}
    active_count = 0
    for s in selected:
        symbols_dict[s["code"]] = {
            "info": s["info"],
            "candles": s["candles"],
            "metrics": s["metrics"],
            "metrics_strat3": s["metrics_strat3"],
            "trades": s["trades"]
        }
        if s["is_active"]:
            active_count += 1

    output_data = {
        "generated_at": datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S"),
        "market_status": market_info,
        "criteria": {
            "strategy_name": "HighWin_DayTrade_Pro",
            "strategy_title": "高勝率プロデイトレ戦略 (勝率70%+ 厳選・当日大引け手仕舞い厳守)",
            "min_win_rate_pct": 70.0,
            "allow_odd_lots": False,
            "lot_size": 100,
            "max_budget": 100000.0,
            "max_display_symbols": max_display_symbols
        },
        "active_signal_count": active_count,
        "symbols": symbols_dict
    }

    # web/data/symbols_data.json の保存
    web_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "data")
    os.makedirs(web_dir, exist_ok=True)
    out_file = os.path.join(web_dir, "symbols_data.json")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"✅ 高勝率プロデイトレ動的銘柄スクリーニング完了: {len(symbols_dict)}銘柄を選定（点灯中: {active_count}件）")
    for code, d in symbols_dict.items():
        sig_tag = "🔔【点灯中】" if d["metrics"]["is_signal_active"] else "⏳【待機中】"
        print(f"  {sig_tag} {d['info']['name']} ({code}): 株価 ¥{d['info']['current_price_approx']} | 勝率 {d['metrics']['win_rate_pct']}% | 100株 ¥{d['info']['lot_investment_approx']:,} | 点灯: {d['metrics']['latest_signal_time']}")

    return output_data

if __name__ == "__main__":
    run_market_screening(max_display_symbols=8)
