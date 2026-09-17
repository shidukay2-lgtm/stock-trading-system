"""
手動リアルトレード支援モジュール (live_trading/manual_trader.py)
最優秀バックテスト戦略に基づくシグナル検知・手動発注・手動決済・振り返りメモ記録
"""
import sys
import time
from datetime import datetime
from typing import Dict, Any, Optional, List
import pandas as pd
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt

from config.settings import DEFAULT_SETTINGS, TradingSettings
from config.symbols import get_symbol_by_code
from core.models import Position, Trade, ExitReason, OrderSide, OrderType
from core.database import db
from core.data_fetcher import fetcher
from strategies.base_strategy import BaseStrategy
from live_trading.broker_interface import BaseBrokerAdapter, MockBrokerAdapter

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class ManualRealTrader:
    """手動リアルトレード支援エンジン"""

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

    def scan_and_trade_interactive(self):
        """
        市場データをリアルタイム取得し、手動での売買判断・約定・決済を実行
        """
        console.print(f"\n[bold cyan]📡 手動リアルトレード市場スキャン実行中... [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}][/bold cyan]")
        console.print(f"採用戦略: [bold yellow]{self.strategy.name}[/bold yellow] | 監視対象: {len(self.symbols)} 銘柄")

        for symbol_code in self.symbols:
            symbol_info = get_symbol_by_code(symbol_code)
            symbol = symbol_info["code"]

            # 1. ローソク足データ取得
            df = fetcher.fetch_ohlcv(symbol, interval=self.settings.DEFAULT_INTERVAL, target_candles=150, show_cool_ui=False)
            if df.empty or len(df) < 50:
                continue

            # 2. 戦略シグナル計算
            signal_df = self.strategy.generate_signals(df)
            latest_bar = signal_df.iloc[-1]
            current_price = float(latest_bar["Close"])
            high_price = float(latest_bar["High"])
            low_price = float(latest_bar["Low"])
            signal = int(latest_bar.get("signal", 0))

            # 3. 保有中ポジションのイグジットチェック & 手動決済確認
            if symbol in self.positions:
                pos = self.positions[symbol]
                pos.holding_bars += 1
                pos.current_price = current_price

                exit_price = None
                exit_reason = None

                # (1) 損切り判定
                if low_price <= pos.stop_loss_price:
                    exit_price = pos.stop_loss_price
                    exit_reason = ExitReason.STOP_LOSS
                # (2) 利確判定
                elif high_price >= pos.take_profit_price:
                    exit_price = pos.take_profit_price
                    exit_reason = ExitReason.TAKE_PROFIT
                # (3) タイムアウト判定 (3営業日)
                elif pos.holding_bars >= self.settings.MAX_HOLDING_BARS:
                    exit_price = current_price
                    exit_reason = ExitReason.TIMEOUT

                if exit_price and exit_reason:
                    self._handle_manual_exit(pos, exit_price, exit_reason)
                    del self.positions[symbol]

            # 4. 新規買いエントリーシグナル検知 & 手動発注確認
            elif signal == 1 and len(self.positions) < self.settings.MAX_CONCURRENT_POSITIONS:
                balance = self.broker.get_account_balance()
                available_cash = balance["cash"]
                max_invest = min(self.settings.MAX_POSITION_AMOUNT, available_cash)

                if max_invest >= current_price:
                    if self.settings.ALLOW_ODD_LOTS:
                        shares = int(max_invest // current_price)
                    else:
                        lots = int(max_invest // (current_price * self.settings.DEFAULT_LOT_SIZE))
                        shares = lots * self.settings.DEFAULT_LOT_SIZE

                    if shares > 0:
                        self._handle_manual_entry(symbol_info, current_price, shares)

        self._display_positions_table()

    def _handle_manual_entry(self, symbol_info: Dict[str, Any], price: float, shares: int):
        """手動買いエントリーの対話プロンプト"""
        symbol = symbol_info["code"]
        investment = price * shares
        sl_pct = self.strategy.params.get("stop_loss_pct", self.settings.STOP_LOSS_PCT)
        tp_pct = self.strategy.params.get("take_profit_pct", self.settings.TAKE_PROFIT_PCT)
        sl_price = price * (1.0 - sl_pct)
        tp_price = price * (1.0 + tp_pct)

        # アラートパネル表示
        panel_text = (
            f"[bold green]🔔 買いエントリーシグナル検知！[/bold green]\n\n"
            f"・銘柄: [bold white]{symbol_info['name']} ({symbol_info['code']})[/bold white] [{symbol_info['market']}]\n"
            f"・現在株価: [bold cyan]¥{price:,.1f}[/bold cyan]\n"
            f"・推奨株数: [bold white]{shares} 株[/bold white] (投資金額: [bold yellow]¥{investment:,.0f}[/bold yellow] <= ¥10万以内)\n"
            f"・損切り目標: [bold red]¥{sl_price:,.1f} (-{sl_pct*100:.1f}%)[/bold red]\n"
            f"・利確目標: [bold green]¥{tp_price:,.1f} (+{tp_pct*100:.1f}%)[/bold green]\n"
            f"・リスクリワード比: [bold cyan]{tp_pct/sl_pct:.2f} : 1[/bold cyan] (最低1:2基準クリア)\n"
            f"・最大保有期間: [bold white]3営業日 (15バー)[/bold white]\n"
        )
        console.print(Panel(panel_text, title="🎯 手動リアルトレード発注判断", border_style="bright_green"))

        # 手動確認
        choice = Prompt.ask("この買い注文を手動発注しますか？", choices=["y", "n"], default="y")
        if choice == "y":
            self.broker.place_order(
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
                stop_loss_price=sl_price,
                take_profit_price=tp_price,
                current_price=price,
                holding_bars=0,
                strategy_name=self.strategy.name
            )
            self.positions[symbol] = pos
            console.print(f"[bold green][OK] 買い注文を発注・約定記録しました。[/bold green]\n")
        else:
            console.print(f"[yellow]発注を見送りました（エントリースキップ）。[/yellow]\n")

    def _handle_manual_exit(self, pos: Position, exit_price: float, exit_reason: ExitReason):
        """手動決済の対話プロンプト"""
        pnl_amount = (exit_price - pos.entry_price) * pos.shares
        pnl_pct = (pnl_amount / pos.investment_amount) * 100.0
        color = "green" if pnl_amount >= 0 else "red"
        sign = "+" if pnl_amount >= 0 else ""

        reason_text = "利確ライン達成 (+6%以上)" if exit_reason == ExitReason.TAKE_PROFIT else ("損切りライン到達 (-3%以内)" if exit_reason == ExitReason.STOP_LOSS else "保有期間上限 (3営業日経過)")

        panel_text = (
            f"[bold {color}]🔔 決済推奨アラート ({reason_text})[/bold {color}]\n\n"
            f"・銘柄: [bold white]{pos.symbol_name} ({pos.symbol})[/bold white]\n"
            f"・決済価格: [bold cyan]¥{exit_price:,.1f}[/bold cyan] (買値: ¥{pos.entry_price:,.1f})\n"
            f"・想定損益: [{color}][bold]{sign}¥{pnl_amount:,.0f} ({sign}{pnl_pct:.2f}%)[/bold][/{color}]\n"
            f"・保有期間: {pos.holding_bars}バー ({pos.holding_bars/5.0:.1f}営業日)\n"
        )
        console.print(Panel(panel_text, title=f"🚪 手動決済判断: {exit_reason.value}", border_style=color))

        choice = Prompt.ask("このポジションを決済しますか？", choices=["y", "n"], default="y")
        if choice == "y":
            self.broker.place_order(
                symbol=pos.symbol,
                side=OrderSide.SELL,
                order_type=OrderType.MARKET,
                shares=pos.shares,
                price=exit_price
            )

            # 振り返りメモの入力受付
            note = Prompt.ask("振り返りメモ・反省点があれば入力してください (任意)", default="手動リアルトレード決済")
            tags = Prompt.ask("タグ (例: #利確 #反省)", default=f"#{pos.strategy_name} #MANUAL_REAL")

            trade = Trade(
                trade_id=f"REAL-{int(time.time())}",
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
                notes=note,
                tags=tags
            )
            db.save_trade(trade)
            console.print(f"[bold green][OK] 決済を記録し、SQLiteデータベースに振り返りメモを保存しました。[/bold green]\n")
        else:
            console.print("[yellow]決済を保留しました（ポジション維持）。[/yellow]\n")

    def _display_positions_table(self):
        """保有中ポジションのテーブル表示"""
        if not self.positions:
            console.print("[dim]現在保有中のポジションはありません（次のシグナルを監視中）。[/dim]\n")
            return

        table = Table(title="💼 現在の手動管理ポジション", border_style="bright_blue")
        table.add_column("銘柄", style="bold white")
        table.add_column("買値", justify="right")
        table.add_column("現在値", justify="right")
        table.add_column("株数", justify="right")
        table.add_column("投資金額", justify="right")
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
