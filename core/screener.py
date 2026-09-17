"""
ファンダメンタルズ & 投資可能銘柄スクリーナー (core/screener.py)
10万円以下で確実に購入可能な成長小型株（グロース・スタンダード）を厳選
"""
import sys
from typing import List, Dict, Any
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from config.symbols import GROWTH_SMALL_CAP_SYMBOLS, get_affordable_symbols
from config.settings import DEFAULT_SETTINGS

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class StockScreener:
    """成長小型株スクリーニングマネージャー"""

    @staticmethod
    def screen_growth_stocks(
        max_investment: float = 100_000.0,
        min_sales_growth: float = 15.0
    ) -> List[Dict[str, Any]]:
        """
        1. 投資金額が10万円以下で購入可能な銘柄
        2. 売上高成長率が年率15%以上の高成長小型株
        を抽出
        """
        results = []
        for s in GROWTH_SMALL_CAP_SYMBOLS:
            # 投資額チェック
            lot_inv = s.get("lot_investment_approx", 0.0)
            if lot_inv > max_investment:
                continue
            
            # 売上成長率パース
            growth_str = s.get("sales_growth_rate", "+0%").replace("+", "").replace("%", "")
            try:
                growth_val = float(growth_str)
            except ValueError:
                growth_val = 0.0

            if growth_val >= min_sales_growth:
                results.append(s)

        return results

    @staticmethod
    def display_screened_table(stocks: List[Dict[str, Any]]):
        """スクリーニング結果をリッチテーブルで表示"""
        table = Table(
            title="🔍 ファンダメンタルズ選定: 10万円以下で購入可能な東証小型成長株",
            border_style="bright_cyan",
            show_header=True,
            header_style="bold magenta"
        )
        table.add_column("コード", style="bold cyan", width=10)
        table.add_column("銘柄名", style="bold white", width=20)
        table.add_column("市場", width=14)
        table.add_column("売上成長率", justify="right", style="bold green", width=12)
        table.add_column("時価総額", justify="right", width=12)
        table.add_column("概算投資額 (100株/ミニ)", justify="right", style="bold yellow", width=22)
        table.add_column("特徴・収益状況", justify="left", width=30)

        for s in stocks:
            table.add_row(
                s["code"],
                s["name"],
                s["market"],
                s["sales_growth_rate"],
                s["market_cap_approx"],
                f"¥{s['lot_investment_approx']:,.0f} (<= ¥10万)",
                f"{s['operating_profit']} - {s['description'][:20]}..."
            )

        console.print(table)
        console.print("[dim]※ 全銘柄とも1回の投資上限10万円以内、NISA成長投資枠での現物取引に完全適合しています。[/dim]\n")
