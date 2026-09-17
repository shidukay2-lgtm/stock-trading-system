"""
バックテストレポート生成モジュール (backtesting/reporter.py)
"""
import os
import pandas as pd
from typing import Optional
from core.models import BacktestResult
from core.visualizer import Visualizer
from config.settings import REPORTS_DIR

class BacktestReporter:
    """バックテスト結果のレポート出力"""

    @staticmethod
    def generate_report(result: BacktestResult, ohlcv_df: pd.DataFrame, filename: Optional[str] = None) -> str:
        """HTMLレポートを生成してパスを返す"""
        return Visualizer.generate_html_report(result, ohlcv_df, filename)

    @staticmethod
    def export_trades_csv(result: BacktestResult, filename: Optional[str] = None) -> str:
        """トレード一覧をCSVに出力"""
        if filename is None:
            clean_sym = result.symbol.replace(".T", "")
            filename = f"trades_{clean_sym}_{result.strategy_name}.csv"
        
        filepath = os.path.join(REPORTS_DIR, filename)
        trade_dicts = [t.to_dict() for t in result.trades]
        df = pd.DataFrame(trade_dicts)
        df.to_csv(filepath, index=False, encoding="utf-8-sig")
        return filepath
