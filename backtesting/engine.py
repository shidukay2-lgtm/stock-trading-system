"""
バックテストエンジン (backtesting/engine.py)
要件（資金30万、1回10万以下、損切り-3%以内、利確+6%以上、3日以内決済、NISA現物）を完全遵守したシミュレータ
"""
import uuid
from datetime import datetime
import pandas as pd
import numpy as np
from typing import List, Optional, Dict, Any, Tuple

from config.settings import DEFAULT_SETTINGS, TradingSettings
from core.models import Candle, Position, Trade, Portfolio, BacktestResult, ExitReason
from core.database import db
from strategies.base_strategy import BaseStrategy
from backtesting.metrics import MetricsCalculator

class BacktestEngine:
    """日本株バックテスト実行エンジン"""

    def __init__(self, strategy: BaseStrategy, settings: TradingSettings = DEFAULT_SETTINGS):
        self.strategy = strategy
        self.settings = settings

    def calculate_position_size(self, price: float, available_cash: float) -> Tuple[int, float]:
        """
        1回の投資金額が最大10万円以下になるよう株数を計算
        - 日本株の単元（100株単位）または単元未満株（1株単位）
        - 常に 100,000 円以下、かつ使用可能残高以下
        """
        max_investment = min(self.settings.MAX_POSITION_AMOUNT, available_cash)
        if max_investment < price:
            return 0, 0.0

        if self.settings.ALLOW_ODD_LOTS:
            # 1株単位で購入（10万円以内の最大株数）
            shares = int(max_investment // price)
        else:
            # 単元株(100株単位)で購入
            lots = int(max_investment // (price * self.settings.DEFAULT_LOT_SIZE))
            shares = lots * self.settings.DEFAULT_LOT_SIZE

        # 念のための安全チェック: 10万円超過を絶対に防止
        while (shares * price) > self.settings.MAX_POSITION_AMOUNT and shares > 0:
            shares -= (1 if self.settings.ALLOW_ODD_LOTS else self.settings.DEFAULT_LOT_SIZE)

        investment_amount = shares * price
        return shares, investment_amount

    def run(
        self,
        df: pd.DataFrame,
        symbol: str,
        symbol_name: str,
        save_to_db: bool = True,
        verbose: bool = True
    ) -> BacktestResult:
        """
        バックテスト実行

        Parameters:
        - df: OHLCV DataFrame
        - symbol: 銘柄コード (例: "4478.T")
        - symbol_name: 銘柄名
        - save_to_db: トレード履歴をSQLiteに保存するか
        - verbose: ログ出力するか
        """
        if df.empty:
            raise ValueError("バックテスト用のローソク足データが空です。")

        # 1. 戦略シグナル生成
        signal_df = self.strategy.generate_signals(df)

        # 2. 初期化
        portfolio = Portfolio(
            initial_capital=self.settings.INITIAL_CAPITAL,
            cash=self.settings.INITIAL_CAPITAL
        )
        trades: List[Trade] = []
        equity_records = []

        stop_loss_pct = self.strategy.params.get("stop_loss_pct", self.settings.STOP_LOSS_PCT)
        take_profit_pct = self.strategy.params.get("take_profit_pct", self.settings.TAKE_PROFIT_PCT)
        max_holding_bars = self.strategy.params.get("max_holding_bars", self.settings.MAX_HOLDING_BARS)

        current_position: Optional[Position] = None

        # 3. バーごとのシミュレーション
        for i in range(len(signal_df)):
            current_bar = signal_df.iloc[i]
            timestamp = signal_df.index[i]
            open_p = float(current_bar["Open"])
            high_p = float(current_bar["High"])
            low_p = float(current_bar["Low"])
            close_p = float(current_bar["Close"])
            signal = int(current_bar.get("signal", 0))

            # --- ポジション管理 & イグジット判定 ---
            if current_position is not None:
                current_position.holding_bars += 1
                current_position.current_price = close_p
                exit_price = None
                exit_reason = None

                # (1) 損切り判定 (Lowがストップロス価格に到達: -3%以内)
                if low_p <= current_position.stop_loss_price:
                    exit_price = current_position.stop_loss_price * (1.0 - self.settings.SLIPPAGE_RATE)
                    exit_reason = ExitReason.STOP_LOSS

                # (2) 利確判定 (Highが利確価格に到達: +6%以上)
                elif high_p >= current_position.take_profit_price:
                    exit_price = current_position.take_profit_price * (1.0 - self.settings.SLIPPAGE_RATE)
                    exit_reason = ExitReason.TAKE_PROFIT

                # (3) タイムアウト判定 (3営業日 / 15バー経過)
                elif current_position.holding_bars >= max_holding_bars:
                    exit_price = close_p * (1.0 - self.settings.SLIPPAGE_RATE)
                    exit_reason = ExitReason.TIMEOUT

                # 決済実行
                if exit_price is not None and exit_reason is not None:
                    # 損益計算 (現物・NISA手数料無料想定)
                    commission = max(self.settings.COMMISSION_MIN, (current_position.investment_amount + exit_price * current_position.shares) * self.settings.COMMISSION_RATE)
                    pnl_amount = (exit_price - current_position.entry_price) * current_position.shares - commission
                    pnl_pct = (pnl_amount / current_position.investment_amount) * 100.0
                    holding_days = current_position.holding_bars / 5.0 # 東証1日5h足換算

                    trade = Trade(
                        trade_id=f"T-{uuid.uuid4().hex[:8].upper()}",
                        symbol=symbol,
                        symbol_name=symbol_name,
                        strategy_name=self.strategy.name,
                        entry_time=current_position.entry_time,
                        exit_time=timestamp,
                        entry_price=current_position.entry_price,
                        exit_price=exit_price,
                        shares=current_position.shares,
                        investment_amount=current_position.investment_amount,
                        pnl_amount=pnl_amount,
                        pnl_pct=pnl_pct,
                        commission=commission,
                        holding_bars=current_position.holding_bars,
                        holding_days=holding_days,
                        exit_reason=exit_reason,
                        risk_reward_ratio=take_profit_pct / stop_loss_pct,
                        notes=f"{symbol_name} 1h足トレード (保有{current_position.holding_bars}本)",
                        tags=f"#{self.strategy.name} #{exit_reason.value}"
                    )
                    trades.append(trade)

                    # 資金回収
                    portfolio.cash += (exit_price * current_position.shares) - commission
                    portfolio.realized_pnl += pnl_amount
                    portfolio.total_commission_paid += commission
                    current_position = None

            # --- エントリー判定 ---
            if current_position is None and signal == 1 and i < len(signal_df) - 1:
                # 買いエントリー（スリッページ考慮）
                entry_price = close_p * (1.0 + self.settings.SLIPPAGE_RATE)
                shares, investment = self.calculate_position_size(entry_price, portfolio.cash)

                if shares > 0 and investment <= self.settings.MAX_POSITION_AMOUNT:
                    commission = max(self.settings.COMMISSION_MIN, investment * self.settings.COMMISSION_RATE)
                    portfolio.cash -= (investment + commission)

                    sl_price = entry_price * (1.0 - stop_loss_pct)
                    tp_price = entry_price * (1.0 + take_profit_pct)

                    current_position = Position(
                        symbol=symbol,
                        symbol_name=symbol_name,
                        entry_time=timestamp,
                        entry_price=entry_price,
                        shares=shares,
                        investment_amount=investment,
                        stop_loss_price=sl_price,
                        take_profit_price=tp_price,
                        current_price=close_p,
                        holding_bars=0,
                        strategy_name=self.strategy.name
                    )

            # 資産スナップショット記録
            pos_val = (current_position.shares * close_p) if current_position else 0.0
            total_eq = portfolio.cash + pos_val
            equity_records.append({
                "timestamp": timestamp,
                "equity": total_eq,
                "cash": portfolio.cash,
                "positions_value": pos_val
            })

        # 4. 未決済ポジションの強制成行精算（バックテスト期間終了時）
        if current_position is not None:
            last_bar = signal_df.iloc[-1]
            last_time = signal_df.index[-1]
            exit_price = float(last_bar["Close"])
            commission = max(self.settings.COMMISSION_MIN, (current_position.investment_amount + exit_price * current_position.shares) * self.settings.COMMISSION_RATE)
            pnl_amount = (exit_price - current_position.entry_price) * current_position.shares - commission
            pnl_pct = (pnl_amount / current_position.investment_amount) * 100.0

            trade = Trade(
                trade_id=f"T-{uuid.uuid4().hex[:8].upper()}",
                symbol=symbol,
                symbol_name=symbol_name,
                strategy_name=self.strategy.name,
                entry_time=current_position.entry_time,
                exit_time=last_time,
                entry_price=current_position.entry_price,
                exit_price=exit_price,
                shares=current_position.shares,
                investment_amount=current_position.investment_amount,
                pnl_amount=pnl_amount,
                pnl_pct=pnl_pct,
                commission=commission,
                holding_bars=current_position.holding_bars,
                holding_days=current_position.holding_bars / 5.0,
                exit_reason=ExitReason.SIGNAL_EXIT,
                risk_reward_ratio=take_profit_pct / stop_loss_pct,
                notes="期間終了時のポジション精算",
                tags=f"#{self.strategy.name} #END_OF_DATA"
            )
            trades.append(trade)
            portfolio.cash += (exit_price * current_position.shares) - commission
            portfolio.realized_pnl += pnl_amount

        # 5. 資産推移DataFrame構築
        eq_df = pd.DataFrame(equity_records)
        if not eq_df.empty:
            eq_df.set_index("timestamp", inplace=True)

        final_equity = portfolio.cash

        # 6. メトリクス集計
        metrics = MetricsCalculator.calculate_metrics(
            initial_capital=self.settings.INITIAL_CAPITAL,
            final_equity=final_equity,
            trades=trades,
            equity_curve=eq_df
        )

        # 7. トレード履歴をDBに永続化
        if save_to_db and trades:
            db.save_trades_bulk(trades)

        start_date_str = signal_df.index[0].strftime("%Y-%m-%d") if not signal_df.empty else ""
        end_date_str = signal_df.index[-1].strftime("%Y-%m-%d") if not signal_df.empty else ""

        return BacktestResult(
            strategy_name=self.strategy.name,
            symbol=symbol,
            symbol_name=symbol_name,
            interval=self.settings.DEFAULT_INTERVAL,
            start_date=start_date_str,
            end_date=end_date_str,
            metrics=metrics,
            trades=trades,
            equity_curve=eq_df
        )
