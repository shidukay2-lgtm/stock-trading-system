"""
パフォーマンス指標計算モジュール (backtesting/metrics.py)
"""
import numpy as np
import pandas as pd
from typing import List
from core.models import Trade, BacktestMetrics, ExitReason

class MetricsCalculator:
    """バックテスト結果の各種指標計算"""

    @staticmethod
    def calculate_metrics(
        initial_capital: float,
        final_equity: float,
        trades: List[Trade],
        equity_curve: pd.DataFrame
    ) -> BacktestMetrics:
        """指標を包括的に算出"""
        total_trades = len(trades)
        if total_trades == 0:
            return BacktestMetrics(
                initial_capital=initial_capital,
                final_equity=final_equity,
                total_return_pct=0.0,
                total_pnl_amount=0.0,
                total_trades=0,
                winning_trades=0,
                losing_trades=0,
                win_rate_pct=0.0,
                profit_factor=0.0,
                max_drawdown_pct=0.0,
                max_drawdown_amount=0.0,
                sharpe_ratio=0.0,
                average_profit_pct=0.0,
                average_loss_pct=0.0,
                risk_reward_achieved=0.0,
                avg_holding_bars=0.0,
                take_profit_count=0,
                stop_loss_count=0,
                timeout_count=0
            )

        winning_trades = [t for t in trades if t.pnl_amount > 0]
        losing_trades = [t for t in trades if t.pnl_amount <= 0]

        win_count = len(winning_trades)
        loss_count = len(losing_trades)
        win_rate = (win_count / total_trades) * 100.0

        total_profit = sum(t.pnl_amount for t in winning_trades)
        total_loss = abs(sum(t.pnl_amount for t in losing_trades))
        profit_factor = (total_profit / total_loss) if total_loss > 0 else (99.9 if total_profit > 0 else 0.0)

        total_pnl = final_equity - initial_capital
        total_return_pct = (total_pnl / initial_capital) * 100.0

        # 平均利益率 / 損失率
        avg_profit_pct = float(np.mean([t.pnl_pct for t in winning_trades])) if win_count > 0 else 0.0
        avg_loss_pct = float(abs(np.mean([t.pnl_pct for t in losing_trades]))) if loss_count > 0 else 0.0
        rr_achieved = (avg_profit_pct / avg_loss_pct) if avg_loss_pct > 0 else (avg_profit_pct if avg_profit_pct > 0 else 0.0)

        # 最大ドローダウン
        if not equity_curve.empty and "equity" in equity_curve.columns:
            cum_max = equity_curve["equity"].cummax()
            drawdown = (equity_curve["equity"] - cum_max) / cum_max * 100.0
            max_dd_pct = float(abs(drawdown.min()))
            max_dd_amt = float(abs((equity_curve["equity"] - cum_max).min()))
        else:
            max_dd_pct = 0.0
            max_dd_amt = 0.0

        # シャープレシオ
        if not equity_curve.empty and len(equity_curve) > 1:
            returns = equity_curve["equity"].pct_change().dropna()
            std = returns.std()
            sharpe = float((returns.mean() / (std + 1e-9)) * np.sqrt(250 * 5)) if std > 0 else 0.0
        else:
            sharpe = 0.0

        # 保有時間・決済理由集計
        avg_bars = float(np.mean([t.holding_bars for t in trades]))
        tp_count = sum(1 for t in trades if t.exit_reason == ExitReason.TAKE_PROFIT)
        sl_count = sum(1 for t in trades if t.exit_reason == ExitReason.STOP_LOSS)
        to_count = sum(1 for t in trades if t.exit_reason == ExitReason.TIMEOUT)

        return BacktestMetrics(
            initial_capital=initial_capital,
            final_equity=final_equity,
            total_return_pct=total_return_pct,
            total_pnl_amount=total_pnl,
            total_trades=total_trades,
            winning_trades=win_count,
            losing_trades=loss_count,
            win_rate_pct=win_rate,
            profit_factor=profit_factor,
            max_drawdown_pct=max_dd_pct,
            max_drawdown_amount=max_dd_amt,
            sharpe_ratio=sharpe,
            average_profit_pct=avg_profit_pct,
            average_loss_pct=avg_loss_pct,
            risk_reward_achieved=rr_achieved,
            avg_holding_bars=avg_bars,
            take_profit_count=tp_count,
            stop_loss_count=sl_count,
            timeout_count=to_count
        )
