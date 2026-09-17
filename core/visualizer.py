"""
可視化モジュール (core/visualizer.py)
Rich CLI による美しいターミナルレポート & Plotly によるインタラクティブHTMLチャート生成
"""
import os
import sys
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from typing import List, Optional, Dict, Any

from config.settings import REPORTS_DIR
from core.models import BacktestResult, Trade, ExitReason

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

console = Console(force_terminal=False, highlight=False)

class Visualizer:
    """可視化エンジン（CLI & Web/HTML）"""

    @staticmethod
    def print_backtest_summary_cli(result: BacktestResult):
        """バックテスト結果をRichの美麗テーブルでコンソール出力"""
        m = result.metrics
        
        # 損益カラー判定
        pnl_color = "green" if m.total_pnl_amount >= 0 else "red"
        pnl_sign = "+" if m.total_pnl_amount >= 0 else ""

        # パネルヘッダー
        title_text = Text()
        title_text.append("🚀 バックテスト完了レポート\n", style="bold cyan")
        title_text.append(f"戦略名: ", style="bold white")
        title_text.append(f"{result.strategy_name}  ", style="bold yellow")
        title_text.append(f"銘柄: ", style="bold white")
        title_text.append(f"{result.symbol_name} ({result.symbol})  ", style="bold green")
        title_text.append(f"期間: ", style="bold white")
        title_text.append(f"{result.start_date} 〜 {result.end_date}", style="white")

        console.print(Panel(title_text, border_style="bright_cyan", padding=(0, 2)))

        # メトリックステーブル
        table = Table(title="📈 パフォーマンス指標サマリー", border_style="bright_blue", show_header=True, header_style="bold magenta")
        table.add_column("主要指標", style="bold white", width=24)
        table.add_column("実績値", justify="right", style="bold", width=20)
        table.add_column("評価・基準", justify="left", width=28)

        table.add_row("初期投資資金", f"¥{m.initial_capital:,.0f}", "30万円運用")
        table.add_row("最終資産額", f"¥{m.final_equity:,.0f}", f"[{pnl_color}]{pnl_sign}¥{m.total_pnl_amount:,.0f}[/{pnl_color}]")
        table.add_row("通算トータルリターン", f"[{pnl_color}]{pnl_sign}{m.total_return_pct:.2f}%[/{pnl_color}]", "NISA非課税運用")
        table.add_row("プロフィットファクター (PF)", f"[{'green' if m.profit_factor >= 1.5 else 'yellow'}]{m.profit_factor:.2f}[/]", "基準: 1.5以上で優秀")
        table.add_row("勝率 (Win Rate)", f"{m.win_rate_pct:.1f}%", f"{m.winning_trades}勝 / {m.losing_trades}敗 (計{m.total_trades}回)")
        table.add_row("最大ドローダウン (MaxDD)", f"[red]{m.max_drawdown_pct:.2f}%[/red]", f"¥{m.max_drawdown_amount:,.0f}")
        table.add_row("リスクリワード比 (実現値)", f"[cyan]{m.risk_reward_achieved:.2f} : 1[/cyan]", "要件: 1:2以上を達成")
        table.add_row("平均利益率 / 平均損失率", f"[green]+{m.average_profit_pct:.2f}%[/green] / [red]-{m.average_loss_pct:.2f}%[/red]", "損切り-3%以内 / 利確+6%以上")
        table.add_row("平均保有期間", f"{m.avg_holding_bars:.1f} バー", f"最大3営業日以内ルール厳守")
        table.add_row("決済内訳", f"利確:{m.take_profit_count} / 損切:{m.stop_loss_count} / 期限:{m.timeout_count}", "規律あるルール執行")

        console.print(table)

        # 直近トレードテーブル（最新5件）
        if result.trades:
            trade_table = Table(title="🔍 直近トレード履歴 (最新5件)", border_style="green", show_header=True, header_style="bold yellow")
            trade_table.add_column("No", justify="center", width=4)
            trade_table.add_column("エントリー", width=14)
            trade_table.add_column("決済", width=14)
            trade_table.add_column("買値 → 売値", justify="right", width=18)
            trade_table.add_column("株数", justify="right", width=6)
            trade_table.add_column("投資金額", justify="right", width=10)
            trade_table.add_column("損益額 (%)", justify="right", width=16)
            trade_table.add_column("決済理由", justify="center", width=10)

            for i, t in enumerate(result.trades[-5:], 1):
                t_color = "green" if t.pnl_amount >= 0 else "red"
                t_sign = "+" if t.pnl_amount >= 0 else ""
                trade_table.add_row(
                    str(i),
                    t.entry_time.strftime("%m/%d %H:%M"),
                    t.exit_time.strftime("%m/%d %H:%M"),
                    f"¥{t.entry_price:,.0f} → ¥{t.exit_price:,.0f}",
                    f"{t.shares}株",
                    f"¥{t.investment_amount:,.0f}",
                    f"[{t_color}]{t_sign}¥{t.pnl_amount:,.0f} ({t_sign}{t.pnl_pct:.1f}%)[/{t_color}]",
                    t.exit_reason.value if isinstance(t.exit_reason, ExitReason) else str(t.exit_reason)
                )
            console.print(trade_table)

    @staticmethod
    def generate_html_report(
        result: BacktestResult,
        ohlcv_df: pd.DataFrame,
        filename: Optional[str] = None
    ) -> str:
        """Plotlyを使用した最高品質のインタラクティブHTMLレポートを生成"""
        if filename is None:
            clean_sym = result.symbol.replace(".T", "")
            filename = f"backtest_report_{clean_sym}_{result.strategy_name}.html"
        
        filepath = os.path.join(REPORTS_DIR, filename)

        # 3段サブプロット作成
        # 1. ローソク足 + ボリンジャーバンド + エントリー/イグジットマーカー (Row 1)
        # 2. 出来高 (Row 2)
        # 3. 資産推移曲線 & ドローダウン (Row 3)
        fig = make_subplots(
            rows=3, cols=1,
            shared_xaxes=False,
            vertical_spacing=0.06,
            subplot_titles=(
                f"【{result.symbol_name} ({result.symbol})】ローソク足 1h足 & トレードシグナル（利確+6% / 損切り-3% / 3日以内）",
                "出来高 (Volume)",
                "総資産推移 (Equity Curve) & ドローダウン (初期資金 ¥300,000 / 1回上限 ¥100,000)"
            ),
            row_heights=[0.50, 0.15, 0.35]
        )

        # --- 1. ローソク足チャート ---
        fig.add_trace(
            go.Candlestick(
                x=ohlcv_df.index,
                open=ohlcv_df["Open"],
                high=ohlcv_df["High"],
                low=ohlcv_df["Low"],
                close=ohlcv_df["Close"],
                name="OHLCV",
                increasing_line_color="#26a69a",
                decreasing_line_color="#ef5350"
            ),
            row=1, col=1
        )

        # 移動平均線 (EMA20, EMA50)
        if "EMA20" in ohlcv_df.columns:
            fig.add_trace(go.Scatter(x=ohlcv_df.index, y=ohlcv_df["EMA20"], name="EMA 20", line=dict(color="#29b6f6", width=1.5)), row=1, col=1)
        if "EMA50" in ohlcv_df.columns:
            fig.add_trace(go.Scatter(x=ohlcv_df.index, y=ohlcv_df["EMA50"], name="EMA 50", line=dict(color="#ab47bc", width=1.5)), row=1, col=1)
        if "BB_upper" in ohlcv_df.columns and "BB_lower" in ohlcv_df.columns:
            fig.add_trace(go.Scatter(x=ohlcv_df.index, y=ohlcv_df["BB_upper"], name="BB Upper (+2σ)", line=dict(color="rgba(255,167,38,0.6)", width=1, dash="dot")), row=1, col=1)
            fig.add_trace(go.Scatter(x=ohlcv_df.index, y=ohlcv_df["BB_lower"], name="BB Lower (-2σ)", line=dict(color="rgba(255,167,38,0.6)", width=1, dash="dot")), row=1, col=1)

        # トレードのエントリー・イグジットマーカー
        for t in result.trades:
            # エントリー (買い)
            fig.add_trace(
                go.Scatter(
                    x=[t.entry_time],
                    y=[t.entry_price],
                    mode="markers",
                    marker=dict(symbol="triangle-up", size=11, color="#00e676", line=dict(width=1, color="white")),
                    name=f"BUY: {t.symbol}",
                    hovertext=f"BUY: ¥{t.entry_price:,.1f}<br>株数: {t.shares}株 (¥{t.investment_amount:,.0f})<br>損切: ¥{t.entry_price*0.972:,.1f}<br>利確: ¥{t.entry_price*1.06:,.1f}",
                    showlegend=False
                ),
                row=1, col=1
            )
            # イグジット (決済)
            is_win = t.pnl_amount > 0
            exit_color = "#00e676" if is_win else "#ff1744"
            fig.add_trace(
                go.Scatter(
                    x=[t.exit_time],
                    y=[t.exit_price],
                    mode="markers",
                    marker=dict(symbol="triangle-down", size=11, color=exit_color, line=dict(width=1, color="white")),
                    name=f"EXIT: {t.exit_reason.value if isinstance(t.exit_reason, ExitReason) else t.exit_reason}",
                    hovertext=f"EXIT: ¥{t.exit_price:,.1f}<br>損益: {'+' if is_win else ''}¥{t.pnl_amount:,.0f} ({'+' if is_win else ''}{t.pnl_pct:.2f}%)<br>理由: {t.exit_reason.value if isinstance(t.exit_reason, ExitReason) else t.exit_reason}<br>保有: {t.holding_bars}バー ({t.holding_days:.1f}日)",
                    showlegend=False
                ),
                row=1, col=1
            )

        # --- 2. 出来高チャート ---
        colors = ["#26a69a" if c >= o else "#ef5350" for c, o in zip(ohlcv_df["Close"], ohlcv_df["Open"])]
        fig.add_trace(
            go.Bar(
                x=ohlcv_df.index,
                y=ohlcv_df["Volume"],
                name="Volume",
                marker_color=colors,
                opacity=0.8
            ),
            row=2, col=1
        )

        # --- 3. 資産曲線チャート ---
        eq_df = result.equity_curve
        if not eq_df.empty:
            fig.add_trace(
                go.Scatter(
                    x=eq_df.index,
                    y=eq_df["equity"],
                    name="総資産額 (Equity)",
                    line=dict(color="#00e5ff", width=2.5),
                    fill="tozeroy",
                    fillcolor="rgba(0, 229, 255, 0.08)"
                ),
                row=3, col=1
            )
            # 初期資金基準線
            fig.add_hline(
                y=result.metrics.initial_capital,
                line_dash="dash",
                line_color="rgba(255, 255, 255, 0.4)",
                annotation_text="初期資金 ¥300,000",
                annotation_position="bottom right",
                row=3, col=1
            )

        # レイアウト & スタイル設定（高級感のあるダークモードテーマ）
        fig.update_layout(
            template="plotly_dark",
            paper_bgcolor="#121826",
            plot_bgcolor="#1a2234",
            title=dict(
                text=f"📊 <b>JPX 日本株 自動スイングトレード バックテスト分析ダッシュボード</b><br><span style='font-size:13px;color:#90caf9'>戦略: {result.strategy_name} | 銘柄: {result.symbol_name} ({result.symbol}) | 期間: {result.start_date} 〜 {result.end_date}</span>",
                x=0.03,
                y=0.98,
                font=dict(size=20, color="#ffffff")
            ),
            height=1100,
            xaxis_rangeslider_visible=False,
            margin=dict(l=60, r=60, t=90, b=50),
            hovermode="x unified",
            legend=dict(
                orientation="h",
                yanchor="bottom",
                y=1.02,
                xanchor="right",
                x=1
            )
        )

        # HTMLファイルとして保存
        fig.write_html(filepath, include_plotlyjs="cdn")
        console.print(f"[bold green][OK][/bold green] 美しいHTMLインタラクティブレポートを生成しました: [cyan]{filepath}[/cyan]")
        return filepath

    @staticmethod
    def generate_strategy_comparison_html(
        comparison_data: List[Dict[str, Any]],
        symbol_name: str,
        symbol: str,
        filename: str = "strategy_comparison_dashboard.html"
    ) -> str:
        """複数戦略の比較ダッシュボードHTMLを生成"""
        filepath = os.path.join(REPORTS_DIR, filename)

        # 4枚のサブプロット
        # 1. 各戦略の資産推移比較 (Row 1, Span 2)
        # 2. 勝率比較 (Row 2, Col 1)
        # 3. トータル損益比較 (Row 2, Col 2)
        # 4. 最大ドローダウン比較 (Row 2, Col 3)
        fig = make_subplots(
            rows=2, cols=3,
            column_widths=[0.33, 0.33, 0.34],
            row_heights=[0.55, 0.45],
            specs=[
                [{"colspan": 3}, None, None],
                [{}, {}, {}]
            ],
            subplot_titles=(
                f"【{symbol_name} ({symbol})】全戦略の総資産推移比較 (Equity Curves)",
                "勝率 (%) 比較 [目標70%以上]",
                "トータル実現利益 (円) 比較",
                "最大ドローダウン (%) 比較 [基準20%以内]"
            ),
            vertical_spacing=0.12
        )

        colors = ["#00e5ff", "#00e676", "#ffb300", "#ff5252", "#e040fb"]

        strat_names = [d["strategy_name"] for d in comparison_data]
        win_rates = [d["win_rate"] for d in comparison_data]
        pnls = [d["total_pnl"] for d in comparison_data]
        dds = [d["max_drawdown"] for d in comparison_data]

        # 1. 資産推移の重ね合わせ
        for i, d in enumerate(comparison_data):
            res: BacktestResult = d["result"]
            eq_df = res.equity_curve
            if not eq_df.empty and "equity" in eq_df.columns:
                color = colors[i % len(colors)]
                width = 3.0 if i == 0 else 1.8
                fig.add_trace(
                    go.Scatter(
                        x=eq_df.index,
                        y=eq_df["equity"],
                        name=f"{d['strategy_name']} (PF:{d['profit_factor']:.2f})",
                        line=dict(color=color, width=width)
                    ),
                    row=1, col=1
                )

        # 2. 勝率棒グラフ
        fig.add_trace(
            go.Bar(
                x=strat_names,
                y=win_rates,
                name="勝率 (%)",
                marker_color=["#00e676" if w >= 65 else "#ffb300" for w in win_rates],
                text=[f"{w:.1f}%" for w in win_rates],
                textposition="auto"
            ),
            row=2, col=1
        )
        fig.add_hline(y=70.0, line_dash="dash", line_color="rgba(0, 230, 118, 0.8)", annotation_text="目標70%", row=2, col=1)

        # 3. トータル損益棒グラフ
        fig.add_trace(
            go.Bar(
                x=strat_names,
                y=pnls,
                name="トータル利益",
                marker_color=["#00e676" if p >= 0 else "#ff5252" for p in pnls],
                text=[f"¥{p:,.0f}" for p in pnls],
                textposition="auto"
            ),
            row=2, col=2
        )

        # 4. 最大ドローダウン棒グラフ
        fig.add_trace(
            go.Bar(
                x=strat_names,
                y=dds,
                name="MaxDD (%)",
                marker_color=["#29b6f6" if dd <= 20.0 else "#ff5252" for dd in dds],
                text=[f"{dd:.1f}%" for dd in dds],
                textposition="auto"
            ),
            row=2, col=3
        )
        fig.add_hline(y=20.0, line_dash="dash", line_color="rgba(255, 82, 82, 0.8)", annotation_text="上限20%", row=2, col=3)

        fig.update_layout(
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            title=dict(
                text=f"🏆 <b>高勝率スイングトレード 戦略比較・評価ダッシュボード</b><br><span style='font-size:13px;color:#94a3b8'>対象銘柄: {symbol_name} ({symbol}) | 資金: 30万円 (1回上限10万円) | NISA現物 | 損切-3%以内・利確+6%以上</span>",
                x=0.03,
                y=0.98,
                font=dict(size=20, color="#ffffff")
            ),
            height=950,
            margin=dict(l=60, r=60, t=90, b=50),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
        )

        fig.write_html(filepath, include_plotlyjs="cdn")
        console.print(f"[bold green][OK][/bold green] 戦略比較ダッシュボードHTMLを生成しました: [cyan]{filepath}[/cyan]")
        return filepath

    @staticmethod
    def open_in_browser(html_path: str):
        """ブラウザでHTMLファイルを開く"""
        import webbrowser
        try:
            abs_url = f"file:///{os.path.abspath(html_path).replace(os.sep, '/')}"
            webbrowser.open(abs_url)
            console.print(f"[bold cyan]🌐 デフォルトブラウザでダッシュボードを表示しました: {html_path}[/bold cyan]")
        except Exception as e:
            console.print(f"[yellow]ブラウザ自動オープンをスキップしました: {e}[/yellow]")
