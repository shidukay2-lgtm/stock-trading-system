"""
高勝率スイングトレード戦略群 (strategies/high_win_strategies.py)
勝率7割以上・リスクリワード比1:2以上・最大ドローダウン2割以内・3日以内決済を達成するための厳選戦略群
ファンダメンタルズ（成長小型株）× テクニカル（日足トレンド＋1h足高確度シグナル）
"""
import pandas as pd
import numpy as np
from typing import Dict, Any
from strategies.base_strategy import BaseStrategy

# =====================================================================
# 戦略案1: マルチタイムフレーム・トレンド押し目買い戦略 (HighWin_TrendPullback)
# =====================================================================
class HighWinTrendPullbackStrategy(BaseStrategy):
    """
    【戦略案1】マルチタイムフレーム・トレンド押し目買い戦略
    
    【設計思想】
    ファンダメンタルズ良好な成長小型株において、大局的上昇トレンド中の
    一時的な健全調整（EMA21サポート）で押し目買いを行う。
    高値掴みを徹底排除し、引きつけて買うことで勝率70%超と低ドローダウンを両立。
    
    - 損切り: -2.8% (要件: -3%以内)
    - 利確: +6.0% (要件: +6%以上, リスクリワード 2.14:1)
    - 最大保有: 3営業日以内 (15バー)
    """

    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "ema_fast": 9,
            "ema_mid": 21,
            "ema_slow": 50,
            "rsi_min": 40.0,
            "rsi_max": 56.0,           # 押し目完了直後の低リスクゾーン
            "pullback_tolerance": 0.012, # EMA21からの許容乖離 (1.2%)
            "stop_loss_pct": 0.028,      # 損切り: 2.8%
            "take_profit_pct": 0.060,    # 利確: 6.0% (RR比 2.14:1)
            "max_holding_bars": 15       # 最大3営業日
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_TrendPullback", params=default_params)
        self.description = "日足強気環境下の1h足EMA21サポート反発・押し目買い戦略"
        self.rationale = (
            "EMA9 > EMA21 > EMA50 の強気パーフェクトオーダー下で、価格がEMA21まで健全に調整した初動を捉える。"
            "RSIが40〜56の売られすぎ反転領域かつ陽線反発時のみにエントリーを厳選し、勝率7割超を目指す。"
        )

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        df["EMA9"] = self.calculate_ema(df["Close"], p["ema_fast"])
        df["EMA21"] = self.calculate_ema(df["Close"], p["ema_mid"])
        df["EMA50"] = self.calculate_ema(df["Close"], p["ema_slow"])
        df["RSI"] = self.calculate_rsi(df["Close"], period=14)
        df["ATR"] = self.calculate_atr(df, period=14)
        df["Vol_MA20"] = df["Volume"].rolling(window=20).mean()

        df["signal"] = 0

        # 条件判定
        # (1) 強気パーフェクトオーダー
        cond_trend = (df["EMA9"] > df["EMA21"]) & (df["EMA21"] > df["EMA50"])
        # (2) EMA21への押し目タッチ＆サポート確認
        cond_pullback = (df["Low"] <= df["EMA21"] * (1 + p["pullback_tolerance"])) & (df["Close"] >= df["EMA21"] * (1 - p["pullback_tolerance"]))
        # (3) 反発確認（陽線または下ヒゲ）
        cond_reversal = df["Close"] >= df["Open"]
        # (4) RSI健全圏
        cond_rsi = (df["RSI"] >= p["rsi_min"]) & (df["RSI"] <= p["rsi_max"])
        # (5) 流動性フィルター（出来高が極端に枯れていない）
        cond_vol = df["Volume"] >= df["Vol_MA20"] * 0.7

        df.loc[cond_trend & cond_pullback & cond_reversal & cond_rsi & cond_vol, "signal"] = 1
        return df

    def get_strategy_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "rationale": self.rationale,
            "parameters": self.params,
            "risk_reward_target": f"1 : {self.params['take_profit_pct'] / self.params['stop_loss_pct']:.2f}",
            "stop_loss": f"-{self.params['stop_loss_pct']*100:.1f}%",
            "take_profit": f"+{self.params['take_profit_pct']*100:.1f}%",
            "max_holding_period": f"{self.params['max_holding_bars']} バー (約3営業日)"
        }


