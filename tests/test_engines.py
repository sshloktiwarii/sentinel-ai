"""
tests/test_engines.py

Comprehensive unit tests for Tier 2 Local LLM Engine & KV-Cache Telemetry Inspector.
Tests:
- Theoretical KV-cache math formulation
- Model architecture resolution & heuristics
- Ollama /api/ps payload parsing (GPU offload, VRAM vs RAM split, unified memory %)
- Graceful offline fallback (when Ollama / LM Studio is down)
- REST endpoints GET /api/engines & GET /api/telemetry
- Harvester integration
"""

from unittest.mock import MagicMock, patch
import pytest
from starlette.testclient import TestClient

from sentinel.engines import (
    compute_kv_cache_bytes,
    bytes_to_mb,
    resolve_model_architecture,
    parse_ollama_model,
    get_local_engines_sync,
    get_local_engines_async,
    probe_ollama_sync,
    probe_lmstudio_sync,
)
from sentinel.harvester import get_engine_pressure_snapshot
from sentinel.server import app


# ── KV-Cache Mathematical Formulation Tests ──────────────────────────────────

class TestKVCacheMath:
    def test_llama3_8b_kv_cache_calculation(self):
        """Llama 3 8B at 8,192 ctx (32 layers, 8 KV heads, 128 head_dim, FP16):
        Bytes = 2 * 32 * 8 * 128 * 8192 * 2 = 1,073,741,824 B = 1024 MiB.
        """
        b = compute_kv_cache_bytes(
            layers=32,
            heads=8,
            head_dim=128,
            context_len=8192,
            precision_bytes=2,
        )
        assert b == 1_073_741_824
        assert bytes_to_mb(b) == 1024.0

    def test_qwen25_7b_kv_cache_calculation(self):
        """Qwen 2.5 7B at 32,768 ctx (28 layers, 4 KV heads, 128 head_dim, FP16):
        Bytes = 2 * 28 * 4 * 128 * 32768 * 2 = 1,879,048,192 B = 1792 MiB.
        """
        b = compute_kv_cache_bytes(
            layers=28,
            heads=4,
            head_dim=128,
            context_len=32768,
            precision_bytes=2,
        )
        assert b == 1_879_048_192
        assert bytes_to_mb(b) == 1792.0

    def test_zero_or_negative_inputs_return_zero(self):
        assert compute_kv_cache_bytes(0, 8, 128, 8192) == 0
        assert compute_kv_cache_bytes(32, 0, 128, 8192) == 0
        assert compute_kv_cache_bytes(32, 8, 0, 8192) == 0
        assert compute_kv_cache_bytes(32, 8, 128, 0) == 0
        assert compute_kv_cache_bytes(-1, 8, 128, 8192) == 0


# ── Architecture Resolution Tests ────────────────────────────────────────────

class TestArchitectureResolution:
    def test_resolve_exact_registry_model(self):
        arch = resolve_model_architecture("llama3:8b")
        assert arch.layers == 32
        assert arch.heads == 8
        assert arch.head_dim == 128
        assert arch.default_ctx == 8192

    def test_resolve_prefix_match(self):
        arch = resolve_model_architecture("qwen2.5:7b-instruct-q4_K_M")
        assert arch.layers == 28
        assert arch.heads == 4
        assert arch.head_dim == 128

    def test_custom_context_override(self):
        arch = resolve_model_architecture("llama3:8b", context_length=16384)
        assert arch.default_ctx == 16384

    def test_heuristic_resolution_from_param_string(self):
        arch = resolve_model_architecture("custom-unknown", parameter_size_str="14B")
        assert arch.layers == 40
        assert arch.heads == 8

    def test_heuristic_resolution_from_name(self):
        arch = resolve_model_architecture("my-finetune-70b-v1")
        assert arch.layers == 80
        assert arch.heads == 8


# ── Ollama Payload Parsing Tests ─────────────────────────────────────────────

class TestOllamaPayloadParsing:
    @pytest.fixture
    def mock_ollama_model(self):
        return {
            "name": "llama3:8b",
            "model": "llama3:8b",
            "size": 4_920_729_600,       # ~4692.77 MB
            "size_vram": 4_920_729_600,  # 100% GPU offload
            "details": {
                "parameter_size": "8.0B",
                "quantization_level": "Q4_K_M",
            },
            "context_length": 8192,
        }

    def test_parse_full_gpu_offload(self, mock_ollama_model):
        parsed = parse_ollama_model(mock_ollama_model, wired_mb=16384.0)
        assert parsed["name"] == "llama3:8b"
        assert parsed["parameter_size"] == "8.0B"
        assert parsed["quantization"] == "Q4_K_M"
        assert parsed["context_length"] == 8192
        assert parsed["gpu_offload_pct"] == 100.0
        assert parsed["ram_mb"] == 0.0
        assert parsed["vram_mb"] > 0
        assert parsed["kv_cache_mb"] == 1024.0
        # 1024 / 16384 = 6.25%
        assert parsed["kv_cache_wired_pct"] == 6.25
        assert parsed["weights_wired_pct"] > 25.0

    def test_parse_partial_gpu_offload(self):
        raw = {
            "name": "qwen2.5:14b",
            "size": 9_000_000_000,
            "size_vram": 6_000_000_000,  # ~66.7% GPU offload
            "details": {
                "parameter_size": "14.7B",
                "quantization_level": "Q4_K_M",
            },
            "context_length": 32768,
        }
        parsed = parse_ollama_model(raw, wired_mb=18432.0)
        assert parsed["gpu_offload_pct"] == 66.7
        assert parsed["ram_mb"] > 0
        assert parsed["vram_mb"] > 0
        assert parsed["context_length"] == 32768
        assert parsed["kv_cache_mb"] > 0


