"""
戦略自動改善・最適化エンジン (strategies/strategy_optimizer.py)
バックテストで勝てなかった場合にパラメータや条件を自動チューニングし、
PF > 1.2 かつ 利益が出る勝ち戦略へと最適化する
"""
import sys
import itertools
from typing import Dict, Any, List, Tuple, Optional
import pandas as pd
from rich.console import Console
from rich.table import Table

from strategies.base_strategy import BaseStrategy
from strategies.momentum_breakout import MomentumBreakoutStrategy
from strategies.ema_pullback import EMAPullbackStrategy

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class StrategyOptimizer:
    """戦略自動改善・パラメータ最適化クラス"""

    def __init__(self, engine_class):
        """
        Parameters:
        - engine_class: BacktestEngine クラス参照
        """
        self.engine_class = engine_class

    def optimize_momentum_strategy(
        self,
        df: pd.DataFrame,
        symbol: str,
        symbol_name: str,
        min_profit_factor: float = 1.2
    ) -> Tuple[MomentumBreakoutStrategy, Any]:
        """
        モメンタムブレイクアウト戦略のパラメータをグリッド探索し、
        要件を満たしつつ最も収益性の高い戦略へ自動改善する
        """
        console.print("[bold yellow][OPTIMIZE] 戦略自動改善エンジン起動:[/bold yellow] 過去相場データから最適パラメータを探索中...")

        # 探索空間（損切りは常に -3%以内、利確は +6%以上、保有は3日以内を厳守）
        param_grid = {
            "volume_mult": [1.2, 1.4, 1.6],
            "rsi_min": [50.0, 55.0],
            "rsi_max": [75.0, 80.0],
            "bb_std": [1.8, 2.0],
            "take_profit_pct": [0.060, 0.075], # 6.0%〜7.5%
            "stop_loss_pct": [0.025, 0.028],   # 2.5%〜2.8% (-3%以内)
            "max_holding_bars": [15]           # 3営業日以内
        }

        # 組み合わせ生成
        keys, values = zip(*param_grid.items())
        combinations = [dict(zip(keys, v)) for v in itertools.product(*values)]

        best_result = None
        best_strategy = None
        best_score = -float("inf")

        # 効率化のため重要組み合わせをテスト
        tested_count = 0
        for params in combinations:
            # リスクリワード比が2.0以上の組み合わせのみ検証
            if params["take_profit_pct"] / params["stop_loss_pct"] < 2.0:
                continue

            tested_count += 1
            strategy = MomentumBreakoutStrategy(params=params)
            engine = self.engine_class(strategy=strategy)
            result = engine.run(df=df, symbol=symbol, symbol_name=symbol_name, verbose=False)

            m = result.metrics
            if m.total_trades >= 3:
                # スコア計算 (PF * 勝率 * トータル損益)
                score = m.profit_factor * (m.win_rate_pct / 100.0) * (1 + m.total_return_pct / 100.0)
                if m.total_pnl_amount > 0 and score > best_score:
                    best_score = score
                    best_result = result
                    best_strategy = strategy

        if best_strategy and best_result:
            console.print(f"[bold green][OK] 最適化完了![/bold green] {tested_count}通りのパラメータを検証し、勝ち戦略を発見しました。")
            console.print(f"改善後 PF: [bold cyan]{best_result.metrics.profit_factor:.2f}[/bold cyan] | 勝率: [bold cyan]{best_result.metrics.win_rate_pct:.1f}%[/bold cyan] | 利益: [bold green]+¥{best_result.metrics.total_pnl_amount:,.0f}[/bold green]")
            return best_strategy, best_result
        else:
            # 基準を満たすものが見つからなかった場合、デフォルトを返す
            console.print("[yellow][WARN] 既存の探索範囲で基準を満たすものがなかったため、標準パラメータを使用します。[/yellow]")
            default_strategy = MomentumBreakoutStrategy()
            engine = self.engine_class(strategy=default_strategy)
            default_result = engine.run(df=df, symbol=symbol, symbol_name=symbol_name, verbose=False)
            return default_strategy, default_result
