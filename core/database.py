"""
データベース管理モジュール (core/database.py)
SQLiteを使用した無料・ローカル完結のデータ永続化
ローソク足キャッシュ、トレード履歴、振り返りメモ、資産スナップショットを管理
"""
import sqlite3
import pandas as pd
from datetime import datetime
from typing import List, Optional, Dict, Any
from config.settings import DB_PATH
from core.models import Trade, ExitReason

class DatabaseManager:
    """SQLite データベース操作マネージャー"""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self.init_db()

    def get_connection(self) -> sqlite3.Connection:
        """コネクション取得"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self):
        """テーブル初期化"""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # 1. ローソク足データキャッシュテーブル
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS market_data (
                symbol TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                interval TEXT NOT NULL,
                PRIMARY KEY (symbol, timestamp, interval)
            )
            """)

            # 2. トレード履歴テーブル（振り返り・分析用）
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                trade_id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                symbol_name TEXT NOT NULL,
                strategy_name TEXT NOT NULL,
                entry_time TEXT NOT NULL,
                exit_time TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL NOT NULL,
                shares INTEGER NOT NULL,
                investment_amount REAL NOT NULL,
                pnl_amount REAL NOT NULL,
                pnl_pct REAL NOT NULL,
                commission REAL NOT NULL,
                holding_bars INTEGER NOT NULL,
                holding_days REAL NOT NULL,
                exit_reason TEXT NOT NULL,
                risk_reward_ratio REAL DEFAULT 0.0,
                notes TEXT DEFAULT '',
                tags TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """)

            # 3. 資産・ポートフォリオスナップショットテーブル
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS portfolio_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                total_equity REAL NOT NULL,
                cash REAL NOT NULL,
                positions_value REAL NOT NULL,
                realized_pnl REAL NOT NULL,
                unrealized_pnl REAL NOT NULL
            )
            """)

            # 4. トレード振り返りメモ・学習タグテーブル
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS review_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id TEXT NOT NULL,
                note_date TEXT NOT NULL,
                content TEXT NOT NULL,
                rating INTEGER DEFAULT 3,
                lessons_learned TEXT DEFAULT '',
                FOREIGN KEY (trade_id) REFERENCES trades(trade_id)
            )
            """)

            conn.commit()

    # --- ローソク足キャッシュ操作 ---

    def save_candles(self, df: pd.DataFrame, symbol: str, interval: str = "60m"):
        """ローソク足データをDBにキャッシュ保存"""
        if df.empty:
            return
        
        with self.get_connection() as conn:
            cursor = conn.cursor()
            records = []
            for idx, row in df.iterrows():
                ts_str = idx.strftime("%Y-%m-%d %H:%M:%S") if isinstance(idx, (pd.Timestamp, datetime)) else str(idx)
                records.append((
                    symbol,
                    ts_str,
                    float(row["Open"]),
                    float(row["High"]),
                    float(row["Low"]),
                    float(row["Close"]),
                    float(row.get("Volume", 0.0)),
                    interval
                ))
            
            cursor.executemany("""
            INSERT OR REPLACE INTO market_data 
            (symbol, timestamp, open, high, low, close, volume, interval)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, records)
            conn.commit()

    def load_candles(self, symbol: str, interval: str = "60m", limit: Optional[int] = None) -> pd.DataFrame:
        """キャッシュからローソク足データを読み出し"""
        with self.get_connection() as conn:
            query = "SELECT timestamp, open, high, low, close, volume FROM market_data WHERE symbol = ? AND interval = ? ORDER BY timestamp ASC"
            params = [symbol, interval]
            if limit:
                # 最新N件を取得してASC順に直す
                query = f"SELECT timestamp, open, high, low, close, volume FROM (SELECT * FROM market_data WHERE symbol = ? AND interval = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC"
                params.append(limit)

            df = pd.read_sql_query(query, conn, params=params)
            if not df.empty:
                df["timestamp"] = pd.to_datetime(df["timestamp"])
                df.set_index("timestamp", inplace=True)
                df.columns = ["Open", "High", "Low", "Close", "Volume"]
            return df

    # --- トレード履歴操作 ---

    def save_trade(self, trade: Trade):
        """トレードをDBに保存"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT OR REPLACE INTO trades (
                trade_id, symbol, symbol_name, strategy_name, entry_time, exit_time,
                entry_price, exit_price, shares, investment_amount, pnl_amount, pnl_pct,
                commission, holding_bars, holding_days, exit_reason, risk_reward_ratio,
                notes, tags
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trade.trade_id,
                trade.symbol,
                trade.symbol_name,
                trade.strategy_name,
                trade.entry_time.strftime("%Y-%m-%d %H:%M:%S") if isinstance(trade.entry_time, datetime) else str(trade.entry_time),
                trade.exit_time.strftime("%Y-%m-%d %H:%M:%S") if isinstance(trade.exit_time, datetime) else str(trade.exit_time),
                trade.entry_price,
                trade.exit_price,
                trade.shares,
                trade.investment_amount,
                trade.pnl_amount,
                trade.pnl_pct,
                trade.commission,
                trade.holding_bars,
                trade.holding_days,
                trade.exit_reason.value if isinstance(trade.exit_reason, ExitReason) else trade.exit_reason,
                trade.risk_reward_ratio,
                trade.notes,
                trade.tags
            ))
            conn.commit()

    def save_trades_bulk(self, trades: List[Trade]):
        """複数のトレードを一括保存"""
        for t in trades:
            self.save_trade(t)

    def get_trades(self, limit: int = 100, symbol: Optional[str] = None, strategy_name: Optional[str] = None) -> List[Dict[str, Any]]:
        """トレード履歴を取得"""
        with self.get_connection() as conn:
            query = "SELECT * FROM trades WHERE 1=1"
            params = []
            if symbol:
                query += " AND symbol = ?"
                params.append(symbol)
            if strategy_name:
                query += " AND strategy_name = ?"
                params.append(strategy_name)
            query += " ORDER BY exit_time DESC LIMIT ?"
            params.append(limit)

            cursor = conn.cursor()
            cursor.execute(query, params)
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def update_trade_notes(self, trade_id: str, notes: str, tags: str = "") -> bool:
        """振り返りメモ・タグを更新"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            UPDATE trades SET notes = ?, tags = ? WHERE trade_id = ?
            """, (notes, tags, trade_id))
            conn.commit()
            return cursor.rowcount > 0

    def get_trade_summary_stats(self) -> Dict[str, Any]:
        """全トレードの集計統計を取得"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN pnl_amount > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN pnl_amount <= 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(pnl_amount) as total_pnl,
                AVG(pnl_pct) as avg_pnl_pct,
                AVG(holding_days) as avg_holding_days
            FROM trades
            """)
            row = cursor.fetchone()
            if not row or row["total_trades"] == 0:
                return {
                    "total_trades": 0, "win_rate": 0.0, "total_pnl": 0.0,
                    "avg_pnl_pct": 0.0, "avg_holding_days": 0.0
                }
            
            total = row["total_trades"]
            wins = row["winning_trades"] or 0
            win_rate = (wins / total * 100.0) if total > 0 else 0.0
            return {
                "total_trades": total,
                "winning_trades": wins,
                "losing_trades": row["losing_trades"] or 0,
                "win_rate": win_rate,
                "total_pnl": row["total_pnl"] or 0.0,
                "avg_pnl_pct": row["avg_pnl_pct"] or 0.0,
                "avg_holding_days": row["avg_holding_days"] or 0.0
            }

# グローバルDBマネージャインスタンス
db = DatabaseManager()
