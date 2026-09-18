"""
sentinel/database.py

SQLite persistence layer for Sentinel-AI.
Operates strictly in WAL journal mode per the spec contract.
"""

import sqlite3
import time
import threading
from contextlib import contextmanager
from typing import Generator

# Default DB path; override via init_db(path=...) for tests.
# All public functions read this at call time so monkeypatching works correctly.
_DB_PATH = "sentinel.db"
_local = threading.local()

def _resolve(path: str | None) -> str:
    """Return *path* if given, otherwise the current module-level default."""
    return path if path is not None else _DB_PATH

@contextmanager
def _connect(path: str) -> Generator[sqlite3.Connection, None, None]:
    """Yield a WAL-mode SQLite connection, closing it on exit."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        yield conn
    finally:
        conn.close()

def get_connection(path: str | None = None) -> sqlite3.Connection:
    """Return a raw WAL-mode connection (caller is responsible for closing)."""
    resolved = _resolve(path)
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db(path: str | None = None) -> None:
    """Initialise the database: enable WAL mode and create the telemetry table.

    Safe to call multiple times (idempotent).
    """
    with _connect(_resolve(path)) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS telemetry (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp    REAL    NOT NULL,
                wired_mb     REAL    NOT NULL,
                swap_used_mb REAL    NOT NULL,
                pageouts     INTEGER NOT NULL,
                thrash_index REAL    NOT NULL
            );
            """
        )
        conn.commit()

def insert_telemetry(
    timestamp: float,
    wired_mb: float,
    swap_used_mb: float,
    pageouts: int,
    thrash_index: float,
    path: str | None = None,
) -> int:
    """Insert one telemetry row and return the new row id."""
    with _connect(_resolve(path)) as conn:
        cursor = conn.execute(
            """
            INSERT INTO telemetry (timestamp, wired_mb, swap_used_mb, pageouts, thrash_index)
            VALUES (?, ?, ?, ?, ?)
            """,
            (timestamp, wired_mb, swap_used_mb, pageouts, thrash_index),
        )
        conn.commit()
        return cursor.lastrowid

def get_latest_metrics(limit: int = 100, path: str | None = None) -> list[dict]:
    """Return the *limit* most-recent telemetry rows, newest first."""
    with _connect(_resolve(path)) as conn:
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

def get_history_window(window: str = "1m", path: str | None = None) -> list[dict]:
    """Return telemetry rows for the requested time window.

    - "1m": raw rows from the last 60 seconds (up to 60 rows), oldest first.
    - "5m": rows from the last 300 seconds sampled at ~5 s intervals (up to 60 rows).
    - "1h": average-bucketed rows across the last 3600 seconds (~60-120 buckets).

    All results are returned oldest-first so the frontend can plot them directly.
    """
    now = time.time()

    with _connect(_resolve(path)) as conn:
        if window == "1m":
            since = now - 60
            cursor = conn.execute(
                """
                SELECT id, timestamp, wired_mb, swap_used_mb, pageouts, thrash_index
                FROM telemetry
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                LIMIT 60
                """,
                (since,),
            )
            return [dict(row) for row in cursor.fetchall()]

        elif window == "5m":
            since = now - 300
            cursor = conn.execute(
                """
                SELECT id,
                       timestamp,
                       wired_mb,
                       swap_used_mb,
                       pageouts,
                       thrash_index
                FROM (
                    SELECT *,
                           CAST((timestamp - ?) / 5 AS INTEGER) AS bucket,
                           ROW_NUMBER() OVER (
                               PARTITION BY CAST((timestamp - ?) / 5 AS INTEGER)
                               ORDER BY timestamp ASC
                           ) AS rn
                    FROM telemetry
                    WHERE timestamp >= ?
                )
                WHERE rn = 1
                ORDER BY timestamp ASC
                LIMIT 60
                """,
                (since, since, since),
            )
            return [dict(row) for row in cursor.fetchall()]

        elif window == "1h":
            since = now - 3600
            cursor = conn.execute(
                """
                SELECT
                    CAST((timestamp - ?) / 60 AS INTEGER)  AS bucket,
                    MIN(timestamp)                          AS timestamp,
                    AVG(wired_mb)                           AS wired_mb,
                    AVG(swap_used_mb)                       AS swap_used_mb,
                    AVG(pageouts)                           AS pageouts,
                    AVG(thrash_index)                       AS thrash_index
                FROM telemetry
                WHERE timestamp >= ?
                GROUP BY bucket
                ORDER BY bucket ASC
                LIMIT 120
                """,
                (since, since),
            )
            rows = []
            for row in cursor.fetchall():
                d = dict(row)
                d.pop("bucket", None)
                rows.append(d)
            return rows

        else:
            raise ValueError(f"Unknown window: {window!r}. Expected '1m', '5m', or '1h'.")

def get_spikes(path: str | None = None) -> list[dict]:
    """Return the top-5 spike events in the last 24 hours.

    A spike is any row where thrash_index >= 0.4 OR swap_used_mb > 0.
    Results are ordered by thrash_index descending so the worst events come first.
    Each dict contains: timestamp, thrash_index, wired_mb, swap_used_mb, pageouts.
    """
    since = time.time() - 86_400  # last 24 hours

    with _connect(_resolve(path)) as conn:
        cursor = conn.execute(
            """
            SELECT timestamp, thrash_index, wired_mb, swap_used_mb, pageouts
            FROM telemetry
            WHERE timestamp >= ?
              AND (thrash_index >= 0.4 OR swap_used_mb > 0)
            ORDER BY thrash_index DESC
            LIMIT 5
            """,
            (since,),
        )
        return [dict(row) for row in cursor.fetchall()]
