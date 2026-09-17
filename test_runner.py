"""
統合テストスイート (test_runner.py)
stock_trading_system の全機能、高勝率戦略、スクリーナー、手動トレードの適合性を検証
"""
import sys
import os
import unittest
from datetime import datetime
import pandas as pd
import numpy as np

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from config.settings import DEFAULT_SETTINGS, DB_PATH
from config.symbols import GROWTH_SMALL_CAP_SYMBOLS, get_symbol_by_code, get_affordable_symbols
from core.models import Candle, Position, Trade, Portfolio, ExitReason, OrderSide, OrderType
from core.database import db
from core.data_fetcher import fetcher
from core.visualizer import Visualizer
from core.screener import StockScreener
from strategies.momentum_breakout import MomentumBreakoutStrategy
from strategies.ema_pullback import EMAPullbackStrategy
from strategies.high_win_strategies import (
    HighWinTrendPullbackStrategy,
    HighWinVolumeBreakoutStrategy,
    HighWinTripleConfluenceStrategy
)
from strategies.strategy_optimizer import StrategyOptimizer
from strategies.strategy_comparator import StrategyComparator
from backtesting.engine import BacktestEngine
from backtesting.reporter import BacktestReporter
from live_trading.broker_interface import MockBrokerAdapter
from live_trading.paper_trader import PaperTrader
from live_trading.manual_trader import ManualRealTrader
from review.journal import TradeJournal

class TestStockTradingSystem(unittest.TestCase):
    """システム要件の自動検証テストスイート"""

    def setUp(self):
        # 1h足 1000本分の強気トレンド＋押し目＋ブレイクアウトデータを生成
        dates = pd.date_range(start="2024-01-01 09:00", periods=1000, freq="h")
        np.random.seed(42)
        
        price = 300.0
        prices = [price]
        for _ in range(999):
            ret = np.random.normal(0.0008, 0.012)
            price = max(50.0, price * (1 + ret))
            prices.append(price)

        close_series = pd.Series(prices, index=dates)
        open_series = close_series.shift(1).fillna(close_series.iloc[0])
        high_series = np.maximum(open_series, close_series) * (1 + np.random.uniform(0.001, 0.015, 1000))
        low_series = np.minimum(open_series, close_series) * (1 - np.random.uniform(0.001, 0.015, 1000))
        volume_series = np.random.uniform(10000, 300000, 1000)

        # 意図的に明確な押し目反発ポイントとブレイクアウトポイントを作成
        for idx in [150, 300, 450, 600, 750, 900]:
            high_series.iloc[idx] = close_series.iloc[idx-1] * 1.075
            close_series.iloc[idx] = close_series.iloc[idx-1] * 1.065
            volume_series[idx] = 1500000

        self.mock_df = pd.DataFrame({
            "Open": open_series,
            "High": high_series,
            "Low": low_series,
            "Close": close_series,
            "Volume": volume_series
        }, index=dates)

    def test_01_stock_screener_affordable_growth(self):
        """1. ファンダメンタルズ選定: 10万円以下で購入可能な高成長小型株の抽出確認"""
        stocks = StockScreener.screen_growth_stocks(max_investment=100000.0, min_sales_growth=15.0)
        self.assertGreaterEqual(len(stocks), 3, "10万円以下で買える成長小型株が3銘柄以上抽出されること")
        for s in stocks:
            self.assertLessEqual(s["lot_investment_approx"], 100000.0, f"10万円超過銘柄が含まれています: {s['name']}")

    def test_02_high_win_strategies_constraints(self):
        """2. 高勝率戦略: リスクリワード比1:2以上、損切り-3%以内、利確+6%以上、保有3日以内の確認"""
        strategies = [
            HighWinTrendPullbackStrategy(),
            HighWinVolumeBreakoutStrategy(),
            HighWinTripleConfluenceStrategy()
        ]
        for strat in strategies:
            info = strat.get_strategy_info()
            sl_pct = strat.params["stop_loss_pct"]
            tp_pct = strat.params["take_profit_pct"]
            rr_ratio = tp_pct / sl_pct

            self.assertLessEqual(sl_pct, 0.030, f"{strat.name} の損切りが-3%を超えています")
            self.assertGreaterEqual(tp_pct, 0.060, f"{strat.name} の利確が+6%未満です")
            self.assertGreaterEqual(rr_ratio, 2.0, f"{strat.name} のリスクリワード比が1:2未満です")
            self.assertLessEqual(strat.params["max_holding_bars"], 15, f"{strat.name} の保有期間が3日(15バー)を超えています")

    def test_03_strategy_comparator_execution(self):
        """3. 戦略比較エンジン: 複数戦略のバックテスト比較と最優秀戦略の自動選定"""
        best_strat, best_res, comparison_data = StrategyComparator.compare_strategies(
            df=self.mock_df, symbol="4477.T", symbol_name="BASE"
        )
        self.assertIsNotNone(best_strat)
        self.assertIsNotNone(best_res)
        self.assertEqual(len(comparison_data), 4)

        # 最優秀戦略のMaxDDが20%以内であること
        self.assertLessEqual(best_res.metrics.max_drawdown_pct, 20.0, "最優秀戦略の最大ドローダウンは2割以内であること")

    def test_04_comparison_dashboard_generation(self):
        """4. Webブラウザ用ダッシュボードHTMLの生成確認"""
        _, _, comparison_data = StrategyComparator.compare_strategies(
            df=self.mock_df, symbol="4477.T", symbol_name="BASE"
        )
        html_path = Visualizer.generate_strategy_comparison_html(
            comparison_data=comparison_data, symbol_name="BASE", symbol="4477.T"
        )
        self.assertTrue(os.path.exists(html_path))
        self.assertGreater(os.path.getsize(html_path), 2000)

    def test_05_manual_trader_module(self):
        """5. 手動リアルトレード支援モジュールの初期化とポジション管理"""
        strategy = HighWinTrendPullbackStrategy()
        broker = MockBrokerAdapter(initial_cash=300000.0)
        trader = ManualRealTrader(strategy=strategy, symbols=["4477.T"], broker=broker)
        self.assertEqual(len(trader.positions), 0)
        self.assertEqual(trader.broker.get_account_balance()["cash"], 300000.0)

if __name__ == "__main__":
    unittest.main()
