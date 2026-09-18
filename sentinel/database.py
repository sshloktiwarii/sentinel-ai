"""
sentinel/database.py

SQLite persistence layer for Sentinel-AI telemetry.
Operates strictly in WAL journal mode per the spec contract.
"""

import sqlite3
import threading
from contextlib import contextmanager
from typing import Generator

# Default DB path; override via init_db(path=...) for tests
_DB_PATH = "sentinel.db"
_local = threading.local()

def init_db(path: str = _DB_PATH) -> None:
    """Initialise the database: enable WAL mode and create the telemetry table.

    Safe to call multiple times (idempotent).
    """
    with _connect(path) as conn:
        # Enforce WAL mode – this is a PRAGMA, not a transaction statement,
        # so it must be executed outside of a deferred BEGIN.
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS telemetry (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   REAL    NOT NULL,
                wired_mb    INTEGER NOT NULL,
                swap_used_mb REAL   NOT NULL,
                pageouts    INTEGER NOT NULL,
                thrash_index REAL   NOT NULL
            );
            """
        )
        conn.commit()

@contextmanager
def _connect(path: str = _DB_PATH) -> Generator[sqlite3.Connection, None, None]:
    """Yield a WAL-mode SQLite connection, closing it on exit."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        yield conn
    finally:
        conn.close()

def get_connection(path: str = _DB_PATH) -> sqlite3.Connection:
    """Return a raw WAL-mode connection (caller is responsible for closing)."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def insert_telemetry(
    timestamp: float,
    wired_mb: int,
    swap_used_mb: float,
    pageouts: int,
    thrash_index: float,
    path: str = _DB_PATH,
) -> int:
    """Insert one telemetry row and return the new row id."""
    with _connect(path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO telemetry (timestamp, wired_mb, swap_used_mb, pageouts, thrash_index)
            VALUES (?, ?, ?, ?, ?)
            """,
            (timestamp, wired_mb, swap_used_mb, pageouts, thrash_index),
        )
        conn.commit()
        return cursor.lastrowid

def get_latest_metrics(limit: int = 100, path: str = _DB_PATH) -> list[dict]:
    """Return the *limit* most-recent telemetry rows, newest first.

    Each row is returned as a plain dict for easy serialisation.
    """
    with _connect(path) as conn:
        cursor = conn.execute(
            """
            SELECT id, timestamp, wired_mb, swap_used_mb, pageouts, thrash_index
            FROM telemetry
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]
