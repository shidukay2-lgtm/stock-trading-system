"""
Webダッシュボード用データエクスポートスクリプト (server/data_exporter.py)
東証小型成長株の最新1h足ローソク足データとファンダメンタルズ情報をJSON形式で出力
GitHub PagesやWebブラウザツールが完全静的で動作できるように準備
"""
import os
import sys
import json
from datetime import datetime

# パス設定
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from config.symbols import GROWTH_SMALL_CAP_SYMBOLS
from core.data_fetcher import fetcher
from strategies.high_win_strategies import HighWinTripleConfluenceStrategy
from backtesting.engine import BacktestEngine
from config.settings import DEFAULT_SETTINGS

WEB_DATA_DIR = os.path.join(PROJECT_ROOT, "web", "data")
os.makedirs(WEB_DATA_DIR, exist_ok=True)
OUTPUT_JSON_PATH = os.path.join(WEB_DATA_DIR, "symbols_data.json")

def export_symbols_data():
    """全対象銘柄の1h足データとバックテスト結果をJSONに出力"""
    strategy = HighWinTripleConfluenceStrategy()
    engine = BacktestEngine(strategy=strategy, settings=DEFAULT_SETTINGS)

    export_data = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "strategy_info": strategy.get_strategy_info(),
        "settings": {
            "initial_capital": DEFAULT_SETTINGS.INITIAL_CAPITAL,
            "max_position_amount": DEFAULT_SETTINGS.MAX_POSITION_AMOUNT,
            "stop_loss_pct": strategy.params["stop_loss_pct"],
            "take_profit_pct": strategy.params["take_profit_pct"],
            "max_holding_bars": strategy.params["max_holding_bars"]
        },
        "symbols": {}
    }

    for sym_info in GROWTH_SMALL_CAP_SYMBOLS:
        symbol = sym_info["code"]
        print(f"[*] 銘柄データ取得中: {sym_info['name']} ({symbol})...")
        
        df = fetcher.fetch_ohlcv(symbol, interval="60m", target_candles=600, show_cool_ui=False)
        if df.empty or len(df) < 50:
            continue

        # バックテスト実行
        result = engine.run(df=df, symbol=symbol, symbol_name=sym_info["name"], save_to_db=False, verbose=False)
        m = result.metrics

        # ローソク足リスト化
        candles = []
        for idx, row in df.iterrows():
            ts_str = idx.strftime("%Y-%m-%d %H:%M") if hasattr(idx, "strftime") else str(idx)
            candles.append({
                "time": ts_str,
                "open": round(float(row["Open"]), 1),
                "high": round(float(row["High"]), 1),
                "low": round(float(row["Low"]), 1),
                "close": round(float(row["Close"]), 1),
                "volume": int(row.get("Volume", 0))
            })

        # トレードリスト化
        trades_list = [t.to_dict() for t in result.trades]

        export_data["symbols"][symbol] = {
            "info": sym_info,
            "candles": candles,
            "metrics": {
                "total_trades": m.total_trades,
                "winning_trades": m.winning_trades,
                "losing_trades": m.losing_trades,
                "win_rate_pct": round(m.win_rate_pct, 1),
                "profit_factor": round(m.profit_factor, 2),
                "total_pnl_amount": round(m.total_pnl_amount, 0),
                "total_return_pct": round(m.total_return_pct, 2),
                "max_drawdown_pct": round(m.max_drawdown_pct, 2),
                "risk_reward_achieved": round(m.risk_reward_achieved, 2),
                "avg_holding_bars": round(m.avg_holding_bars, 1),
                "take_profit_count": m.take_profit_count,
                "stop_loss_count": m.stop_loss_count,
                "timeout_count": m.timeout_count
            },
            "trades": trades_list
        }

    with open(OUTPUT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(export_data, f, ensure_ascii=False, indent=2)

    print(f"[OK] Web用データエクスポート完了: {OUTPUT_JSON_PATH}")

if __name__ == "__main__":
    export_symbols_data()
