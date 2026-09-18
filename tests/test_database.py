"""
tests/test_database.py

Comprehensive tests for sentinel/database.py covering:
- WAL mode enforcement
- Table creation and schema correctness
- insert_telemetry helper
- get_latest_metrics query and ordering
- Edge cases (empty table, limit=0, limit larger than row count)
"""

import sqlite3
import time
import pytest

from sentinel.database import init_db, insert_telemetry, get_latest_metrics

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_path(tmp_path):
    """Return a fresh, initialised DB path for each test."""
    path = str(tmp_path / "test_sentinel.db")
    init_db(path=path)
    return path

# ---------------------------------------------------------------------------
# WAL mode
# ---------------------------------------------------------------------------

class TestWALMode:
    def test_journal_mode_is_wal_after_init(self, db_path):
        conn = sqlite3.connect(db_path)
        row = conn.execute("PRAGMA journal_mode;").fetchone()
        conn.close()
        assert row[0].lower() == "wal"

    def test_journal_mode_is_wal_on_fresh_connection(self, db_path):
        """Re-opening the file should still report WAL (persisted to file header)."""
        conn = sqlite3.connect(db_path)
        # Do NOT re-issue PRAGMA – mode should persist from init
        row = conn.execute("PRAGMA journal_mode;").fetchone()
        conn.close()
        assert row[0].lower() == "wal"

# ---------------------------------------------------------------------------
# Table creation & schema
# ---------------------------------------------------------------------------

class TestTableCreation:
    def test_telemetry_table_exists(self, db_path):
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry';"
        ).fetchone()
        conn.close()
        assert row is not None

    def test_telemetry_columns(self, db_path):
        conn = sqlite3.connect(db_path)
        rows = conn.execute("PRAGMA table_info(telemetry);").fetchall()
        conn.close()
        col_names = [r[1] for r in rows]
        assert "id" in col_names
        assert "timestamp" in col_names
        assert "wired_mb" in col_names
        assert "swap_used_mb" in col_names
        assert "pageouts" in col_names
        assert "thrash_index" in col_names

    def test_id_is_primary_key(self, db_path):
        conn = sqlite3.connect(db_path)
        rows = conn.execute("PRAGMA table_info(telemetry);").fetchall()
        conn.close()
        pk_cols = [r[1] for r in rows if r[5] == 1]  # column 5 is pk flag
        assert "id" in pk_cols

    def test_init_db_is_idempotent(self, db_path):
        """Calling init_db a second time must not raise or duplicate anything."""
        init_db(path=db_path)
        conn = sqlite3.connect(db_path)
        count = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry';"
        ).fetchone()[0]
        conn.close()
        assert count == 1

# ---------------------------------------------------------------------------
# insert_telemetry
# ---------------------------------------------------------------------------

class TestInsertTelemetry:
    def test_insert_returns_row_id(self, db_path):
        row_id = insert_telemetry(
            timestamp=time.time(),
            wired_mb=4096,
            swap_used_mb=512.0,
            pageouts=10,
            thrash_index=0.3,
            path=db_path,
        )
        assert isinstance(row_id, int)
        assert row_id >= 1

    def test_insert_autoincrement(self, db_path):
        id1 = insert_telemetry(time.time(), 4096, 512.0, 10, 0.3, path=db_path)
        id2 = insert_telemetry(time.time(), 8192, 1024.0, 20, 0.6, path=db_path)
        assert id2 > id1

    def test_inserted_values_are_persisted(self, db_path):
        ts = 1_700_000_000.0
        insert_telemetry(
            timestamp=ts,
            wired_mb=2048,
            swap_used_mb=256.5,
            pageouts=5,
            thrash_index=0.15,
            path=db_path,
        )
        conn = sqlite3.connect(db_path)
        row = conn.execute("SELECT * FROM telemetry WHERE timestamp=?", (ts,)).fetchone()
        conn.close()
        assert row is not None
        assert row[2] == 2048        # wired_mb
        assert row[3] == pytest.approx(256.5)  # swap_used_mb
        assert row[4] == 5           # pageouts
        assert row[5] == pytest.approx(0.15)   # thrash_index

    def test_insert_thrash_index_boundary_zero(self, db_path):
        row_id = insert_telemetry(time.time(), 0, 0.0, 0, 0.0, path=db_path)
        assert row_id >= 1

    def test_insert_thrash_index_boundary_one(self, db_path):
        row_id = insert_telemetry(time.time(), 16384, 0.0, 0, 1.0, path=db_path)
        assert row_id >= 1

# ---------------------------------------------------------------------------
# get_latest_metrics
# ---------------------------------------------------------------------------

class TestGetLatestMetrics:
    def test_empty_table_returns_empty_list(self, db_path):
        assert get_latest_metrics(limit=10, path=db_path) == []

    def test_returns_list_of_dicts(self, db_path):
        insert_telemetry(time.time(), 4096, 512.0, 10, 0.3, path=db_path)
        rows = get_latest_metrics(limit=10, path=db_path)
        assert isinstance(rows, list)
        assert isinstance(rows[0], dict)

    def test_dict_has_expected_keys(self, db_path):
        insert_telemetry(time.time(), 4096, 512.0, 10, 0.3, path=db_path)
        row = get_latest_metrics(limit=1, path=db_path)[0]
        assert set(row.keys()) == {"id", "timestamp", "wired_mb", "swap_used_mb", "pageouts", "thrash_index"}

    def test_newest_first_ordering(self, db_path):
        for i in range(5):
            insert_telemetry(float(i), 1000 * (i + 1), 0.0, i, 0.1 * i, path=db_path)
        rows = get_latest_metrics(limit=5, path=db_path)
        ids = [r["id"] for r in rows]
        assert ids == sorted(ids, reverse=True)

    def test_limit_is_respected(self, db_path):
        for i in range(10):
            insert_telemetry(float(i), 1000, 0.0, i, 0.1, path=db_path)
        rows = get_latest_metrics(limit=3, path=db_path)
        assert len(rows) == 3

    def test_limit_larger_than_row_count(self, db_path):
        insert_telemetry(time.time(), 4096, 512.0, 10, 0.3, path=db_path)
        rows = get_latest_metrics(limit=100, path=db_path)
        assert len(rows) == 1

    def test_limit_zero_returns_empty(self, db_path):
        insert_telemetry(time.time(), 4096, 512.0, 10, 0.3, path=db_path)
        rows = get_latest_metrics(limit=0, path=db_path)
        assert rows == []

    def test_values_match_inserted(self, db_path):
        ts = 1_700_000_000.0
        insert_telemetry(ts, 2048, 256.5, 5, 0.15, path=db_path)
        row = get_latest_metrics(limit=1, path=db_path)[0]
        assert row["timestamp"] == pytest.approx(ts)
        assert row["wired_mb"] == 2048
        assert row["swap_used_mb"] == pytest.approx(256.5)
        assert row["pageouts"] == 5
        assert row["thrash_index"] == pytest.approx(0.15)
