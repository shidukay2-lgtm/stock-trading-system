"""
ペーパートレード・実運用実行モジュール (live_trading/paper_trader.py)
バックテストで勝てた戦略を用いて、リアルタイム（または最新ローソク足）で自動トレードを実行
"""
import time
from datetime import datetime
from typing import Dict, Any, Optional, List
import pandas as pd
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from config.settings import DEFAULT_SETTINGS, TradingSettings
from config.symbols import get_symbol_by_code
from core.models import Position, Trade, ExitReason, OrderSide, OrderType
from core.database import db
from core.data_fetcher import fetcher
from strategies.base_strategy import BaseStrategy
from live_trading.broker_interface import BaseBrokerAdapter, MockBrokerAdapter

console = Console()

class PaperTrader:
    """ペーパートレード（仮想実取引）実行エンジン"""

    def __init__(
        self,
        strategy: BaseStrategy,
        symbols: List[str],
        broker: Optional[BaseBrokerAdapter] = None,
        settings: TradingSettings = DEFAULT_SETTINGS
    ):
        self.strategy = strategy
        self.symbols = symbols
        self.broker = broker or MockBrokerAdapter(initial_cash=settings.INITIAL_CAPITAL)
        self.settings = settings
        self.positions: Dict[str, Position] = {}
        self.running = False

    def check_market_and_trade(self):
        """全監視銘柄の最新ローソク足を取得し、売買シグナルとポジション状態をチェック"""
        console.print(f"[bold cyan]🔍 リアルタイム市場スキャン実行中... [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}][/bold cyan]")

        for symbol_code in self.symbols:
            symbol_info = get_symbol_by_code(symbol_code)
            symbol = symbol_info["code"]

            # 1. 最新ローソク足取得 (100本程度取得して指標計算)
            df = fetcher.fetch_ohlcv(symbol, interval=self.settings.DEFAULT_INTERVAL, target_candles=150, show_cool_ui=False)
            if df.empty or len(df) < 50:
                continue

            # 2. 指標 & シグナル計算
            signal_df = self.strategy.generate_signals(df)
            latest_bar = signal_df.iloc[-1]
            current_price = float(latest_bar["Close"])
            high_price = float(latest_bar["High"])
            low_price = float(latest_bar["Low"])
            signal = int(latest_bar.get("signal", 0))

            # 3. 保有中ポジションのイグジットチェック
            if symbol in self.positions:
                pos = self.positions[symbol]
                pos.holding_bars += 1
                pos.current_price = current_price

                exit_price = None
                exit_reason = None

                # (1) 損切り判定 (-3%以内)
                if low_price <= pos.stop_loss_price:
                    exit_price = pos.stop_loss_price
                    exit_reason = ExitReason.STOP_LOSS

                # (2) 利確判定 (+6%以上)
                elif high_price >= pos.take_profit_price:
                    exit_price = pos.take_profit_price
                    exit_reason = ExitReason.TAKE_PROFIT

                # (3) タイムアウト (3日 / 15バー)
                elif pos.holding_bars >= self.settings.MAX_HOLDING_BARS:
                    exit_price = current_price
                    exit_reason = ExitReason.TIMEOUT

                if exit_price and exit_reason:
                    # 決済注文
                    self._execute_exit(pos, exit_price, exit_reason)
                    del self.positions[symbol]

            # 4. 新規エントリーチェック
            elif signal == 1 and len(self.positions) < self.settings.MAX_CONCURRENT_POSITIONS:
                # 資金確認 & 株数計算
                balance = self.broker.get_account_balance()
                available_cash = balance["cash"]
                
                # 10万円以内で買える株数
                max_invest = min(self.settings.MAX_POSITION_AMOUNT, available_cash)
                if max_invest >= current_price:
                    if self.settings.ALLOW_ODD_LOTS:
                        shares = int(max_invest // current_price)
                    else:
                        lots = int(max_invest // (current_price * self.settings.DEFAULT_LOT_SIZE))
                        shares = lots * self.settings.DEFAULT_LOT_SIZE

                    if shares > 0:
                        self._execute_entry(symbol_info, current_price, shares)

        self._display_portfolio_status()

    def _execute_entry(self, symbol_info: Dict[str, Any], price: float, shares: int):
        """エントリー注文執行"""
        symbol = symbol_info["code"]
        investment = price * shares
        sl_pct = self.strategy.params.get("stop_loss_pct", self.settings.STOP_LOSS_PCT)
        tp_pct = self.strategy.params.get("take_profit_pct", self.settings.TAKE_PROFIT_PCT)

        order_res = self.broker.place_order(
            symbol=symbol,
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            shares=shares,
            price=price
        )

        pos = Position(
            symbol=symbol,
            symbol_name=symbol_info["name"],
            entry_time=datetime.now(),
            entry_price=price,
            shares=shares,
            investment_amount=investment,
            stop_loss_price=price * (1.0 - sl_pct),
            take_profit_price=price * (1.0 + tp_pct),
            current_price=price,
            holding_bars=0,
            strategy_name=self.strategy.name
        )
        self.positions[symbol] = pos

        console.print(Panel(
            f"[bold green]🔔 買い注文約定 (ENTRY)![/bold green]\n"
            f"銘柄: [bold white]{pos.symbol_name} ({pos.symbol})[/bold white]\n"
            f"株数: [bold cyan]{shares}株[/bold cyan] (投資額: ¥{investment:,.0f})\n"
            f"買値: ¥{price:,.1f} | 損切り: [red]¥{pos.stop_loss_price:,.1f} (-{sl_pct*100:.1f}%)[/red] | 利確: [green]¥{pos.take_profit_price:,.1f} (+{tp_pct*100:.1f}%)[/green]",
            border_style="green"
        ))

    def _execute_exit(self, pos: Position, exit_price: float, exit_reason: ExitReason):
        """決済注文執行"""
        order_res = self.broker.place_order(
            symbol=pos.symbol,
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            shares=pos.shares,
            price=exit_price
        )

        pnl_amount = (exit_price - pos.entry_price) * pos.shares
        pnl_pct = (pnl_amount / pos.investment_amount) * 100.0
        color = "green" if pnl_amount >= 0 else "red"
        sign = "+" if pnl_amount >= 0 else ""

        # トレードオブジェクト生成 & DB保存
        trade = Trade(
            trade_id=f"LIVE-{int(time.time())}",
            symbol=pos.symbol,
            symbol_name=pos.symbol_name,
            strategy_name=pos.strategy_name,
            entry_time=pos.entry_time,
            exit_time=datetime.now(),
            entry_price=pos.entry_price,
            exit_price=exit_price,
            shares=pos.shares,
            investment_amount=pos.investment_amount,
            pnl_amount=pnl_amount,
            pnl_pct=pnl_pct,
            commission=0.0,
            holding_bars=pos.holding_bars,
            holding_days=pos.holding_bars / 5.0,
            exit_reason=exit_reason,
            notes="ペーパートレード約定",
            tags=f"#{pos.strategy_name} #LIVE"
        )
        db.save_trade(trade)

        console.print(Panel(
            f"[bold {color}]🔔 決済注文約定 (EXIT: {exit_reason.value})![/bold {color}]\n"
            f"銘柄: [bold white]{pos.symbol_name} ({pos.symbol})[/bold white]\n"
            f"決済価格: ¥{exit_price:,.1f} (買値: ¥{pos.entry_price:,.1f})\n"
            f"実現損益: [{color}]{sign}¥{pnl_amount:,.0f} ({sign}{pnl_pct:.2f}%)[/{color}]\n"
            f"保有期間: {pos.holding_bars}バー ({pos.holding_bars/5.0:.1f}営業日)",
            border_style=color
        ))

    def _display_portfolio_status(self):
        """現在の口座状況と保有ポジション一覧を表示"""
        if not self.positions:
            console.print("[dim]現在保有中のポジションはありません（シグナル待機中）。[/dim]\n")
            return

        table = Table(title="💼 現在保有中のポジション (NISA成長投資枠)", border_style="bright_blue")
        table.add_column("銘柄", style="bold white")
        table.add_column("買値", justify="right")
        table.add_column("現在値", justify="right")
        table.add_column("株数", justify="right")
        table.add_column("投資額", justify="right")
        table.add_column("含み損益", justify="right")
        table.add_column("保有バー", justify="center")

        for pos in self.positions.values():
            color = "green" if pos.unrealized_pnl >= 0 else "red"
            sign = "+" if pos.unrealized_pnl >= 0 else ""
            table.add_row(
                f"{pos.symbol_name} ({pos.symbol})",
                f"¥{pos.entry_price:,.1f}",
                f"¥{pos.current_price:,.1f}",
                f"{pos.shares}株",
                f"¥{pos.investment_amount:,.0f}",
                f"[{color}]{sign}¥{pos.unrealized_pnl:,.0f} ({sign}{pos.unrealized_pnl_pct:.2f}%)[/{color}]",
                f"{pos.holding_bars}/15"
            )
        console.print(table)
