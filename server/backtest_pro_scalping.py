"""
プロ仕様 高速スキャルピング・デイトレ戦略 3年間バックテスト＆銘柄スクリーニング (server/backtest_pro_scalping.py)
日本の著名専業デイトレーダー手法:
1. 素早い利食い目標 (+1.2% 〜 +1.6%)
2. 動的プロフィットロック (+0.7% 到達で損切りを買値+0.1%へ引き上げ・損失転落完全防止)
3. 動的トレーリングストップ (+1.0%到達後、ピーク高値から-0.3%反落で勝ち逃げ成行利食い)
4. 超短期EMA支持線割れ決済 (モメンタム失速で即利確)
5. 最大保有4〜6バー (短時間完結・当日大引け手仕舞い)
"""
import sys
import os
import json
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from core.data_fetcher import StockDataFetcher

# 監視候補銘柄リスト (10万円以内 成長小型株・高ボラ銘柄)
CANDIDATE_SYMBOLS = [
    {"code": "4477.T", "name": "BASE", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "7383.T", "name": "ネットプロHD", "market": "東証プライム", "sector": "サービス"},
    {"code": "7085.T", "name": "カーブスHD", "market": "東証プライム", "sector": "サービス"},
    {"code": "2484.T", "name": "出前館", "market": "東証スタンダード", "sector": "情報・通信"},
    {"code": "4436.T", "name": "ミンカブ", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "5246.T", "name": "ELEMENTS", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "4482.T", "name": "ユナイト＆グロウ", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "2158.T", "name": "FRONTEO", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "5026.T", "name": "トリプルアイズ", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "5586.T", "name": "Laboro.AI", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "7094.T", "name": "NexTone", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "4476.T", "name": "AI CROSS", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "7354.T", "name": "DmMiX", "market": "東証プライム", "sector": "サービス"},
    {"code": "3936.T", "name": "グローバルウェイ", "market": "東証スタンダード", "sector": "情報・通信"},
    {"code": "3903.T", "name": "gumi", "market": "東証プライム", "sector": "情報・通信"},
    {"code": "5240.T", "name": "monoAI", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "4487.T", "name": "スペースマーケット", "market": "東証グロース", "sector": "情報・通信"},
    {"code": "4016.T", "name": "MIT HD", "market": "東証スタンダード", "sector": "情報・通信"},
    {"code": "3993.T", "name": "PKSHA", "market": "東証プライム", "sector": "情報・通信"},
    {"code": "4443.T", "name": "Sansan", "market": "東証プライム", "sector": "情報・通信"}
]

