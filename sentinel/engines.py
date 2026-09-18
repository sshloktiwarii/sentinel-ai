"""
sentinel/engines.py

Tier 2 Local LLM Engine & KV-Cache Telemetry Inspector for Sentinel-AI.
Probes local inference runtimes (Ollama, LM Studio), parses active model structures,
computes theoretical KV-cache memory allocations, and determines unified memory
pressure across Apple Silicon wired VRAM.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any

import httpx

# ── Architecture Specifications & Heuristics ─────────────────────────────────

@dataclass(frozen=True)
class ModelArchitecture:
    """Transformer architecture dimensions for KV-cache computation."""
    layers: int
    heads: int        # Number of Key/Value heads (N_kv_heads for GQA, or N_heads for MHA)
    head_dim: int     # Dimension per head (d_head)
    default_ctx: int  # Standard context window capacity
    precision_bytes: int = 2  # Default FP16 / BF16 (2 bytes per element)


# Standard architectures for popular open-weights model families
_ARCHITECTURE_REGISTRY: dict[str, ModelArchitecture] = {
    # Llama 3 / 3.1 / 3.2 family
    "llama3:8b": ModelArchitecture(layers=32, heads=8, head_dim=128, default_ctx=8192),
    "llama3.1:8b": ModelArchitecture(layers=32, heads=8, head_dim=128, default_ctx=131072),
    "llama3.2:1b": ModelArchitecture(layers=16, heads=8, head_dim=64, default_ctx=131072),
    "llama3.2:3b": ModelArchitecture(layers=28, heads=8, head_dim=128, default_ctx=131072),
    "llama3:70b": ModelArchitecture(layers=80, heads=8, head_dim=128, default_ctx=8192),
    "llama3.1:70b": ModelArchitecture(layers=80, heads=8, head_dim=128, default_ctx=131072),

    # Qwen 2.5 family
    "qwen2.5:0.5b": ModelArchitecture(layers=24, heads=2, head_dim=64, default_ctx=32768),
    "qwen2.5:1.5b": ModelArchitecture(layers=28, heads=2, head_dim=128, default_ctx=32768),
    "qwen2.5:3b": ModelArchitecture(layers=36, heads=2, head_dim=128, default_ctx=32768),
    "qwen2.5:7b": ModelArchitecture(layers=28, heads=4, head_dim=128, default_ctx=32768),
    "qwen2.5:14b": ModelArchitecture(layers=48, heads=8, head_dim=128, default_ctx=32768),
    "qwen2.5:32b": ModelArchitecture(layers=64, heads=8, head_dim=128, default_ctx=32768),
    "qwen2.5:72b": ModelArchitecture(layers=80, heads=8, head_dim=128, default_ctx=32768),

    # Mistral / Mixtral family
    "mistral:7b": ModelArchitecture(layers=32, heads=8, head_dim=128, default_ctx=32768),
    "mistral-nemo:12b": ModelArchitecture(layers=40, heads=8, head_dim=128, default_ctx=128000),
    "mixtral:8x7b": ModelArchitecture(layers=32, heads=8, head_dim=128, default_ctx=32768),

    # Phi-3 / Phi-3.5 family
    "phi3:mini": ModelArchitecture(layers=32, heads=32, head_dim=96, default_ctx=4096),
    "phi3:medium": ModelArchitecture(layers=40, heads=40, head_dim=128, default_ctx=4096),

    # Gemma 2 family
    "gemma2:2b": ModelArchitecture(layers=26, heads=4, head_dim=256, default_ctx=8192),
    "gemma2:9b": ModelArchitecture(layers=42, heads=8, head_dim=256, default_ctx=8192),
    "gemma2:27b": ModelArchitecture(layers=46, heads=16, head_dim=256, default_ctx=8192),

    # DeepSeek family
    "deepseek-coder:6.7b": ModelArchitecture(layers=32, heads=32, head_dim=128, default_ctx=16384),
    "deepseek-coder-v2:16b": ModelArchitecture(layers=27, heads=16, head_dim=128, default_ctx=131072),
}


def resolve_model_architecture(
    model_name: str,
    parameter_size_str: str = "",
    context_length: int | None = None,
) -> ModelArchitecture:
    """Resolve transformer architecture dimensions for a model name.

    Checks known registry first. If unknown, derives sensible transformer
    dimensions from parameter count heuristics.
    """
    clean_name = model_name.strip().lower()
    # Direct match or prefix match (e.g. "llama3:8b-instruct-q4_K_M" -> "llama3:8b")
    for key, arch in _ARCHITECTURE_REGISTRY.items():
        if clean_name == key or clean_name.startswith(key):
            if context_length and context_length > 0:
                return ModelArchitecture(
                    layers=arch.layers,
                    heads=arch.heads,
                    head_dim=arch.head_dim,
                    default_ctx=context_length,
                    precision_bytes=arch.precision_bytes,
                )
            return arch

    # Generic heuristic derivation based on parameter count
    param_num = 7.0  # default assumption 7B
    if parameter_size_str:
        m = re.search(r"([\d.]+)\s*[BMG]?", parameter_size_str, re.IGNORECASE)
        if m:
            try:
                param_num = float(m.group(1))
            except ValueError:
                param_num = 7.0
    else:
        # Try extracting from model name e.g. "custom-model-8b"
        m = re.search(r"(\d+(?:\.\d+)?)[bB]", clean_name)
        if m:
            try:
                param_num = float(m.group(1))
            except ValueError:
                param_num = 7.0

    ctx = context_length if (context_length and context_length > 0) else 8192

    if param_num <= 2.0:
        return ModelArchitecture(layers=24, heads=4, head_dim=64, default_ctx=ctx)
    elif param_num <= 4.0:
        return ModelArchitecture(layers=28, heads=4, head_dim=128, default_ctx=ctx)
    elif param_num <= 10.0:
        return ModelArchitecture(layers=32, heads=8, head_dim=128, default_ctx=ctx)
    elif param_num <= 20.0:
        return ModelArchitecture(layers=40, heads=8, head_dim=128, default_ctx=ctx)
    elif param_num <= 40.0:
        return ModelArchitecture(layers=64, heads=8, head_dim=128, default_ctx=ctx)
    else:
        return ModelArchitecture(layers=80, heads=8, head_dim=128, default_ctx=ctx)


# ── KV-Cache Math Formulation ────────────────────────────────────────────────

def compute_kv_cache_bytes(
    layers: int,
    heads: int,
    head_dim: int,
    context_len: int,
    precision_bytes: int = 2,
) -> int:
    """Compute theoretical KV-cache allocation in bytes.

    Formula:
      Bytes = 2 * N_layers * N_heads * d_head * N_ctx * precision

    Where:
      - 2 accounts for Key and Value tensors
      - N_layers = number of transformer attention blocks
      - N_heads  = number of KV attention heads
      - d_head   = dimension of each attention head
      - N_ctx    = context window sequence length
      - precision = bytes per element (default 2 for FP16/BF16)
    """
    if layers <= 0 or heads <= 0 or head_dim <= 0 or context_len <= 0 or precision_bytes <= 0:
        return 0
    return 2 * layers * heads * head_dim * context_len * precision_bytes


def bytes_to_mb(byte_count: int | float) -> float:
    """Convert bytes to megabytes (MiB) rounded to 2 decimal places."""
    return round(byte_count / (1024.0 * 1024.0), 2)


# ── Engine Payload Parsing ───────────────────────────────────────────────────

def parse_ollama_model(
    raw: dict[str, Any],
    wired_mb: float = 0.0,
) -> dict[str, Any]:
    """Parse an individual active model object from Ollama's /api/ps endpoint."""
    name = str(raw.get("name") or raw.get("model") or "unknown")
    details = raw.get("details", {}) or {}

    parameter_size = str(details.get("parameter_size") or "")
    quantization = str(details.get("quantization_level") or details.get("format") or "Unknown")

    total_bytes = int(raw.get("size", 0) or 0)
    vram_bytes = int(raw.get("size_vram", 0) or 0)
    ram_bytes = max(0, total_bytes - vram_bytes)

    gpu_offload_pct = (
        round((vram_bytes / total_bytes) * 100.0, 1) if total_bytes > 0 else 0.0
    )

    size_mb = bytes_to_mb(total_bytes)
    vram_mb = bytes_to_mb(vram_bytes)
    ram_mb = bytes_to_mb(ram_bytes)

    # Context window allocated
    context_length = raw.get("context_length") or raw.get("context_size")
    if not context_length:
        # Check details or fallback to architecture default
        context_length = details.get("context_length")

    arch = resolve_model_architecture(
        model_name=name,
        parameter_size_str=parameter_size,
        context_length=int(context_length) if context_length else None,
    )

    actual_ctx = int(context_length) if context_length else arch.default_ctx

    kv_bytes = compute_kv_cache_bytes(
        layers=arch.layers,
        heads=arch.heads,
        head_dim=arch.head_dim,
        context_len=actual_ctx,
        precision_bytes=arch.precision_bytes,
    )
    kv_mb = bytes_to_mb(kv_bytes)

    # Memory pressure ratios against current wired unified memory
    kv_cache_wired_pct = (
        round((kv_mb / wired_mb) * 100.0, 2) if wired_mb > 0 else 0.0
    )
    weights_wired_pct = (
        round((vram_mb / wired_mb) * 100.0, 2) if wired_mb > 0 else 0.0
    )

    return {
        "name": name,
        "parameter_size": parameter_size or "Unknown",
        "quantization": quantization,
        "context_length": actual_ctx,
        "size_mb": size_mb,
        "vram_mb": vram_mb,
        "ram_mb": ram_mb,
        "gpu_offload_pct": gpu_offload_pct,
        "kv_cache_bytes": kv_bytes,
        "kv_cache_mb": kv_mb,
        "kv_cache_wired_pct": min(100.0, kv_cache_wired_pct),
        "weights_wired_pct": min(100.0, weights_wired_pct),
        "architecture": {
            "layers": arch.layers,
            "heads": arch.heads,
            "head_dim": arch.head_dim,
            "precision_bytes": arch.precision_bytes,
        },
    }


