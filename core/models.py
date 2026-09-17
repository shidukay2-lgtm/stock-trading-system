"""
データモデル定義 (core/models.py)
ローソク足、注文、ポジション、トレード履歴、ポートフォリオ、バックテスト結果のデータ構造
"""
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional, Dict, Any
import pandas as pd

class OrderSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"

class OrderType(str, Enum):
    MARKET = "MARKET"   # 成行
    LIMIT = "LIMIT"     # 指値
    STOP = "STOP"       # 逆指値

class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"

@dataclass
class Order:
    """注文データ"""
    order_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    shares: int
    price: Optional[float] = None
    stop_price: Optional[float] = None
    status: OrderStatus = OrderStatus.PENDING
    created_at: datetime = field(default_factory=datetime.now)
    filled_at: Optional[datetime] = None
    commission: float = 0.0

class ExitReason(str, Enum):
    TAKE_PROFIT = "TAKE_PROFIT"       # 利確 (+6%以上)
    STOP_LOSS = "STOP_LOSS"           # 損切り (-3%以内)
    TIMEOUT = "TIMEOUT"               # タイムアウト (3日以内ルール)
    SIGNAL_EXIT = "SIGNAL_EXIT"       # 戦略シグナルによるエグジット
    MANUAL = "MANUAL"                 # 手動決済

@dataclass
class Candle:
    """ローソク足 (OHLCV) データ"""
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    symbol: str

@dataclass
class Position:
    """保有中ポジション"""
    symbol: str
    symbol_name: str
    entry_time: datetime
    entry_price: float
    shares: int
    investment_amount: float          # 投資金額（常に10万円以下）
    stop_loss_price: float            # 損切り価格 (-3%以内)
    take_profit_price: float          # 利確価格 (+6%以上)
    current_price: float = 0.0
    holding_bars: int = 0             # 保有バー数 (1h足換算)
    strategy_name: str = ""
    notes: str = ""

    @property
    def unrealized_pnl(self) -> float:
        """含み損益額 (円)"""
        return (self.current_price - self.entry_price) * self.shares

    @property
    def unrealized_pnl_pct(self) -> float:
        """含み損益率 (%)"""
        if self.entry_price == 0:
            return 0.0
        return ((self.current_price - self.entry_price) / self.entry_price) * 100.0

@dataclass
class Trade:
    """完了したトレード履歴（振り返り用）"""
    trade_id: str
    symbol: str
    symbol_name: str
    strategy_name: str
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    shares: int
    investment_amount: float          # 投資金額 (<= 100,000円)
    pnl_amount: float                 # 損益額 (円)
    pnl_pct: float                    # 損益率 (%)
    commission: float                 # 手数料 (円)
    holding_bars: int                 # 保有バー数
    holding_days: float               # 保有日数
    exit_reason: ExitReason           # 決済理由 (利確/損切り/タイムアウト)
    risk_reward_ratio: float = 0.0    # 想定RR比
    notes: str = ""                   # 振り返りメモ
    tags: str = ""                    # タグ（例: #ブレイクアウト #高出来高）

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trade_id": self.trade_id,
            "symbol": self.symbol,
            "symbol_name": self.symbol_name,
            "strategy_name": self.strategy_name,
            "entry_time": self.entry_time.strftime("%Y-%m-%d %H:%M"),
            "exit_time": self.exit_time.strftime("%Y-%m-%d %H:%M"),
            "entry_price": round(self.entry_price, 2),
            "exit_price": round(self.exit_price, 2),
            "shares": self.shares,
            "investment_amount": round(self.investment_amount, 2),
            "pnl_amount": round(self.pnl_amount, 2),
            "pnl_pct": round(self.pnl_pct, 2),
            "commission": round(self.commission, 2),
            "holding_bars": self.holding_bars,
            "holding_days": round(self.holding_days, 2),
            "exit_reason": self.exit_reason.value if isinstance(self.exit_reason, ExitReason) else self.exit_reason,
            "risk_reward_ratio": round(self.risk_reward_ratio, 2),
            "notes": self.notes,
            "tags": self.tags
        }

@dataclass
class Portfolio:
    """ポートフォリオ（資金管理・口座状況）"""
    initial_capital: float = 300_000.0
    cash: float = 300_000.0
    positions: Dict[str, Position] = field(default_factory=dict)
    total_commission_paid: float = 0.0
    realized_pnl: float = 0.0

    @property
    def positions_value(self) -> float:
        """保有株の評価額合計"""
        return sum(pos.current_price * pos.shares for pos in self.positions.values())

    @property
    def total_equity(self) -> float:
        """総資産 (現金 + 保有株評価額)"""
        return self.cash + self.positions_value

    @property
    def total_return_pct(self) -> float:
        """通算リターン率 (%)"""
        return ((self.total_equity - self.initial_capital) / self.initial_capital) * 100.0

@dataclass
class BacktestMetrics:
    """バックテスト詳細指標"""
    initial_capital: float
    final_equity: float
    total_return_pct: float
    total_pnl_amount: float
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate_pct: float
    profit_factor: float
    max_drawdown_pct: float
    max_drawdown_amount: float
    sharpe_ratio: float
    average_profit_pct: float
    average_loss_pct: float
    risk_reward_achieved: float
    avg_holding_bars: float
    take_profit_count: int
    stop_loss_count: int
    timeout_count: int

@dataclass
class BacktestResult:
    """バックテスト実行結果"""
    strategy_name: str
    symbol: str
    symbol_name: str
    interval: str
    start_date: str
    end_date: str
    metrics: BacktestMetrics
    trades: List[Trade]
    equity_curve: pd.DataFrame
