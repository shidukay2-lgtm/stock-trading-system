"""
証券会社・取引所API連携インターフェース (live_trading/broker_interface.py)
日本株の現物注文（単元株・ミニ株）を発注・管理するための抽象アダプター
SBI証券、楽天証券、kabuステーションAPI等の接続に対応可能な設計
"""
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List
from datetime import datetime
import uuid
from core.models import Order, OrderSide, OrderType, OrderStatus

class BaseBrokerAdapter(ABC):
    """ブローカー/取引所API抽象アダプター"""

    @abstractmethod
    def connect(self) -> bool:
        """API接続確立"""
        pass

    @abstractmethod
    def get_account_balance(self) -> Dict[str, float]:
        """口座残高（買付余力・保有株式評価額）照会"""
        pass

    @abstractmethod
    def place_order(
        self,
        symbol: str,
        side: OrderSide,
        order_type: OrderType,
        shares: int,
        price: Optional[float] = None,
        stop_price: Optional[float] = None
    ) -> Dict[str, Any]:
        """現物注文を発注"""
        pass

    @abstractmethod
    def cancel_order(self, order_id: str) -> bool:
        """注文キャンセル"""
        pass

    @abstractmethod
    def get_order_status(self, order_id: str) -> Dict[str, Any]:
        """注文約定状況確認"""
        pass

class MockBrokerAdapter(BaseBrokerAdapter):
    """
    シミュレーション / ペーパートレード用ブローカーアダプター
    実取引移行前の安全な動作検証を提供
    """

    def __init__(self, initial_cash: float = 300_000.0):
        self.cash = initial_cash
        self.positions: Dict[str, int] = {}
        self.orders: Dict[str, Dict[str, Any]] = {}
        self.is_connected = False

    def connect(self) -> bool:
        self.is_connected = True
        return True

    def get_account_balance(self) -> Dict[str, float]:
        return {
            "cash": self.cash,
            "buying_power": self.cash,
            "currency": "JPY",
            "account_type": "NISA_GROWTH"
        }

    def place_order(
        self,
        symbol: str,
        side: OrderSide,
        order_type: OrderType,
        shares: int,
        price: Optional[float] = None,
        stop_price: Optional[float] = None
    ) -> Dict[str, Any]:
        order_id = f"ORD-{uuid.uuid4().hex[:8].upper()}"
        order_info = {
            "order_id": order_id,
            "symbol": symbol,
            "side": side.value if isinstance(side, OrderSide) else side,
            "order_type": order_type.value if isinstance(order_type, OrderType) else order_type,
            "shares": shares,
            "price": price,
            "stop_price": stop_price,
            "status": "FILLED", # ペーパートレードでは即時約定シミュレーション
            "filled_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "commission": 0.0   # NISA現物
        }
        self.orders[order_id] = order_info
        return order_info

    def cancel_order(self, order_id: str) -> bool:
        if order_id in self.orders:
            self.orders[order_id]["status"] = "CANCELLED"
            return True
        return False

    def get_order_status(self, order_id: str) -> Dict[str, Any]:
        return self.orders.get(order_id, {"status": "UNKNOWN"})
