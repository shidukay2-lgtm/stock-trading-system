"""
メイン実行エントリーポイント (main.py)
stock_trading_system: 高勝率・日本株小型成長株向け自動スイングトレード・バックテストシステム
"""
import sys
import os
import argparse
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt, IntPrompt
from rich.text import Text

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from config.settings import DEFAULT_SETTINGS, DB_PATH, REPORTS_DIR
from config.symbols import GROWTH_SMALL_CAP_SYMBOLS, get_symbol_by_code, get_affordable_symbols
from core.data_fetcher import fetcher
from core.database import db
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
from live_trading.paper_trader import PaperTrader
from live_trading.manual_trader import ManualRealTrader
from review.journal import TradeJournal

console = Console(force_terminal=False, highlight=False)

def print_banner():
    """システムバナー表示"""
    banner = Text()
    banner.append("=====================================================================\n", style="bold cyan")
    banner.append("   🚀 stock_trading_system : 高勝率・日本株スイングトレードシステム   \n", style="bold bright_white")
    banner.append("   【NISA現物 / 10万円以下成長小型株 / 勝率7割目標 / RR比1:2+ / 3日以内】\n", style="bold yellow")
    banner.append("=====================================================================", style="bold cyan")
    console.print(Panel(banner, border_style="cyan", padding=(0, 2)))

def run_strategy_comparison_flow(symbol_code: str = "4477", auto_open_browser: bool = True):
    """複数戦略を過去3年間データで比較検証し、最優秀戦略を選定＆Webダッシュボード生成"""
    symbol_info = get_symbol_by_code(symbol_code)
    symbol = symbol_info["code"]

    console.print(f"\n[bold bright_white]1. ローソク足データ取得開始...[/bold bright_white]")
    df = fetcher.fetch_ohlcv(symbol, interval=DEFAULT_SETTINGS.DEFAULT_INTERVAL, target_candles=1000, show_cool_ui=True)

    if df.empty or len(df) < 50:
        console.print(f"[bold red]❌ データが不足しているためバックテストを実行できません。[/bold red]")
        return None, None

    # 2. 全戦略の比較実行
    best_strategy, best_result, comparison_data = StrategyComparator.compare_strategies(
        df=df, symbol=symbol, symbol_name=symbol_info["name"]
    )

    # 3. 最優秀戦略の詳細サマリー表示
    console.print("\n[bold bright_white]2. 🏆 最優秀戦略の詳細パフォーマンス[/bold bright_white]")
    Visualizer.print_backtest_summary_cli(best_result)

    # 4. WebブラウザダッシュボードHTML生成
    comp_html = Visualizer.generate_strategy_comparison_html(
        comparison_data=comparison_data,
        symbol_name=symbol_info["name"],
        symbol=symbol
    )
    detail_html = BacktestReporter.generate_report(best_result, df)
    csv_path = BacktestReporter.export_trades_csv(best_result)

    if auto_open_browser:
        Visualizer.open_in_browser(comp_html)

    return best_strategy, comp_html

def run_manual_trading_flow(symbol_code: str = "4477"):
    """手動リアルトレード実行フロー"""
    symbol_info = get_symbol_by_code(symbol_code)
    # 最優秀戦略（HighWinTrendPullback）を採用
    strategy = HighWinTrendPullbackStrategy()

    console.print(f"\n[bold bright_white]🎯 手動リアルトレード支援モード起動[/bold bright_white]")
    console.print(f"採用戦略: [bold green]{strategy.name}[/bold green] (勝率7割目標 / RR比 2.14:1 / 最大3日保有)")
    console.print(f"監視対象: [bold white]{symbol_info['name']} ({symbol_info['code']})[/bold white]")

    trader = ManualRealTrader(strategy=strategy, symbols=[symbol_info["code"]])
    trader.scan_and_trade_interactive()

