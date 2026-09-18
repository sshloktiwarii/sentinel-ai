"""
sentinel/quota.py

AI-provider quota monitoring for Sentinel-AI.

Strategy per provider
─────────────────────
Anthropic  – Check the Anthropic API rate-limit headers by sending a tiny
             "peek" request (max_tokens=1) if ANTHROPIC_API_KEY is set.
             Falls back to baseline defaults if the key is absent or the
             request fails.

OpenAI     – Check OpenAI usage headers via a models-list request.
             Falls back to baseline defaults if the key is absent.

OmniRoute  – Probe http://localhost:20128/ for reachability.
             Updates the omniroute baseline record if reachable.

Cursor / Kimi / Manus – No public quota APIs; always return baseline
             defaults (realistic demo values).

Guarantees
──────────
get_all_quotas() NEVER returns an empty list. The BASELINE list is the
floor — live data can only update individual fields, never remove records.
"""

from __future__ import annotations

import math
import os
import time
import datetime
import json
import re
import urllib.request
import urllib.error
from copy import deepcopy
from typing import Literal

# ── Types ─────────────────────────────────────────────────────────────────────

Status = Literal["healthy", "warning", "exhausted"]

# ── Baseline records ──────────────────────────────────────────────────────────
# These are the canonical defaults returned when live data is unavailable.
# They also define the complete list of providers shown in the UI.

_BASELINE: list[dict] = [
    {
        "id":            "claude",
        "provider":      "Anthropic Claude",
        "model":         "Claude 3.5 Sonnet",
        "remaining_pct": 82,
        "tokens_left":   "164k / 200k",
        "resets_in":     "3h 12m",
        "status":        "healthy",
    },
    {
        "id":            "codex",
        "provider":      "OpenAI / Codex",
        "model":         "GPT-4o / o1-mini",
        "remaining_pct": 65,
        "tokens_left":   "650k TPM",
        "resets_in":     "Daily (00:00 UTC)",
        "status":        "healthy",
    },
    {
        "id":            "omniroute",
        "provider":      "OmniRoute Proxy",
        "model":         "Local Gateway :20128",
        "remaining_pct": 94,
        "tokens_left":   "Unlimited / Self-Hosted",
        "resets_in":     "Active",
        "status":        "healthy",
    },
    {
        "id":            "kimi",
        "provider":      "Moonshot Kimi",
        "model":         "Kimi 128k",
        "remaining_pct": 40,
        "tokens_left":   "40k / 100k",
        "resets_in":     "1h 45m",
        "status":        "warning",
    },
    {
        "id":            "cursor",
        "provider":      "Cursor Tab / Fast Requests",
        "model":         "Sonnet 3.5 Copilot",
        "remaining_pct": 28,
        "tokens_left":   "140 / 500 reqs",
        "resets_in":     "6 days",
        "status":        "warning",
    },
    {
        "id":            "manus",
        "provider":      "Manus / Agent Sandbox",
        "model":         "Full Autonomous Runner",
        "remaining_pct": 12,
        "tokens_left":   "12 / 100 credits",
        "resets_in":     "Tomorrow",
        "status":        "exhausted",
    },
]

# ── Helpers ───────────────────────────────────────────────────────────────────

def _status_from_pct(pct: float) -> Status:
    if pct >= 50:
        return "healthy"
    if pct >= 20:
        return "warning"
    return "exhausted"

def _fmt_tokens(n: int | float) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(int(n))

