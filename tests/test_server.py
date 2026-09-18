"""
tests/test_server.py

Tests for sentinel/server.py WebSocket endpoint.

Strategy:
- Use Starlette's TestClient with its built-in WebSocket support (synchronous,
  no event-loop conflicts) for connection and payload tests.
- Patch harvester functions so tests are hermetic and never touch real sysctl.
- Patch insert_telemetry so tests never write to disk.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from starlette.testclient import TestClient

from sentinel.server import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MOCK_LIMIT = 16384
MOCK_WIRED = 16384
MOCK_SWAP_TOTAL = 2048.0
MOCK_SWAP_USED = 512.0
MOCK_PAGEOUTS = 42
MOCK_THRASH = 0.5

def _patch_harvester():
    """Return a context-manager stack that mocks all harvester calls."""
    return (
        patch("sentinel.server.get_gpu_wired_limit", return_value=MOCK_LIMIT),
        patch("sentinel.server.get_swap_usage", return_value=(MOCK_SWAP_TOTAL, MOCK_SWAP_USED)),
        patch("sentinel.server.get_pageout_count", return_value=MOCK_PAGEOUTS),
        patch("sentinel.server.compute_thrash_danger_index", return_value=MOCK_THRASH),
        patch("sentinel.server.insert_telemetry", return_value=1),
        patch("sentinel.server.init_db"),
    )

# ---------------------------------------------------------------------------
# Connection tests
# ---------------------------------------------------------------------------

class TestWebSocketConnection:
    def test_connection_is_accepted(self):
        """Client should be able to connect without an error."""
        patches = _patch_harvester()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with TestClient(app) as client:
                with client.websocket_connect("/ws/telemetry") as ws:
                    # Receive one message to confirm the handshake completed
                    ws.receive_text()

    def test_endpoint_path_exists(self):
        """Connecting to a wrong path should raise an error (404/rejected)."""
        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/ws/does-not-exist") as ws:
                    ws.receive_text()

# ---------------------------------------------------------------------------
# Payload tests
# ---------------------------------------------------------------------------

class TestTelemetryPayload:
    def _get_message(self) -> dict:
        patches = _patch_harvester()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with TestClient(app) as client:
                with client.websocket_connect("/ws/telemetry") as ws:
                    raw = ws.receive_text()
        return json.loads(raw)

    def test_payload_is_valid_json(self):
        patches = _patch_harvester()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with TestClient(app) as client:
                with client.websocket_connect("/ws/telemetry") as ws:
                    raw = ws.receive_text()
        # json.loads raises if invalid
        parsed = json.loads(raw)
        assert isinstance(parsed, dict)

    def test_payload_has_required_keys(self):
        msg = self._get_message()
        required = {
            "timestamp",
            "wired_mb",
            "limit_mb",
            "swap_total_mb",
            "swap_used_mb",
            "pageouts",
            "thrash_index",
        }
        assert required.issubset(msg.keys())

    def test_payload_timestamp_is_numeric(self):
        msg = self._get_message()
        assert isinstance(msg["timestamp"], (int, float))
        assert msg["timestamp"] > 0

    def test_payload_wired_mb_matches_mock(self):
        msg = self._get_message()
        assert msg["wired_mb"] == MOCK_LIMIT

    def test_payload_swap_used_mb_matches_mock(self):
        msg = self._get_message()
        assert msg["swap_used_mb"] == pytest.approx(MOCK_SWAP_USED)

    def test_payload_pageouts_matches_mock(self):
        msg = self._get_message()
        assert msg["pageouts"] == MOCK_PAGEOUTS

    def test_payload_thrash_index_matches_mock(self):
        msg = self._get_message()
        assert msg["thrash_index"] == pytest.approx(MOCK_THRASH)

    def test_payload_thrash_index_in_range(self):
        msg = self._get_message()
        assert 0.0 <= msg["thrash_index"] <= 1.0

# ---------------------------------------------------------------------------
# Persistence tests
# ---------------------------------------------------------------------------

class TestPersistence:
    def test_insert_telemetry_is_called(self):
        """Each broadcasted message must trigger one insert_telemetry call."""
        patches = _patch_harvester()
        with patches[0], patches[1], patches[2], patches[3] as mock_thrash, \
             patches[4] as mock_insert, patches[5]:
            with TestClient(app) as client:
                with client.websocket_connect("/ws/telemetry") as ws:
                    ws.receive_text()
            assert mock_insert.call_count >= 1

    def test_insert_called_with_correct_swap(self):
        patches = _patch_harvester()
        with patches[0], patches[1], patches[2], patches[3], \
             patches[4] as mock_insert, patches[5]:
            with TestClient(app) as client:
                with client.websocket_connect("/ws/telemetry") as ws:
                    ws.receive_text()
            call_kwargs = mock_insert.call_args
            # accept both positional and keyword call styles
            args, kwargs = call_kwargs
            swap = kwargs.get("swap_used_mb", args[2] if len(args) > 2 else None)
            assert swap == pytest.approx(MOCK_SWAP_USED)