def interactive_menu():
    """対話型メインメニュー"""
    print_banner()

    while True:
        console.print("\n[bold cyan]=== 操作メニュー ===[/bold cyan]")
        console.print("1. [bold green]🔍 10万円以下で購入可能な高成長小型株のスクリーニング[/bold green] (ファンダメンタルズ選定)")
        console.print("2. [bold yellow]🏆 複数戦略の過去相場バックテスト比較 & 最良戦略選定 & Web可視化[/bold yellow]")
        console.print("3. [bold cyan]🎯 手動リアルトレード実行・発注支援[/bold cyan] (最良戦略シグナルで手動判断)")
        console.print("4. [bold magenta]📈 個別銘柄のローソク足取得 & クール表示[/bold magenta]")
        console.print("5. [bold blue]📖 トレード履歴・振り返りジャーナル閲覧 & メモ記録[/bold blue]")
        console.print("6. [bold white]⚙️ システム設定・口座ルール確認[/bold white]")
        console.print("0. 終了")

        choice = Prompt.ask("\n選択してください", choices=["1", "2", "3", "4", "5", "6", "0"], default="2")

        if choice == "1":
            stocks = StockScreener.screen_growth_stocks(max_investment=100000.0, min_sales_growth=15.0)
            StockScreener.display_screened_table(stocks)

        elif choice == "2":
            console.print("\n[bold]10万円以下で買える成長性小型株リスト:[/bold]")
            affordable = get_affordable_symbols(100000.0)
            for i, s in enumerate(affordable, 1):
                console.print(f"  {i}. {s['name']} ({s['code']}) - 投資額: ¥{s['lot_investment_approx']:,.0f} (売上成長率 {s['sales_growth_rate']})")
            code_input = Prompt.ask("\nバックテスト対象の銘柄コード (例: 4477, 7383, 2158, 4478, 5253)", default="4477")
            run_strategy_comparison_flow(symbol_code=code_input, auto_open_browser=True)

        elif choice == "3":
            code_input = Prompt.ask("手動リアルトレード対象の銘柄コード (例: 4477, 7383, 2158)", default="4477")
            run_manual_trading_flow(symbol_code=code_input)

        elif choice == "4":
            code_input = Prompt.ask("銘柄コード (例: 4477, 7383, 2158)", default="4477")
            fetcher.fetch_ohlcv(code_input, target_candles=1000, show_cool_ui=True)

        elif choice == "5":
            TradeJournal.show_overall_stats()
            TradeJournal.show_trade_history(limit=10)
            note_action = Prompt.ask("振り返りメモを追加しますか？ (y/n)", choices=["y", "n"], default="n")
            if note_action == "y":
                tid = Prompt.ask("Trade ID を入力")
                note = Prompt.ask("振り返りメモ・反省点")
                tags = Prompt.ask("タグ (例: #利確成功 #反省)", default="#振り返り")
                TradeJournal.add_note_to_trade(tid, note, tags)

        elif choice == "6":
            console.print("\n[bold cyan]📋 システム設定 & NISA口座運用ルール[/bold cyan]")
            console.print(f"・総運用資金: ¥{DEFAULT_SETTINGS.INITIAL_CAPITAL:,.0f}")
            console.print(f"・1回最大投資額: ¥{DEFAULT_SETTINGS.MAX_POSITION_AMOUNT:,.0f} (常に10万円以下)")
            console.print(f"・損切りライン: -{DEFAULT_SETTINGS.STOP_LOSS_PCT*100:.1f}% (要件: -3%以内)")
            console.print(f"・利確ライン: +{DEFAULT_SETTINGS.TAKE_PROFIT_PCT*100:.1f}% (要件: +6%以上, RR比 2.14:1以上)")
            console.print(f"・最大保有期間: {DEFAULT_SETTINGS.MAX_HOLDING_BARS} バー (3営業日以内)")
            console.print(f"・NISA口座設定: 現物取引 / 売買手数料0円 / 非課税")

        elif choice == "0":
            console.print("[cyan]システムを終了します。[/cyan]")
            break

def main():
    parser = argparse.ArgumentParser(description="stock_trading_system CLI")
    parser.add_argument("--symbol", type=str, help="銘柄コード (例: 4477)")
    parser.add_argument("--compare", action="store_true", help="複数戦略をバックテスト比較検証")
    parser.add_argument("--manual", action="store_true", help="手動リアルトレードを実行")
    parser.add_argument("--screen", action="store_true", help="10万円以内成長小型株をスクリーニング")
    parser.add_argument("--stats", action="store_true", help="通算統計と履歴を表示")

    parser.add_argument("--web", action="store_true", help="Webブラウザダッシュボードを起動")
    parser.add_argument("--port", type=int, default=8080, help="Webサーバーポート (デフォルト: 8080)")

    args = parser.parse_args()

    if args.web:
        import http.server
        import socketserver
        import webbrowser
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
        os.chdir(web_dir)
        handler = http.server.SimpleHTTPRequestHandler
        with socketserver.TCPServer(("", args.port), handler) as httpd:
            url = f"http://localhost:{args.port}/index.html"
            console.print(f"\n[bold green][OK] Webダッシュボードサーバー起動中: [cyan]{url}[/cyan][/bold green]")
            console.print("[dim]※ Ctrl+C で終了します。スマホからアクセスする場合は同じWi-Fi内のIPアドレスを指定してください。[/dim]\n")
            try:
                webbrowser.open(url)
            except Exception:
                pass
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                console.print("\n[cyan]サーバーを停止しました。[/cyan]")
    elif args.screen:
        stocks = StockScreener.screen_growth_stocks()
        StockScreener.display_screened_table(stocks)
    elif args.compare and args.symbol:
        run_strategy_comparison_flow(symbol_code=args.symbol, auto_open_browser=True)
    elif args.manual and args.symbol:
        run_manual_trading_flow(symbol_code=args.symbol)
    elif args.stats:
        TradeJournal.show_overall_stats()
        TradeJournal.show_trade_history()
    else:
        interactive_menu()

if __name__ == "__main__":
    main()