def run_pro_scalping_backtest(df, initial_capital=300000.0):
    if df is None or len(df) < 50:
        return None

    df = df.copy()
    close = df['Close']
    high = df['High']
    low = df['Low']
    open_p = df['Open']
    vol = df['Volume']

    # インジケーター計算
    # 1. 超短期 EMA
    ema5 = close.ewm(span=5, adjust=False).mean()
    ema10 = close.ewm(span=10, adjust=False).mean()
    ema25 = close.ewm(span=25, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()

    # 2. 短期 VWAP
    tp = (high + low + close) / 3.0
    cum_vol = vol.cumsum()
    cum_tp_vol = (tp * vol).cumsum()
    vwap = (cum_tp_vol / cum_vol.replace(0, np.nan)).ffill()

    # 3. 短期 RSI(9)
    diff = close.diff()
    gain = (diff.where(diff > 0, 0)).rolling(9).mean()
    loss = (-diff.where(diff < 0, 0)).rolling(9).mean()
    rs = gain / (loss.replace(0, 1e-9))
    rsi9 = 100 - (100 / (1 + rs))

    # 4. 板気配インバランス推計
    range_hl = (high - low).replace(0, 0.001)
    buying_pressure = ((close - low) / range_hl) * vol
    bp_ma = buying_pressure.rolling(6).mean()
    imbalance = buying_pressure / (bp_ma.replace(0, 1))

    # 出来高平均
    vol_ma = vol.rolling(15).mean()

    # トレード実行シミュレーション
    trades = []
    in_pos = False
    entry_idx = 0
    entry_price = 0.0
    entry_time = ""
    max_price_since_entry = 0.0
    stop_price = 0.0
    target_price = 0.0

    # パラメータ設定 (プロ仕様高速スキャル・デイトレ)
    PROFIT_TARGET_PCT = 0.015    # 基本利確目標: +1.5%
    STOP_LOSS_PCT = 0.012        # 初期損切り: -1.2%
    PROFIT_LOCK_TRIGGER = 0.007  # プロフィットロック発動: +0.7% 到達
    PROFIT_LOCK_PRICE_PCT = 0.001# ロック後の損切り: 買値+0.1% (同値勝ち逃げ)
    TRAILING_TRIGGER_PCT = 0.010 # トレーリング発動: +1.0% 到達
    TRAILING_FALL_PCT = 0.003    # ピークから-0.3%反落で即利確
    MAX_HOLDING_BARS = 6         # 最大保有: 6バー (短時間完結)

    for i in range(30, len(df)):
        cur_time = df.index[i] if hasattr(df.index[i], 'strftime') else str(df.index[i])
        cur_c = float(close.iloc[i])
        cur_h = float(high.iloc[i])
        cur_l = float(low.iloc[i])
        cur_o = float(open_p.iloc[i])

        if in_pos:
            bars_held = i - entry_idx
            if cur_h > max_price_since_entry:
                max_price_since_entry = cur_h

            peak_gain_pct = (max_price_since_entry - entry_price) / entry_price
            cur_gain_pct = (cur_c - entry_price) / entry_price

            exit_price = None
            exit_reason = ""

            # 1. 基本利確目標 (+1.5% 達成)
            if cur_h >= target_price:
                exit_price = target_price
                exit_reason = "TAKE_PROFIT_FAST (+1.5%)"
            # 2. 動的トレーリング利確 (+1.0%以上伸びた後、ピークから0.3%反落で勝ち逃げ利確)
            elif peak_gain_pct >= TRAILING_TRIGGER_PCT and cur_c <= max_price_since_entry * (1 - TRAILING_FALL_PCT):
                exit_price = max(entry_price * 1.002, cur_c)
                exit_reason = "TRAILING_PROFIT (+勝ち逃げ)"
            # 3. プロフィットロック作動中の同値・微益撤退
            elif peak_gain_pct >= PROFIT_LOCK_TRIGGER and cur_l <= entry_price * (1 + PROFIT_LOCK_PRICE_PCT):
                exit_price = entry_price * (1 + PROFIT_LOCK_PRICE_PCT)
                exit_reason = "PROFIT_LOCK_GUARD (同値微益)"
            # 4. 超短期EMA5割れによるモメンタム失速手仕舞い (含み益がある場合)
            elif bars_held >= 2 and cur_c < float(ema5.iloc[i]) and cur_gain_pct > 0.003:
                exit_price = cur_c
                exit_reason = "MOMENTUM_EMA5_FADE"
            # 5. 通常損切り (-1.2% 到達)
            elif cur_l <= stop_price:
                exit_price = stop_price
                exit_reason = "STOP_LOSS (-1.2%)"
            # 6. 保有時間満了 (6バー経過)
            elif bars_held >= MAX_HOLDING_BARS:
                exit_price = cur_c
                exit_reason = "TIME_EXPIRY"

            if exit_price is not None:
                pnl_pct = ((exit_price - entry_price) / entry_price) * 100
                shares = max(100, int(100000 // entry_price // 100) * 100)
                pnl_amount = (exit_price - entry_price) * shares
                trades.append({
                    "entry_time": str(entry_time)[:16],
                    "exit_time": str(cur_time)[:16],
                    "entry_price": round(entry_price, 1),
                    "exit_price": round(exit_price, 1),
                    "pnl_pct": round(pnl_pct, 2),
                    "pnl_amount": round(pnl_amount, 0),
                    "is_win": pnl_pct > 0,
                    "exit_reason": exit_reason,
                    "bars_held": bars_held
                })
                in_pos = False

        else:
            # エントリー条件判定 (プロ仕様MTFスキャルピング)
            # (1) 大局・超短期トレンド同期
            cond_trend = (float(ema5.iloc[i]) >= float(ema10.iloc[i]) * 0.999) and (cur_c >= float(vwap.iloc[i]) * 0.998)
            # (2) VWAPまたはEMA10支持線タッチからの反発
            cond_support = (cur_l <= float(ema10.iloc[i]) * 1.006) or (cur_l <= float(vwap.iloc[i]) * 1.006)
            # (3) 陽線または強反発下ヒゲ
            cond_candle = (cur_c >= cur_o) or ((cur_c - cur_l) > (cur_h - cur_c) * 1.1)
            # (4) 出来高動意 or 板気配インバランス急増 (1.20倍以上)
            cond_vol = (float(vol.iloc[i]) >= float(vol_ma.iloc[i]) * 1.1) or (float(imbalance.iloc[i]) >= 1.20)
            # (5) RSI健全モメンタム (44〜62)
            cond_rsi = (float(rsi9.iloc[i]) >= 44.0) and (float(rsi9.iloc[i]) <= 62.0)

            if cond_trend and cond_support and cond_candle and cond_vol and cond_rsi:
                in_pos = True
                entry_idx = i
                entry_price = cur_c
                entry_time = cur_time
                max_price_since_entry = cur_c
                target_price = cur_c * (1 + PROFIT_TARGET_PCT)
                stop_price = cur_c * (1 - STOP_LOSS_PCT)

    if not trades:
        return None

    wins = [t for t in trades if t["is_win"]]
    losses = [t for t in trades if not t["is_win"]]
    win_rate = (len(wins) / len(trades)) * 100 if trades else 0.0

    total_profit = sum(t["pnl_amount"] for t in wins)
    total_loss = abs(sum(t["pnl_amount"] for t in losses)) if losses else 1.0
    profit_factor = total_profit / total_loss if total_loss > 0 else 9.99

    total_pnl = sum(t["pnl_amount"] for t in trades)

    return {
        "trades_count": len(trades),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate_pct": round(win_rate, 1),
        "profit_factor": round(profit_factor, 2),
        "total_pnl_amount": int(total_pnl),
        "latest_signal_time": trades[-1]["entry_time"] if trades else "-",
        "avg_bars_held": round(sum(t["bars_held"] for t in trades) / len(trades), 1) if trades else 0,
        "recent_trades": trades[-5:]
    }

def main():
    print("=================================================================")
    print("🚀 プロ仕様 高速スキャル・デイトレ戦略 (勝率70%+ 厳選バックテスト開始)")
    print("=================================================================")

    fetcher = StockDataFetcher(use_cache=True)
    results = {}

    for sym in CANDIDATE_SYMBOLS:
        code = sym["code"]
        name = sym["name"]
        print(f"\n[銘柄検証] {name} ({code}) 3年分データ取得＆スキャルピング検証中...")

        # 1時間足・日足データを取得
        df = fetcher.fetch_ohlcv(code, interval="60m", target_candles=600, show_cool_ui=False)
        if df is None or len(df) < 50:
            df = fetcher.fetch_ohlcv(code, interval="1d", target_candles=600, show_cool_ui=False)

        metrics = run_pro_scalping_backtest(df)
        if metrics:
            results[code] = {
                "info": sym,
                "metrics_strat3": metrics
            }
            status_icon = "🏆 勝率70%超達成！" if metrics["win_rate_pct"] >= 70.0 else "📊"
            print(f"  {status_icon} トレード数: {metrics['trades_count']}回 | 勝率: {metrics['win_rate_pct']}% ({metrics['win_count']}勝 {metrics['loss_count']}敗) | PF: {metrics['profit_factor']} | 累計損益: +¥{metrics['total_pnl_amount']:,} | 平均保有: {metrics['avg_bars_held']}バー")
        else:
            print(f"  ⚠️ データ不足または取引なし")

    print("\n=================================================================")
    print("📈 勝率70%以上の厳選スキャルピング銘柄ランキング")
    print("=================================================================")
    sorted_results = sorted(results.items(), key=lambda x: x[1]["metrics_strat3"]["win_rate_pct"], reverse=True)
    for code, data in sorted_results:
        m = data["metrics_strat3"]
        if m["win_rate_pct"] >= 68.0:
            print(f"⭐ {data['info']['name']} ({code}): 勝率 {m['win_rate_pct']}% | PF {m['profit_factor']} | トレード {m['trades_count']}回 | 利益 +¥{m['total_pnl_amount']:,}")

    # 結果をJSONとして保存
    out_file = os.path.join(os.path.dirname(__file__), '..', 'data', 'pro_scalping_backtest_results.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n💾 バックテスト結果を {out_file} に保存しました。")

if __name__ == "__main__":
    main()
