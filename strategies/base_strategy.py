"""
戦略基底クラス (strategies/base_strategy.py)
全戦略の基底クラスおよびテクニカル指標計算ユーティリティ
"""
from abc import ABC, abstractmethod
import pandas as pd
import numpy as np
from typing import Dict, Any, Tuple

class BaseStrategy(ABC):
    """トレード戦略の基底クラス"""

    def __init__(self, name: str, params: Dict[str, Any] = None):
        self.name = name
        self.params = params or {}
        self.description = ""
        self.rationale = ""

    @abstractmethod
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        ローソク足DataFrameにテクニカル指標と売買シグナルを付与して返す
        
        Returns:
        DataFrame:
            - 'signal': 1 (買いエントリー), -1 (売りイグジット), 0 (何もしない)
            - 各種計算された指標列
        """
        pass

    @abstractmethod
    def get_strategy_info(self) -> Dict[str, Any]:
        """戦略の根拠、エントリー/イグジットルール、パラメータの明確な説明を返す"""
        pass

    # --- テクニカル指標計算ヘルパー ---

    @staticmethod
    def calculate_ema(series: pd.Series, period: int) -> pd.Series:
        """指数平滑移動平均 (EMA)"""
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def calculate_sma(series: pd.Series, period: int) -> pd.Series:
        """単純移動平均 (SMA)"""
        return series.rolling(window=period).mean()

    @staticmethod
    def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        """Relative Strength Index (RSI)"""
        delta = series.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / (loss + 1e-9)
        return 100 - (100 / (1 + rs))

    @staticmethod
    def calculate_bollinger_bands(series: pd.Series, period: int = 20, num_std: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """ボリンジャーバンド (Upper, Middle, Lower)"""
        sma = series.rolling(window=period).mean()
        std = series.rolling(window=period).std()
        upper = sma + (std * num_std)
        lower = sma - (std * num_std)
        return upper, sma, lower

    @staticmethod
    def calculate_macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[pd.Series, pd.Series, pd.Series]:
        """MACD (MACD line, Signal line, Histogram)"""
        ema_fast = series.ewm(span=fast, adjust=False).mean()
        ema_slow = series.ewm(span=slow, adjust=False).mean()
        macd = ema_fast - ema_slow
        macd_signal = macd.ewm(span=signal, adjust=False).mean()
        macd_hist = macd - macd_signal
        return macd, macd_signal, macd_hist

    @staticmethod
    def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        """Average True Range (ATR)"""
        high = df["High"]
        low = df["Low"]
        close_prev = df["Close"].shift(1)
        tr1 = high - low
        tr2 = (high - close_prev).abs()
        tr3 = (low - close_prev).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        return tr.rolling(window=period).mean()

    @staticmethod
    def calculate_volume_ratio(volume: pd.Series, period: int = 20) -> pd.Series:
        """出来高急増比率 (現在の出来高 / 過去N期間の平均出来高)"""
        avg_vol = volume.rolling(window=period).mean()
        return volume / (avg_vol + 1e-9)
