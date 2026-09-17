"""
EMA押し目買い戦略 (strategies/ema_pullback.py)
上昇トレンド中の押し目（EMAパーフェクトオーダー + EMA21反発 + RSI回復）を狙うスイング戦略
"""
import pandas as pd
import numpy as np
from typing import Dict, Any
from strategies.base_strategy import BaseStrategy

class EMAPullbackStrategy(BaseStrategy):
    """
    EMAパーフェクトオーダー押し目買い戦略
    
    【戦略概要】
    中長期で強い上昇トレンドにある小型株が、健全な調整（押し目）を作って反発した初動を捉える戦略。
    - EMA9 > EMA21 > EMA50 の並び順（パーフェクトオーダー）
    - 株価がEMA21近傍まで調整し、RSIが40〜58から上向き反転
    - 損切り: -2.5% (要件: -3%以内)
    - 利確: +6.0% (要件: +6%以上, リスクリワード 2.4:1)
    - 最大保有: 3営業日以内 (15バー)
    """

    def __init__(self, params: Dict[str, Any] = None):
        default_params = {
            "ema_fast": 9,
            "ema_mid": 21,
            "ema_slow": 50,
            "rsi_min": 40.0,
            "rsi_max": 58.0,
            "pullback_tolerance": 0.015, # EMA21からの乖離許容度 (1.5%)
            "stop_loss_pct": 0.025,      # 損切り幅: 2.5% (-3%以内)
            "take_profit_pct": 0.060,    # 利確幅: 6.0% (+6%以上)
            "max_holding_bars": 15       # 最大保有バー数 (3営業日)
        }
        if params:
            default_params.update(params)
        super().__init__(name="EMA_Pullback", params=default_params)

        self.description = "EMAパーフェクトオーダー下でのEMA21サポート押し目買い戦略"
        self.rationale = (
            "EMA9 > EMA21 > EMA50 の強気トレンドを確認後、EMA21水準まで一時調整して反発したタイミングを狙う。"
            "無理な高値掴みを避け、サポートライン近辺で引きつけて買うため、損切りを-2.5%とタイトに抑えつつ+6%の利確を狙える。"
        )

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """売買シグナルを生成"""
        df = df.copy()

        p = self.params
        df["EMA9"] = self.calculate_ema(df["Close"], p["ema_fast"])
        df["EMA21"] = self.calculate_ema(df["Close"], p["ema_mid"])
        df["EMA50"] = self.calculate_ema(df["Close"], p["ema_slow"])
        df["RSI"] = self.calculate_rsi(df["Close"], period=14)
        df["ATR"] = self.calculate_atr(df, period=14)

        df["signal"] = 0

        # 条件判定
        # (1) パーフェクトオーダー: EMA9 > EMA21 > EMA50
        cond_po = (df["EMA9"] > df["EMA21"]) & (df["EMA21"] > df["EMA50"])
        # (2) 押し目形成: 安値がEMA21近傍までタッチし、終値はEMA21以上を維持
        cond_pullback = (df["Low"] <= df["EMA21"] * (1 + p["pullback_tolerance"])) & (df["Close"] >= df["EMA21"] * (1 - p["pullback_tolerance"]))
        # (3) 陽線（反発の兆候）
        cond_bullish = df["Close"] >= df["Open"]
        # (4) RSIが健全な押し目水準
        cond_rsi = (df["RSI"] >= p["rsi_min"]) & (df["RSI"] <= p["rsi_max"])

        df.loc[cond_po & cond_pullback & cond_bullish & cond_rsi, "signal"] = 1

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