def _seconds_to_human(seconds: float) -> str:
    """Convert a duration in seconds to a compact human string."""
    if seconds <= 0:
        return "< 1m"
    minutes = int(seconds // 60)
    hours   = minutes // 60
    mins    = minutes % 60
    if hours > 0:
        return f"{hours}h {mins}m" if mins else f"{hours}h"
    if minutes == 0:
        return "< 1m"
    return f"{minutes}m"

def _next_five_hour_reset() -> float:
    """Seconds until the next 5-hour boundary (00, 05, 10, 15, 20 UTC hour)."""
    now_utc     = time.gmtime()
    hour        = now_utc.tm_hour
    minute      = now_utc.tm_min
    current_sec = hour * 3600 + minute * 60 + now_utc.tm_sec
    slot        = math.ceil((hour + minute / 60) / 5) * 5
    if slot >= 24:
        slot = 0
    target_sec  = slot * 3600
    diff        = target_sec - current_sec
    if diff <= 0:
        diff += 5 * 3600
    return diff

def _next_midnight_seconds() -> float:
    """Seconds until the next 00:00 UTC."""
    now_utc = time.gmtime()
    return (
        (23 - now_utc.tm_hour) * 3600
        + (59 - now_utc.tm_min) * 60
        + (60 - now_utc.tm_sec)
    )

def _http_get(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float = 3.0,
) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, dict(resp.headers), resp.read()

# ── Per-provider live probes ──────────────────────────────────────────────────
# Each probe returns a partial dict of fields to *merge* into the baseline
# record for that provider id.  If a probe fails, it returns {} so the
# baseline values are preserved unchanged.

_ANTHROPIC_CACHE_TS: float = 0.0
_ANTHROPIC_CACHE: dict = {}
_ANTHROPIC_TTL = 30.0

def _probe_anthropic() -> dict:
    """Return updated fields for the 'claude' record, or {} on failure."""
    global _ANTHROPIC_CACHE, _ANTHROPIC_CACHE_TS

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {}

    now = time.time()
    if _ANTHROPIC_CACHE and (now - _ANTHROPIC_CACHE_TS) < _ANTHROPIC_TTL:
        return _ANTHROPIC_CACHE

    try:
        body = json.dumps({
            "model":      "claude-sonnet-4-5",
            "max_tokens": 1,
            "messages":   [{"role": "user", "content": "hi"}],
        }).encode()

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data    = body,
            headers = {
                "x-api-key":         api_key,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json",
            },
            method = "POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                hdrs = dict(resp.headers)
        except urllib.error.HTTPError as e:
            hdrs = dict(e.headers)

        remaining = int(hdrs.get("anthropic-ratelimit-tokens-remaining", 0) or 0)
        limit     = int(hdrs.get("anthropic-ratelimit-tokens-limit", 200_000) or 200_000)
        reset_at  = hdrs.get("anthropic-ratelimit-tokens-reset", "")

        if limit <= 0:
            limit = 200_000

        if reset_at:
            try:
                dt       = datetime.datetime.fromisoformat(reset_at.replace("Z", "+00:00"))
                diff     = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
                resets_in = _seconds_to_human(max(diff, 0))
            except Exception:
                resets_in = _seconds_to_human(_next_five_hour_reset())
        else:
            resets_in = _seconds_to_human(_next_five_hour_reset())

        pct    = round(min((remaining / limit) * 100, 100.0), 1)
        result = {
            "remaining_pct": pct,
            "tokens_left":   f"{_fmt_tokens(remaining)} / {_fmt_tokens(limit)}",
            "resets_in":     resets_in,
            "status":        _status_from_pct(pct),
        }
        _ANTHROPIC_CACHE    = result
        _ANTHROPIC_CACHE_TS = now
        return result

    except Exception:
        return {}

_OPENAI_CACHE_TS: float = 0.0
_OPENAI_CACHE: dict = {}
_OPENAI_TTL = 30.0

def _probe_openai() -> dict:
    """Return updated fields for the 'codex' record, or {} on failure."""
    global _OPENAI_CACHE, _OPENAI_CACHE_TS

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return {}

    now = time.time()
    if _OPENAI_CACHE and (now - _OPENAI_CACHE_TS) < _OPENAI_TTL:
        return _OPENAI_CACHE

    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                hdrs = dict(resp.headers)
        except urllib.error.HTTPError as e:
            hdrs = dict(e.headers)

        tpm_remaining = int(hdrs.get("x-ratelimit-remaining-tokens",   0) or 0)
        tpm_limit     = int(hdrs.get("x-ratelimit-limit-tokens",   1_000_000) or 1_000_000)
        reset_str     = hdrs.get("x-ratelimit-reset-tokens", "")

        if tpm_limit <= 0:
            tpm_limit = 1_000_000

        def _parse_reset(s: str) -> str:
            m = re.fullmatch(r"(?:(\d+)m)?(?:(\d+)s)?", s or "")
            if not m:
                return "Daily (00:00 UTC)"
            mins = int(m.group(1) or 0)
            secs = int(m.group(2) or 0)
            return _seconds_to_human(mins * 60 + secs)

        if tpm_remaining:
            pct        = round(min((tpm_remaining / tpm_limit) * 100, 100.0), 1)
            tokens_str = f"{_fmt_tokens(tpm_remaining)} TPM"
            resets_in  = _parse_reset(reset_str) if reset_str else "Daily (00:00 UTC)"
        else:
            # Headers not present on /models — preserve baseline look
            return {}

        result = {
            "remaining_pct": pct,
            "tokens_left":   tokens_str,
            "resets_in":     resets_in,
            "status":        _status_from_pct(pct),
        }
        _OPENAI_CACHE    = result
        _OPENAI_CACHE_TS = now
        return result

    except Exception:
        return {}

OMNIROUTE_BASE   = "http://localhost:20128"
_OMNIROUTE_CACHE_TS: float = 0.0
_OMNIROUTE_CACHE: dict = {}
_OMNIROUTE_TTL = 15.0

def _probe_omniroute() -> dict:
    """Return updated fields for the 'omniroute' record, or {} on failure."""
    global _OMNIROUTE_CACHE, _OMNIROUTE_CACHE_TS

    now = time.time()
    if _OMNIROUTE_CACHE and (now - _OMNIROUTE_CACHE_TS) < _OMNIROUTE_TTL:
        return _OMNIROUTE_CACHE

    reachable = False
    for probe in ("/v1/", "/"):
        try:
            status, _, _ = _http_get(f"{OMNIROUTE_BASE}{probe}", timeout=2.0)
            if status < 500:
                reachable = True
                break
        except Exception:
            continue

    if reachable:
        result = {
            "remaining_pct": 94,
            "tokens_left":   "Unlimited / Self-Hosted",
            "resets_in":     "Active",
            "status":        "healthy",
        }
    else:
        result = {
            "remaining_pct": 0,
            "tokens_left":   "Unreachable",
            "resets_in":     "—",
            "status":        "exhausted",
        }

    _OMNIROUTE_CACHE    = result
    _OMNIROUTE_CACHE_TS = now
    return result

# ── Public API ────────────────────────────────────────────────────────────────

def get_all_quotas() -> list[dict]:
    """
    Return quota records for all providers as plain dicts ready for JSON
    serialisation.

    Always returns a non-empty list — the BASELINE is the floor.
    Live probes can update individual fields but cannot remove records.
    """
    # Start from a deep copy of the baseline so we never mutate the source
    records = deepcopy(_BASELINE)

    # Build an index for O(1) lookup
    index = {r["id"]: r for r in records}

    # Merge live probe results where available
    probe_map: dict[str, dict] = {
        "claude":     _probe_anthropic(),
        "codex":      _probe_openai(),
        "omniroute":  _probe_omniroute(),
    }

    for provider_id, updates in probe_map.items():
        if updates and provider_id in index:
            index[provider_id].update(updates)

    return records