# ── Engine Probers ───────────────────────────────────────────────────────────

def probe_ollama_sync(
    api_base: str = "http://127.0.0.1:11434",
    timeout: float = 1.5,
    wired_mb: float = 0.0,
) -> dict[str, Any] | None:
    """Synchronously probe Ollama's /api/ps endpoint.

    Returns parsed engine structure if Ollama is running and models are active,
    or None if Ollama is offline or unreachable.
    """
    url = f"{api_base.rstrip('/')}/api/ps"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            raw_models = data.get("models", [])
            parsed_models = [parse_ollama_model(m, wired_mb) for m in raw_models]
            total_kv_mb = sum(m["kv_cache_mb"] for m in parsed_models)
            total_vram_mb = sum(m["vram_mb"] for m in parsed_models)
            total_ram_mb = sum(m["ram_mb"] for m in parsed_models)

            return {
                "status": "active" if parsed_models else "idle",
                "engine": "ollama",
                "models": parsed_models,
                "total_kv_cache_mb": round(total_kv_mb, 2),
                "total_vram_mb": round(total_vram_mb, 2),
                "total_ram_mb": round(total_ram_mb, 2),
                "active_model_count": len(parsed_models),
            }
    except Exception:
        return None


async def probe_ollama_async(
    api_base: str = "http://127.0.0.1:11434",
    timeout: float = 1.5,
    wired_mb: float = 0.0,
) -> dict[str, Any] | None:
    """Asynchronously probe Ollama's /api/ps endpoint using httpx."""
    url = f"{api_base.rstrip('/')}/api/ps"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"Accept": "application/json"})
            if resp.status_code == 200:
                data = resp.json()
                raw_models = data.get("models", [])
                parsed_models = [parse_ollama_model(m, wired_mb) for m in raw_models]
                total_kv_mb = sum(m["kv_cache_mb"] for m in parsed_models)
                total_vram_mb = sum(m["vram_mb"] for m in parsed_models)
                total_ram_mb = sum(m["ram_mb"] for m in parsed_models)

                return {
                    "status": "active" if parsed_models else "idle",
                    "engine": "ollama",
                    "models": parsed_models,
                    "total_kv_cache_mb": round(total_kv_mb, 2),
                    "total_vram_mb": round(total_vram_mb, 2),
                    "total_ram_mb": round(total_ram_mb, 2),
                    "active_model_count": len(parsed_models),
                }
    except Exception:
        pass
    return None


