"""
モメンタム・ブレイクアウト戦略 (strategies/momentum_breakout.py)
小型成長株の初動急騰（出来高急増 + ボリンジャーバンド上限突破）を狙う高期待値スイングトレード戦略
"""
import pandas as pd
import numpy as np
from typing import Dict, Any
from strategies.base_strategy import BaseStrategy

class MomentumBreakoutStrategy(BaseStrategy):
    """
    モメンタム・ブレイクアウト戦略
    
    【戦略概要】
    東証グロース・小型株の特性である「資金集中による初動の急拡大」を狙う戦略。
    出来高の急増（過去20バー平均の1.5倍以上）を伴い、ボリンジャーバンド+2σを上抜けたタイミングで順張りエントリー。
    - 損切り: -2.8% (要件: -3%以内を厳格遵守)
    - 利確: +6.0%〜+8.0% (要件: +6%以上, リスクリワード 2.14:1 以上)
    - 最大保有: 3営業日以内 (15バー)
    """

    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "bb_period": 20,
            "bb_std": 2.0,
            "volume_mult": 1.4,        # 出来高急増倍率
            "rsi_min": 52.0,           # RSI下限（モメンタム確認）
            "rsi_max": 78.0,           # RSI上限（買われすぎ過熱フィルター）
            "ema_fast": 20,
            "ema_slow": 50,
            "stop_loss_pct": 0.028,    # 損切り幅: 2.8% (-3%以内)
            "take_profit_pct": 0.060,  # 利確幅: 6.0% (+6%以上)
            "max_holding_bars": 15     # 最大保有バー数 (3営業日)
        }
        if params:
            default_params.update(params)
        super().__init__(name="Momentum_Breakout", params=default_params)

        self.description = "出来高急増を伴うボリンジャーバンド+2σブレイクアウト戦略"
        self.rationale = (
            "小型成長株における大口資金の流入初動を捉える。出来高が平時の1.4倍以上でボリンジャーバンド+2σを突破し、"
            "かつEMAトレンドが上向きの際にエントリー。3日以内に+6%の利確を狙い、-2.8%で早期撤退することで損小利大を実現。"
        )

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """売買シグナルを生成"""
        df = df.copy()

        # 1. テクニカル指標計算
        p = self.params
        df["EMA20"] = self.calculate_ema(df["Close"], p["ema_fast"])
        df["EMA50"] = self.calculate_ema(df["Close"], p["ema_slow"])
        df["BB_upper"], df["BB_mid"], df["BB_lower"] = self.calculate_bollinger_bands(
            df["Close"], period=p["bb_period"], num_std=p["bb_std"]
        )
        df["RSI"] = self.calculate_rsi(df["Close"], period=14)
        df["Volume_ratio"] = self.calculate_volume_ratio(df["Volume"], period=p["bb_period"])
        df["ATR"] = self.calculate_atr(df, period=14)

        # 2. シグナル初期化
        df["signal"] = 0

        # 3. エントリー条件判定
        # (1) 終値がボリンジャーバンド+2σを上抜け
        cond_bb_break = df["Close"] > df["BB_upper"]
        # (2) 出来高が平均の volume_mult 倍以上
        cond_volume = df["Volume_ratio"] >= p["volume_mult"]
        # (3) RSIが適正な上昇圏 (rsi_min <= RSI <= rsi_max)
        cond_rsi = (df["RSI"] >= p["rsi_min"]) & (df["RSI"] <= p["rsi_max"])
        # (4) トレンド環境: EMA20 >= EMA50 または 終値がEMA20以上
        cond_trend = (df["Close"] > df["EMA20"]) & (df["EMA20"] >= df["EMA50"] * 0.995)

        # すべて満たしたバーで買いシグナル(1)
        df.loc[cond_bb_break & cond_volume & cond_rsi & cond_trend, "signal"] = 1

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
