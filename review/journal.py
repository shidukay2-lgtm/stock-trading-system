"""
トレード振り返り・ジャーナル管理モジュール (review/journal.py)
過去のトレード結果一覧表示、詳細分析、振り返りノート記録、タグ管理
"""
import sys
from typing import List, Optional, Dict, Any
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from core.database import db

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class TradeJournal:
    """トレード振り返りマネージャー"""

    @staticmethod
    def show_trade_history(limit: int = 20, symbol: Optional[str] = None):
        """トレード履歴をリッチテーブルで一覧表示"""
        trades = db.get_trades(limit=limit, symbol=symbol)
        if not trades:
            console.print("[yellow]記録されたトレード履歴はまだありません。[/yellow]")
            return

        table = Table(title=f"📖 トレード履歴・ジャーナル一覧 (最新{len(trades)}件)", border_style="bright_blue")
        table.add_column("Trade ID", style="bold cyan", width=12)
        table.add_column("銘柄", style="bold white", width=18)
        table.add_column("戦略", style="yellow", width=18)
        table.add_column("エントリー", width=16)
        table.add_column("決済", width=16)
        table.add_column("投資金額", justify="right", width=11)
        table.add_column("損益額 (%)", justify="right", width=18)
        table.add_column("理由", justify="center", width=12)
        table.add_column("振り返りメモ / タグ", justify="left", width=25)

        for t in trades:
            pnl_val = t["pnl_amount"]
            color = "green" if pnl_val >= 0 else "red"
            sign = "+" if pnl_val >= 0 else ""

            table.add_row(
                t["trade_id"],
                f"{t['symbol_name']} ({t['symbol']})",
                t["strategy_name"],
                t["entry_time"][:16],
                t["exit_time"][:16],
                f"¥{t['investment_amount']:,.0f}",
                f"[{color}]{sign}¥{pnl_val:,.0f} ({sign}{t['pnl_pct']:.1f}%)[/{color}]",
                t["exit_reason"],
                f"{t['notes']} [dim]{t['tags']}[/dim]"
            )

        console.print(table)

    @staticmethod
    def show_overall_stats():
        """通算成績と振り返りサマリーを表示"""
        stats = db.get_trade_summary_stats()
        if stats["total_trades"] == 0:
            console.print("[yellow]統計データはまだありません。[/yellow]")
            return

        pnl_color = "green" if stats["total_pnl"] >= 0 else "red"
        pnl_sign = "+" if stats["total_pnl"] >= 0 else ""

        panel_content = (
            f"📊 [bold cyan]通算トレードパフォーマンス[/bold cyan]\n\n"
            f"・総トレード回数: [bold white]{stats['total_trades']} 回[/bold white] "
            f"([bold green]{stats['winning_trades']}勝[/bold green] / [bold red]{stats['losing_trades']}敗[/bold red])\n"
            f"・通算勝率: [bold {'green' if stats['win_rate'] >= 50 else 'yellow'}]{stats['win_rate']:.1f}%[/]\n"
            f"・通算実現損益: [{pnl_color}]{pnl_sign}¥{stats['total_pnl']:,.0f}[/{pnl_color}]\n"
            f"・平均損益率: [{pnl_color}]{pnl_sign}{stats['avg_pnl_pct']:.2f}%[/{pnl_color}]\n"
            f"・平均保有期間: [bold white]{stats['avg_holding_days']:.1f} 営業日[/bold white] (3日以内ルール遵守)"
        )
        console.print(Panel(panel_content, title="🏆 投資パフォーマンス振り返り", border_style="green"))

    @staticmethod
    def add_note_to_trade(trade_id: str, note: str, tags: str = ""):
        """トレードに振り返りメモとタグを追加"""
        success = db.update_trade_notes(trade_id, note, tags)
        if success:
            console.print(f"[bold green][OK][/bold green] トレード [{trade_id}] の振り返りメモを保存しました。")
        else:
            console.print(f"[bold red][ERROR][/bold red] トレード [{trade_id}] が見つかりませんでした。")