def probe_lmstudio_sync(
    api_base: str = "http://127.0.0.1:1234",
    timeout: float = 1.5,
    wired_mb: float = 0.0,
) -> dict[str, Any] | None:
    """Synchronously probe LM Studio's /v1/models endpoint."""
    url = f"{api_base.rstrip('/')}/v1/models"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            raw_models = data.get("data", [])
            parsed_models: list[dict[str, Any]] = []
            for item in raw_models:
                m_id = item.get("id", "lmstudio-model")
                arch = resolve_model_architecture(m_id)
                kv_bytes = compute_kv_cache_bytes(
                    layers=arch.layers,
                    heads=arch.heads,
                    head_dim=arch.head_dim,
                    context_len=arch.default_ctx,
                    precision_bytes=arch.precision_bytes,
                )
                kv_mb = bytes_to_mb(kv_bytes)
                kv_pct = round((kv_mb / wired_mb) * 100.0, 2) if wired_mb > 0 else 0.0
                parsed_models.append({
                    "name": m_id,
                    "parameter_size": "Unknown",
                    "quantization": "Unknown",
                    "context_length": arch.default_ctx,
                    "size_mb": 0.0,
                    "vram_mb": 0.0,
                    "ram_mb": 0.0,
                    "gpu_offload_pct": 100.0,
                    "kv_cache_bytes": kv_bytes,
                    "kv_cache_mb": kv_mb,
                    "kv_cache_wired_pct": min(100.0, kv_pct),
                    "weights_wired_pct": 0.0,
                    "architecture": asdict(arch),
                })

            return {
                "status": "active" if parsed_models else "idle",
                "engine": "lmstudio",
                "models": parsed_models,
                "total_kv_cache_mb": round(sum(m["kv_cache_mb"] for m in parsed_models), 2),
                "total_vram_mb": 0.0,
                "total_ram_mb": 0.0,
                "active_model_count": len(parsed_models),
            }
    except Exception:
        return None