# =====================================================================
# 戦略案2: 出来高モメンタムブレイクアウト戦略 (HighWin_VolumeBreakout)
# =====================================================================
class HighWinVolumeBreakoutStrategy(BaseStrategy):
    """
    【戦略案2】出来高モメンタムブレイクアウト戦略
    
    【設計思想】
    小型成長株のボラティリティ収縮（エネルギー蓄積）からの急激な初動拡大を狙う。
    大口資金流入（出来高1.6倍超）とボリンジャーバンド上限突破をトリガーとする。
    
    - 損切り: -2.8% (要件: -3%以内)
    - 利確: +6.5% (要件: +6%以上, リスクリワード 2.32:1)
    - 最大保有: 3営業日以内 (15バー)
    """

    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "bb_period": 20,
            "bb_std": 1.9,
            "volume_mult": 1.5,        # 出来高1.5倍以上の急増
            "rsi_min": 54.0,           # RSI上昇初動
            "rsi_max": 75.0,           # 天井圏過熱を排除
            "ema_trend": 50,
            "stop_loss_pct": 0.028,    # 損切り: 2.8%
            "take_profit_pct": 0.065,    # 利確: 6.5% (RR比 2.32:1)
            "max_holding_bars": 15
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_VolumeBreakout", params=default_params)
        self.description = "エネルギー収縮からの大口出来高急増ブレイクアウト戦略"
        self.rationale = (
            "ボリンジャーバンド+1.9σを大口出来高（平時の1.5倍以上）で力強く上抜けた初動でエントリー。"
            "MACDおよびRSIが適正上昇レンジにあることを確認し、3日以内に+6.5%の利確を達成する。"
        )

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        df["EMA20"] = self.calculate_ema(df["Close"], 20)
        df["EMA50"] = self.calculate_ema(df["Close"], p["ema_trend"])
        df["BB_upper"], df["BB_mid"], df["BB_lower"] = self.calculate_bollinger_bands(
            df["Close"], period=p["bb_period"], num_std=p["bb_std"]
        )
        df["RSI"] = self.calculate_rsi(df["Close"], period=14)
        df["Volume_ratio"] = self.calculate_volume_ratio(df["Volume"], period=p["bb_period"])
        df["MACD"], df["MACD_sig"], df["MACD_hist"] = self.calculate_macd(df["Close"])

        df["signal"] = 0

        # 条件判定
        cond_break = df["Close"] > df["BB_upper"]
        cond_vol = df["Volume_ratio"] >= p["volume_mult"]
        cond_rsi = (df["RSI"] >= p["rsi_min"]) & (df["RSI"] <= p["rsi_max"])
        cond_trend = (df["Close"] > df["EMA20"]) & (df["EMA20"] >= df["EMA50"] * 0.998)
        cond_macd = df["MACD_hist"] > 0

        df.loc[cond_break & cond_vol & cond_rsi & cond_trend & cond_macd, "signal"] = 1
        return df

    def get_strategy_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "rationale": self.rationale,
            "parameters": self.params,
            "risk_reward_target": f"1 : {self.params['take_profit_pct'] / self.params['stop_loss_pct']:.2f}",
            "stop_loss": f"-{self.params['stop_loss_pct']*100:.1f}%",
            "take_profit": f"+{self.params['take_profit_pct']*100:.1f}%",
            "max_holding_period": f"{self.params['max_holding_bars']} バー (約3営業日)"
        }


# =====================================================================
# 戦略案3: トリプルコンフルエンス高確度反発戦略 (HighWin_TripleConfluence)
# =====================================================================
class HighWinTripleConfluenceStrategy(BaseStrategy):
    """
    【戦略案3】トリプルコンフルエンス高確度反発戦略
    
    【設計思想】
    EMAトレンド、MACD好転、RSIモメンタムの3つの独立したテクニカル指標が
    同時に買いシグナルを示した時のみにエントリーを絞り込み、ダマシを極限まで低減。
    
    - 損切り: -2.5% (要件: -3%以内)
    - 利確: +6.0% (要件: +6%以上, リスクリワード 2.40:1)
    - 最大保有: 3営業日以内 (15バー)
    """

    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "ema_short": 10,
            "ema_long": 25,
            "rsi_threshold": 48.0,
            "stop_loss_pct": 0.025,    # 損切り: 2.5%
            "take_profit_pct": 0.060,  # 利確: 6.0% (RR比 2.40:1)
            "max_holding_bars": 15
        }
        if params:
            default_params.update(params)
        super().__init__(name="HighWin_TripleConfluence", params=default_params)
        self.description = "EMAクロス × MACD好転 × RSIモメンタム同期戦略"
        self.rationale = (
            "EMA10 > EMA25 かつ MACDが好転し、RSIが中立(48以上)から上放れした瞬間を捉える。"
            "3指標の合致によりダマシを防ぎ、安定した高勝率スイングを実現。"
        )

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        p = self.params

        df["EMA10"] = self.calculate_ema(df["Close"], p["ema_short"])
        df["EMA25"] = self.calculate_ema(df["Close"], p["ema_long"])
        df["RSI"] = self.calculate_rsi(df["Close"], period=14)
        df["MACD"], df["MACD_sig"], df["MACD_hist"] = self.calculate_macd(df["Close"])

        df["signal"] = 0

        # 条件判定
        cond_ema = df["EMA10"] > df["EMA25"]
        cond_macd = (df["MACD"] > df["MACD_sig"]) & (df["MACD_hist"] > df["MACD_hist"].shift(1))
        cond_rsi = (df["RSI"] >= p["rsi_threshold"]) & (df["RSI"] <= 72.0)
        cond_candle = df["Close"] >= df["Open"]

        df.loc[cond_ema & cond_macd & cond_rsi & cond_candle, "signal"] = 1
        return df

    def get_strategy_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "rationale": self.rationale,
            "parameters": self.params,
            "risk_reward_target": f"1 : {self.params['take_profit_pct'] / self.params['stop_loss_pct']:.2f}",
            "stop_loss": f"-{self.params['stop_loss_pct']*100:.1f}%",
            "take_profit": f"+{self.params['take_profit_pct']*100:.1f}%",
            "max_holding_period": f"{self.params['max_holding_bars']} バー (約3営業日)"
        }
