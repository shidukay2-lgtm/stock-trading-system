"""
システム設定ファイル (config/settings.py)
資金管理、リスク管理、NISA設定、手数料、バックテストパラメータを定義
"""
from dataclasses import dataclass
from typing import Dict, Any
import os

# プロジェクトルートディレクトリ
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
REPORTS_DIR = os.path.join(PROJECT_ROOT, "reports")
DB_PATH = os.path.join(DATA_DIR, "trading_system.db")

# ディレクトリ作成
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

@dataclass
class TradingSettings:
    # 資金管理
    INITIAL_CAPITAL: float = 300_000.0        # 総運用資金: 300,000円
    MAX_POSITION_AMOUNT: float = 100_000.0    # 1回の最大投資額: 100,000円以下
    MAX_CONCURRENT_POSITIONS: int = 3         # 最大同時保有ポジション数
    
    # リスクリワード & エグジット管理
    STOP_LOSS_PCT: float = 0.028              # 損切りライン: 2.8% (要件: -3%以内)
    TAKE_PROFIT_PCT: float = 0.060            # 利確ライン: 6.0% (要件: +6%以上, リスクリワード比 2.14:1)
    MAX_HOLDING_BARS: int = 15                # 最大保有バー数 (東証1日5h足換算で3営業日 = 15バー)
    MAX_HOLDING_DAYS: int = 3                 # 最大保有日数 (3営業日以内)
    
    # 日本株・NISA設定
    DEFAULT_LOT_SIZE: int = 100               # 日本株単元株 (100株)
    ALLOW_ODD_LOTS: bool = True               # 10万円以内で買えるよう単元未満株(ミニ株: 1株単位)も許可
    IS_NISA_ACCOUNT: bool = True              # NISA口座 (譲渡益非課税・主要ネット証券で売買手数料0円)
    
    # 手数料 & スリッページ
    COMMISSION_RATE: float = 0.0000           # NISA現物手数料: 0.0% (ネット証券NISA枠無料)
    COMMISSION_MIN: float = 0.0               # 最低手数料: 0円
    TAX_RATE: float = 0.0                     # NISA非課税 (通常口座なら 0.20315)
    SLIPPAGE_RATE: float = 0.0005             # スリッページ想定: 0.05% (現実的な約定差)
    
    # データ取得設定
    DEFAULT_INTERVAL: str = "60m"             # 時間軸: 1時間足
    DEFAULT_CANDLE_COUNT: int = 1000          # 取得ローソク足本数: 1000本
    MARKET_CODE_SUFFIX: str = ".T"            # 東証コードサフィックス (yfinance用)
    
    # タイムゾーン
    TIMEZONE: str = "Asia/Tokyo"

# グローバル設定インスタンス
DEFAULT_SETTINGS = TradingSettings()