async def probe_lmstudio_async(
    api_base: str = "http://127.0.0.1:1234",
    timeout: float = 1.5,
    wired_mb: float = 0.0,
) -> dict[str, Any] | None:
    """Asynchronously probe LM Studio's /v1/models endpoint."""
    url = f"{api_base.rstrip('/')}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers={"Accept": "application/json"})
            if resp.status_code == 200:
                data = resp.json()
                raw_models = data.get("data", [])
                parsed_models: list[dict[str, Any]] = []
                for item in raw_models:
                    m_id = item.get("id", "lmstudio-model")
                    arch = resolve_model_architecture(m_id)
                    kv_bytes = compute_kv_cache_bytes(
                        layers=arch.layers,
                        heads=arch.heads,
                        head_dim=arch.head_dim,
                        context_len=arch.default_ctx,
                        precision_bytes=arch.precision_bytes,
                    )
                    kv_mb = bytes_to_mb(kv_bytes)
                    kv_pct = round((kv_mb / wired_mb) * 100.0, 2) if wired_mb > 0 else 0.0
                    parsed_models.append({
                        "name": m_id,
                        "parameter_size": "Unknown",
                        "quantization": "Unknown",
                        "context_length": arch.default_ctx,
                        "size_mb": 0.0,
                        "vram_mb": 0.0,
                        "ram_mb": 0.0,
                        "gpu_offload_pct": 100.0,
                        "kv_cache_bytes": kv_bytes,
                        "kv_cache_mb": kv_mb,
                        "kv_cache_wired_pct": min(100.0, kv_pct),
                        "weights_wired_pct": 0.0,
                        "architecture": asdict(arch),
                    })

                return {
                    "status": "active" if parsed_models else "idle",
                    "engine": "lmstudio",
                    "models": parsed_models,
                    "total_kv_cache_mb": round(sum(m["kv_cache_mb"] for m in parsed_models), 2),
                    "total_vram_mb": 0.0,
                    "total_ram_mb": 0.0,
                    "active_model_count": len(parsed_models),
                }
    except Exception:
        pass
    return None


# ── High-Level Aggregator with Short-Lived TTL Cache ─────────────────────────

_CACHE_TTL_SEC = 2.0
_cache_timestamp: float = 0.0
_cached_result: dict[str, Any] | None = None


def _get_inactive_snapshot() -> dict[str, Any]:
    """Default fallback snapshot when no local engine is active."""
    return {
        "status": "inactive",
        "engine": None,
        "models": [],
        "total_kv_cache_mb": 0.0,
        "total_vram_mb": 0.0,
        "total_ram_mb": 0.0,
        "active_model_count": 0,
    }


def get_local_engines_sync(wired_mb: float = 0.0) -> dict[str, Any]:
    """Return active local LLM engines and KV cache telemetry (synchronous)."""
    global _cache_timestamp, _cached_result
    now = time.time()
    if _cached_result is not None and (now - _cache_timestamp) < _CACHE_TTL_SEC:
        return _cached_result

    # 1. Probe Ollama first
    res = probe_ollama_sync(wired_mb=wired_mb)
    if res is not None:
        _cached_result = res
        _cache_timestamp = now
        return res

    # 2. Probe LM Studio
    res = probe_lmstudio_sync(wired_mb=wired_mb)
    if res is not None:
        _cached_result = res
        _cache_timestamp = now
        return res

    # 3. Inactive fallback
    fallback = _get_inactive_snapshot()
    _cached_result = fallback
    _cache_timestamp = now
    return fallback


async def get_local_engines_async(wired_mb: float = 0.0) -> dict[str, Any]:
    """Return active local LLM engines and KV cache telemetry (asynchronous)."""
    global _cache_timestamp, _cached_result
    now = time.time()
    if _cached_result is not None and (now - _cache_timestamp) < _CACHE_TTL_SEC:
        return _cached_result

    # 1. Probe Ollama first
    res = await probe_ollama_async(wired_mb=wired_mb)
    if res is not None:
        _cached_result = res
        _cache_timestamp = now
        return res

    # 2. Probe LM Studio
    res = await probe_lmstudio_async(wired_mb=wired_mb)
    if res is not None:
        _cached_result = res
        _cache_timestamp = now
        return res

    # 3. Inactive fallback
    fallback = _get_inactive_snapshot()
    _cached_result = fallback
    _cache_timestamp = now
    return fallback
