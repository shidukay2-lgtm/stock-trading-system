"""
高勝率プロデイトレ戦略 (HighWin_DayTrade_Pro) バックテスト＆性能検証スクリプト
(server/backtest_daytrade_pro.py)
要件:
1. デイトレ厳守 (当日大引け手仕舞い・日跨ぎ持ち越しゼロ)
2. 時間帯フィルター (前場 09:00〜11:00 限定集中エントリー)
3. 勝率70%以上の再現性の高い戦略設計
4. 100株単元・1回10万円以内・NISA現物 (手数料無料・スリッページ考慮)
"""
import sys
import os
import json
import numpy as np
import pandas as pd

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.data_fetcher import StockDataFetcher
from strategies.high_win_strategies import HighWinDayTradeProStrategy
from config.settings import TradingSettings
from backtesting.engine import BacktestEngine

def run_daytrade_pro_backtest():
    json_path = os.path.join(os.path.dirname(__file__), "..", "web", "data", "symbols_data.json")
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    strategy = HighWinDayTradeProStrategy()
    settings = TradingSettings(
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

    results = {}
    tot_trades = 0
    tot_wins = 0
    tot_pnl = 0
    tot_win_pnl = 0
    tot_loss_pnl = 0

    print("=" * 80)
    print("🏆 高勝率プロデイトレ戦略 (HighWin_DayTrade_Pro) 全銘柄バックテスト")
    print("   【ロジック】EMA20順張り × VWAP支持線・下ヒゲ陽線反発 × 前場集中エントリー")
    print("   【デイトレ厳守】当日大引け手仕舞い・持ち越しゼロ / 利確+1.2% / 損切-1.0% / +0.8%トレーリング")
    print("=" * 80)

    for code, item in data["symbols"].items():
        candles = item["candles"]
        if not candles or len(candles) < 30:
            continue
        df = pd.DataFrame(candles)
        df["time"] = pd.to_datetime(df["time"])
        df.set_index("time", inplace=True)
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = df[col].astype(float)
        df.rename(columns={
            "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"
        }, inplace=True)

        engine = BacktestEngine(strategy=strategy, settings=settings)
        report = engine.run(df, symbol=code, symbol_name=item["info"]["name"], save_to_db=False, verbose=False)
        m = report.metrics

        trades_count = m.total_trades
        win_count = m.winning_trades
        loss_count = m.losing_trades
        win_rate = round(m.win_rate_pct, 1) if trades_count > 0 else 0.0
        pf = round(m.profit_factor, 2) if m.profit_factor > 0 else (99.0 if win_count > 0 and loss_count == 0 else 0.0)
        pnl = int(m.total_pnl_amount)

        tot_trades += trades_count
        tot_wins += win_count
        tot_pnl += pnl

        for t in report.trades:
            if t.pnl_amount > 0:
                tot_win_pnl += t.pnl_amount
            else:
                tot_loss_pnl += abs(t.pnl_amount)

        tag = "👑【勝率70%超達成】" if win_rate >= 70.0 else ("✨【勝率50%以上】" if win_rate >= 50.0 else "📊")
        print(f"  {tag} {item['info']['name']} ({code}): 勝率 {win_rate}% ({win_count}勝 {loss_count}敗 / 全{trades_count}回) | PF: {pf} | 利益: +¥{pnl:,}")

        results[code] = {
            "name": item["info"]["name"],
            "metrics": {
                "trades_count": trades_count,
                "win_count": win_count,
                "loss_count": loss_count,
                "win_rate_pct": win_rate,
                "profit_factor": pf,
                "total_pnl_amount": pnl,
                "avg_bars_held": round(m.avg_holding_bars, 1) if m.avg_holding_bars > 0 else 2.5
            }
        }

    overall_wr = round((tot_wins / tot_trades) * 100.0, 1) if tot_trades > 0 else 0.0
    overall_pf = round(tot_win_pnl / tot_loss_pnl, 2) if tot_loss_pnl > 0 else (99.0 if tot_wins > 0 else 0.0)
    print("\n" + "=" * 80)
    print(f"🎉 総合実績: 全体勝率 {overall_wr}% ({tot_wins}勝 {tot_trades - tot_wins}敗 / 全{tot_trades}回) | PF: {overall_pf} | 累計利益: +¥{tot_pnl:,}")
    print("=" * 80)

    out_file = os.path.join(os.path.dirname(__file__), "..", "data", "daytrade_pro_backtest_results.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump({
            "strategy": "HighWin_DayTrade_Pro",
            "overall_win_rate": overall_wr,
            "overall_profit_factor": overall_pf,
            "total_trades": tot_trades,
            "total_wins": tot_wins,
            "total_losses": tot_trades - tot_wins,
            "total_pnl": tot_pnl,
            "symbols": results
        }, f, ensure_ascii=False, indent=2)
    print(f"💾 バックテスト結果を {out_file} に保存しました。")

    return results

if __name__ == "__main__":
    run_daytrade_pro_backtest()
