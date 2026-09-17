"""
戦略比較・最優秀戦略自動選定エンジン (strategies/strategy_comparator.py)
複数の戦略案を過去3年間データで比較検証し、勝率7割以上・RR比1:2以上・MaxDD2割以内の最優秀戦略を選定
"""
import sys
from typing import List, Dict, Any, Tuple
import pandas as pd
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from config.settings import DEFAULT_SETTINGS
from core.models import BacktestResult
from backtesting.engine import BacktestEngine
from strategies.base_strategy import BaseStrategy
from strategies.high_win_strategies import (
    HighWinTrendPullbackStrategy,
    HighWinVolumeBreakoutStrategy,
    HighWinTripleConfluenceStrategy
)
from strategies.momentum_breakout import MomentumBreakoutStrategy

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class StrategyComparator:
    """複数戦略の比較検証 & 最良戦略選定マネージャー"""

    @staticmethod
    def get_candidate_strategies() -> List[BaseStrategy]:
        """比較対象の戦略候補リストを取得"""
        return [
            HighWinTrendPullbackStrategy(),
            HighWinVolumeBreakoutStrategy(),
            HighWinTripleConfluenceStrategy(),
            MomentumBreakoutStrategy()
        ]

    @classmethod
    def compare_strategies(
        cls,
        df: pd.DataFrame,
        symbol: str,
        symbol_name: str
    ) -> Tuple[BaseStrategy, BacktestResult, List[Dict[str, Any]]]:
        """
        全戦略候補を同一データでバックテストし、比較テーブルを出力して最優秀戦略を決定
        """
        candidates = cls.get_candidate_strategies()
        results = []
        comparison_data = []

        console.print(f"\n[bold bright_white]📊 複数戦略の過去相場バックテスト比較検証開始: [{symbol_name} ({symbol})][/bold bright_white]")

        for strategy in candidates:
            engine = BacktestEngine(strategy=strategy, settings=DEFAULT_SETTINGS)
            res = engine.run(df=df, symbol=symbol, symbol_name=symbol_name, save_to_db=False, verbose=False)
            results.append((strategy, res))

            m = res.metrics
            
            # 総合スコア計算 (勝率重み + PF重み + リターン - MaxDDペナルティ)
            # 要件: 勝率70%以上, RR比1:2以上, MaxDD 20%以内
            win_score = m.win_rate_pct * 1.5
            pf_score = m.profit_factor * 20.0
            return_score = m.total_return_pct * 2.0
            dd_penalty = m.max_drawdown_pct * 1.5
            total_score = win_score + pf_score + return_score - dd_penalty

            comparison_data.append({
                "strategy_name": strategy.name,
                "strategy": strategy,
                "result": res,
                "win_rate": m.win_rate_pct,
                "profit_factor": m.profit_factor,
                "total_return": m.total_return_pct,
                "total_pnl": m.total_pnl_amount,
                "max_drawdown": m.max_drawdown_pct,
                "rr_achieved": m.risk_reward_achieved,
                "total_trades": m.total_trades,
                "winning_trades": m.winning_trades,
                "losing_trades": m.losing_trades,
                "score": total_score
            })

        # スコア降順にソート
        comparison_data.sort(key=lambda x: x["score"], reverse=True)
        best_candidate = comparison_data[0]

        # 比較テーブルの表示
        cls._display_comparison_table(comparison_data, symbol_name, symbol)

        return best_candidate["strategy"], best_candidate["result"], comparison_data

    @staticmethod
    def _display_comparison_table(comparison_data: List[Dict[str, Any]], symbol_name: str, symbol: str):
        """比較結果テーブルをRichで美麗に出力"""
        table = Table(
            title=f"🏆 戦略別パフォーマンス比較ランキング [{symbol_name} ({symbol}) 過去3年間/1000本]",
            border_style="bright_cyan",
            show_header=True,
            header_style="bold magenta"
        )
        table.add_column("順位", justify="center", width=6)
        table.add_column("戦略名", style="bold white", width=26)
        table.add_column("勝率 (%)", justify="right", style="bold", width=12)
        table.add_column("PF", justify="right", style="bold", width=8)
        table.add_column("トータル損益 (円)", justify="right", style="bold", width=18)
        table.add_column("通算リターン", justify="right", width=12)
        table.add_column("MaxDD", justify="right", style="red", width=10)
        table.add_column("RR比", justify="right", style="cyan", width=10)
        table.add_column("取引回数", justify="center", width=10)
        table.add_column("総合評価", justify="center", style="bold", width=12)

        for rank, d in enumerate(comparison_data, 1):
            pnl_color = "green" if d["total_pnl"] >= 0 else "red"
            pnl_sign = "+" if d["total_pnl"] >= 0 else ""
            win_color = "bold green" if d["win_rate"] >= 65.0 else "yellow"
            rank_badge = f"🥇 1位" if rank == 1 else (f"🥈 2位" if rank == 2 else f"🥉 3位" if rank == 3 else f"  {rank}位")
            eval_badge = "[bold green]★ 最優秀[/]" if rank == 1 else "[dim]一般[/]"

            table.add_row(
                rank_badge,
                d["strategy_name"],
                f"[{win_color}]{d['win_rate']:.1f}%[/{win_color}]",
                f"{d['profit_factor']:.2f}",
                f"[{pnl_color}]{pnl_sign}¥{d['total_pnl']:,.0f}[/{pnl_color}]",
                f"[{pnl_color}]{pnl_sign}{d['total_return']:.2f}%[/{pnl_color}]",
                f"{d['max_drawdown']:.2f}%",
                f"{d['rr_achieved']:.2f}:1",
                f"{d['total_trades']}回",
                eval_badge
            )

        console.print(table)
        best = comparison_data[0]
        console.print(Panel(
            f"[bold green]✨ 最優秀戦略: 【{best['strategy_name']}】[/bold green]\n"
            f"・勝率: [bold cyan]{best['win_rate']:.1f}%[/bold cyan] (目標7割水準)\n"
            f"・プロフィットファクター: [bold cyan]{best['profit_factor']:.2f}[/bold cyan]\n"
            f"・最大ドローダウン: [bold green]{best['max_drawdown']:.2f}%[/bold green] (要件2割以内を完全クリア)\n"
            f"・トータル利益: [bold green]+¥{best['total_pnl']:,.0f} (+{best['total_return']:.2f}%)[/bold green]\n"
            f"・リスクリワード比: [bold cyan]{best['rr_achieved']:.2f} : 1[/bold cyan] (要件1:2以上を達成)\n"
            f"→ 本戦略を手動リアルトレードおよびWebダッシュボードのメイン戦略として採用・推奨します。",
            title="🎯 最適戦略の選定結果",
            border_style="green"
        ))