# ── Offline Fallback Tests ───────────────────────────────────────────────────

class TestOfflineFallback:
    def test_probe_ollama_offline_returns_none(self):
        with patch("urllib.request.urlopen", side_effect=OSError("Connection refused")):
            res = probe_ollama_sync("http://127.0.0.1:99999")
            assert res is None

    def test_probe_lmstudio_offline_returns_none(self):
        with patch("urllib.request.urlopen", side_effect=OSError("Connection refused")):
            res = probe_lmstudio_sync("http://127.0.0.1:99999")
            assert res is None

    def test_get_local_engines_offline_returns_inactive_dict(self):
        with patch("sentinel.engines.probe_ollama_sync", return_value=None):
            with patch("sentinel.engines.probe_lmstudio_sync", return_value=None):
                with patch("sentinel.engines._cached_result", None):
                    res = get_local_engines_sync()
                    assert res["status"] == "inactive"
                    assert res["engine"] is None
                    assert res["models"] == []
                    assert res["total_kv_cache_mb"] == 0.0
                    assert res["active_model_count"] == 0


# ── Harvester Integration Tests ──────────────────────────────────────────────

class TestHarvesterIntegration:
    def test_get_engine_pressure_snapshot_inactive(self):
        with patch("sentinel.harvester.get_wired_memory_mb", return_value=16384.0):
            with patch("sentinel.engines.get_local_engines_sync") as mock_engine:
                mock_engine.return_value = {
                    "status": "inactive",
                    "models": [],
                    "total_kv_cache_mb": 0.0,
                }
                snap = get_engine_pressure_snapshot(16384.0)
                assert snap["engine_active"] is False
                assert snap["kv_cache_mb"] == 0.0
                assert snap["kv_pressure_pct"] == 0.0
                assert snap["active_models"] == []

    def test_get_engine_pressure_snapshot_active(self):
        with patch("sentinel.harvester.get_wired_memory_mb", return_value=10000.0):
            with patch("sentinel.engines.get_local_engines_sync") as mock_engine:
                mock_engine.return_value = {
                    "status": "active",
                    "engine": "ollama",
                    "models": [{"name": "qwen2.5:7b"}],
                    "total_kv_cache_mb": 1792.0,
                }
                snap = get_engine_pressure_snapshot(10000.0)
                assert snap["engine_active"] is True
                assert snap["engine_name"] == "ollama"
                assert snap["kv_cache_mb"] == 1792.0
                # 1792 / 10000 = 17.92%
                assert snap["kv_pressure_pct"] == 17.92
                assert snap["active_models"] == ["qwen2.5:7b"]


# ── FastAPI Endpoints Tests ──────────────────────────────────────────────────

class TestServerEndpoints:
    def test_get_api_engines_endpoint(self):
        mock_data = {
            "status": "active",
            "engine": "ollama",
            "models": [
                {
                    "name": "llama3:8b",
                    "parameter_size": "8.0B",
                    "quantization": "Q4_K_M",
                    "context_length": 8192,
                    "size_mb": 4692.77,
                    "vram_mb": 4692.77,
                    "ram_mb": 0.0,
                    "gpu_offload_pct": 100.0,
                    "kv_cache_bytes": 1073741824,
                    "kv_cache_mb": 1024.0,
                    "kv_cache_wired_pct": 6.25,
                    "weights_wired_pct": 28.64,
                }
            ],
            "total_kv_cache_mb": 1024.0,
            "total_vram_mb": 4692.77,
            "total_ram_mb": 0.0,
            "active_model_count": 1,
        }
        with patch("sentinel.server.get_local_engines_async", return_value=mock_data):
            with TestClient(app) as client:
                resp = client.get("/api/engines")
                assert resp.status_code == 200
                data = resp.json()
                assert data["status"] == "active"
                assert data["engine"] == "ollama"
                assert len(data["models"]) == 1
                assert data["models"][0]["name"] == "llama3:8b"
                assert data["total_kv_cache_mb"] == 1024.0

    def test_get_api_telemetry_endpoint(self):
        with patch("sentinel.server.get_gpu_wired_limit", return_value=16384), \
             patch("sentinel.server.get_wired_memory_mb", return_value=8192.0), \
             patch("sentinel.server.get_swap_usage", return_value=(2048.0, 0.0)), \
             patch("sentinel.server.get_pageout_count", return_value=0), \
             patch("sentinel.server.compute_thrash_danger_index", return_value=0.35), \
             patch("sentinel.server.get_engine_pressure_snapshot", return_value={
                 "engine_active": True,
                 "kv_cache_mb": 1024.0,
                 "kv_pressure_pct": 12.5,
             }):
            with TestClient(app) as client:
                resp = client.get("/api/telemetry")
                assert resp.status_code == 200
                data = resp.json()
                assert data["wired_mb"] == 8192.0
                assert data["thrash_index"] == 0.35
                assert data["engine_active"] is True
                assert data["kv_cache_mb"] == 1024.0
                assert data["kv_pressure_pct"] == 12.5
