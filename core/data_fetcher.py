"""
データ取得モジュール (core/data_fetcher.py)
東証銘柄のOHLCVローソク足1000本を高速・スマート・かっこよく取得
Richによるスタイリッシュな進行表示、アスキーアートチャート、SQLiteキャッシュ連携
"""
import os
import sys
import time
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict, Any
import pandas as pd
import numpy as np
import yfinance as yf
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn, TimeRemainingColumn
from rich.text import Text

from config.settings import DEFAULT_SETTINGS, DB_PATH
from config.symbols import get_symbol_by_code
from core.database import db

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class StockDataFetcher:
    """日本株ローソク足データ取得クラス"""

    def __init__(self, use_cache: bool = True):
        self.use_cache = use_cache

    def fetch_ohlcv(
        self,
        symbol_code: str,
        interval: str = "60m",
        target_candles: int = 1000,
        show_cool_ui: bool = True
    ) -> pd.DataFrame:
        """
        東証銘柄のローソク足を指定本数（デフォルト1000本）スマートに取得

        Parameters:
        - symbol_code: 銘柄コード (例: "4478", "4478.T")
        - interval: 時間足 ("60m", "1h", "1d" 等)
        - target_candles: 目標ローソク足本数 (デフォルト 1000本)
        - show_cool_ui: クールなUI/テーブル表示を行うか
        """
        clean_code = symbol_code.replace(".T", "")
        formatted_symbol = f"{clean_code}.T"
        symbol_info = get_symbol_by_code(clean_code)

        if show_cool_ui:
            self._print_fetch_header(symbol_info, interval, target_candles)

        # 1. キャッシュ確認
        cached_df = pd.DataFrame()
        if self.use_cache:
            try:
                cached_df = db.load_candles(formatted_symbol, interval=interval)
            except Exception as e:
                if show_cool_ui:
                    console.print(f"[yellow][WARN] キャッシュ読み込みエラー: {e}[/yellow]")

        yf_interval = "60m" if interval in ["60m", "1h"] else interval

        # 2. キャッシュの有無に応じた取得戦略
        # - キャッシュが十分（100本以上）ある場合: 直近数日分 (period="5d") のみ差分取得して高速マージ
        # - キャッシュがない/不足している場合: 過去730日分 (period="730d") をフル取得
        need_full_fetch = cached_df.empty or len(cached_df) < 100
        fetch_period = "730d" if need_full_fetch else "5d"

        df = pd.DataFrame()
        try:
            if show_cool_ui:
                desc = f"[cyan]JPX (東証) から {symbol_info['name']} の1h足{'全体' if need_full_fetch else '最新差分'}を取得中..."
                with Progress(
                    SpinnerColumn(spinner_name="dots", style="bold cyan"),
                    TextColumn("[bold bright_white]{task.description}[/bold bright_white]"),
                    BarColumn(bar_width=40, complete_style="green", finished_style="bold green"),
                    TaskProgressColumn(),
                    TimeRemainingColumn(),
                    console=console
                ) as progress:
                    fetch_task = progress.add_task(desc, total=100)
                    progress.update(fetch_task, advance=30)
                    
                    ticker = yf.Ticker(formatted_symbol)
                    raw_df = ticker.history(period=fetch_period, interval=yf_interval)
                    progress.update(fetch_task, advance=50)

                    if (raw_df is None or raw_df.empty) and need_full_fetch:
                        raw_df = ticker.history(period="2y", interval="1d" if interval == "1d" else "60m")

                    progress.update(fetch_task, completed=100)
            else:
                ticker = yf.Ticker(formatted_symbol)
                raw_df = ticker.history(period=fetch_period, interval=yf_interval)
                if (raw_df is None or raw_df.empty) and need_full_fetch:
                    raw_df = ticker.history(period="2y", interval="1d" if interval == "1d" else "60m")

            if raw_df is not None and not raw_df.empty:
                # 必要なカラムを抽出 & タイムゾーン調整
                new_df = raw_df[["Open", "High", "Low", "Close", "Volume"]].copy()
                new_df.dropna(inplace=True)
                
                # タイムゾーンを日本時間に統一
                if new_df.index.tz is not None:
                    new_df.index = new_df.index.tz_convert("Asia/Tokyo")

                # DBに保存（INSERT OR REPLACE でマージ）
                db.save_candles(new_df, formatted_symbol, interval=interval)

                # DBから最新の統合データを読み込み
                df = db.load_candles(formatted_symbol, interval=interval)
                if show_cool_ui:
                    console.print(f"[bold green][OK] 取得成功![/bold green] 最新ローソク足 (現在 {len(df)} 本蓄積) を更新しました。")
            else:
                if show_cool_ui:
                    console.print(f"[bold yellow][WARN] yfinanceからの最新データが空です。既存キャッシュを使用します。[/bold yellow]")
                df = cached_df

        except Exception as e:
            if show_cool_ui:
                console.print(f"[bold red][ERROR] データ取得エラー:[/bold red] {e}")
            if not cached_df.empty:
                df = cached_df

        # 目標本数にトリミング
        if not df.empty:
            result_df = df.tail(target_candles)
            if show_cool_ui:
                self.display_cool_summary(result_df, symbol_info)
            return result_df
        
        return pd.DataFrame()

    def _print_fetch_header(self, symbol_info: Dict[str, Any], interval: str, target_candles: int):
        """かっこいい取得ヘッダーを出力"""
        header_text = Text()
        header_text.append("⚡ 東証ローソク足データ取得エンジン\n", style="bold cyan")
        header_text.append(f"銘柄: ", style="bold white")
        header_text.append(f"{symbol_info['name']} ({symbol_info['code']})  ", style="bold green")
        header_text.append(f"市場: ", style="bold white")
        header_text.append(f"{symbol_info['market']}  ", style="yellow")
        header_text.append(f"時間軸: ", style="bold white")
        header_text.append(f"{interval}  ", style="magenta")
        header_text.append(f"目標本数: ", style="bold white")
        header_text.append(f"{target_candles}本", style="bold yellow")

        console.print(Panel(header_text, border_style="bright_blue", padding=(0, 2)))

    def display_cool_summary(self, df: pd.DataFrame, symbol_info: Dict[str, Any]):
        """ローソク足の最新状態とサマリーをかっこよくテーブル＆アスキーチャートで表示"""
        if df.empty:
            return

        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest
        change = latest["Close"] - prev["Close"]
        change_pct = (change / prev["Close"]) * 100 if prev["Close"] > 0 else 0.0

        color = "green" if change >= 0 else "red"
        sign = "+" if change >= 0 else ""

        # 1. サマリーテーブル
        table = Table(title=f"📊 最新ローソク足スナップショット [{symbol_info['name']}]", border_style="cyan")
        table.add_column("指標", style="bold white")
        table.add_column("値", justify="right", style="bold")
        table.add_column("前足比 / 備考", justify="left")

        table.add_row("最新日時", df.index[-1].strftime("%Y-%m-%d %H:%M"), "JST")
        table.add_row("始値 (Open)", f"¥{latest['Open']:,.1f}", "")
        table.add_row("高値 (High)", f"¥{latest['High']:,.1f}", "")
        table.add_row("安値 (Low)", f"¥{latest['Low']:,.1f}", "")
        table.add_row("現在値 / 終値 (Close)", f"[{color}]¥{latest['Close']:,.1f}[/{color}]", f"[{color}]{sign}¥{change:,.1f} ({sign}{change_pct:.2f}%)[/{color}]")
        table.add_row("出来高 (Volume)", f"{int(latest['Volume']):,} 株", "1h出来高")
        table.add_row("総データ本数", f"{len(df)} 本", f"{df.index[0].strftime('%Y/%m/%d')} 〜 {df.index[-1].strftime('%Y/%m/%d')}")

        console.print(table)

        # 2. 直近ミニ・アスキーアートスパークライン
        self._display_ascii_sparkline(df["Close"].tail(30).values)

    def _display_ascii_sparkline(self, prices: np.ndarray):
        """直近30バーの価格推移をアスキーアートで表示"""
        if len(prices) < 2:
            return
        
        min_p = np.min(prices)
        max_p = np.max(prices)
        if max_p == min_p:
            return
        
        bars = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
        sparkline = ""
        for p in prices:
            norm = (p - min_p) / (max_p - min_p)
            idx = int(norm * (len(bars) - 1))
            sparkline += bars[idx]

        trend_color = "green" if prices[-1] >= prices[0] else "red"
        console.print(f"[bold white]直近30本トレンド:[/bold white] [{trend_color}]{sparkline}[/{trend_color}] (Low: ¥{min_p:,.1f} → High: ¥{max_p:,.1f})")
        console.print("")

# グローバルインスタンス
fetcher = StockDataFetcher()
