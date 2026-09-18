"""
sentinel/quota.py

AI-provider quota monitoring for Sentinel-AI.

Strategy per provider
─────────────────────
Anthropic  – Check the Anthropic API rate-limit headers by sending a tiny
             "peek" request (max_tokens=1) if ANTHROPIC_API_KEY is set.
             Headers: anthropic-ratelimit-tokens-remaining,
                      anthropic-ratelimit-tokens-reset
             Fallback: mock 100 % if key absent.

OpenAI     – Check OpenAI usage headers via a models-list HEAD request
             (x-ratelimit-remaining-tokens, x-ratelimit-remaining-requests).
             Fallback: mock 100 % if key absent.

OmniRoute  – Probe http://localhost:20128/ for a 200 / known JSON shape.
             If reachable, we synthesise per-route records from a static
             registry (OmniRoute doesn't expose per-model quota in its
             public surface area).  If unreachable, full mock.

Cursor     – No public quota API; always returns a mock record.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field
from typing import Literal

import urllib.request
import urllib.error
import json

# ── Types ─────────────────────────────────────────────────────────────────────

Status = Literal["healthy", "warning", "exhausted"]

@dataclass
class QuotaRecord:
    provider:      str
    model:         str
    remaining_pct: float           # 0–100
    tokens_left:   str             # human-readable string
    resets_in:     str             # human-readable string
    status:        Status
    action_label:  str  = ""       # pill button label
    action_value:  str  = ""       # value to copy / route string

# ── Helpers ───────────────────────────────────────────────────────────────────

def _status_from_pct(pct: float) -> Status:
    if pct >= 50:
        return "healthy"
    if pct >= 20:
        return "warning"
    return "exhausted"

def _fmt_tokens(n: int | float) -> str:
    """Return a compact human-readable token count."""
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}k"
    return str(int(n))

def _seconds_to_human(seconds: float) -> str:
    """Convert seconds to 'Xh Ym' or 'Zm' or '< 1m'."""
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
    """Seconds until the next 5-hour rolling boundary (00,05,10,…,20 UTC)."""
    now_utc   = time.gmtime()
    hour      = now_utc.tm_hour
    minute    = now_utc.tm_sec // 60 + now_utc.tm_min
    # Slots: 0,5,10,15,20 -> next slot
    slot      = math.ceil((hour + minute / 60) / 5) * 5
    if slot >= 24:
        slot  = 0
    target_sec = slot * 3600
    current_sec = hour * 3600 + now_utc.tm_min * 60 + now_utc.tm_sec
    diff = target_sec - current_sec
    if diff <= 0:
        diff += 5 * 3600
    return diff

def _next_midnight_utc() -> str:
    """'Daily limit resets at 00:00 UTC' style string."""
    now_utc = time.gmtime()
    remaining = (
        (23 - now_utc.tm_hour) * 3600
        + (59 - now_utc.tm_min) * 60
        + (60 - now_utc.tm_sec)
    )
    return f"Daily reset in {_seconds_to_human(remaining)}"

def _http_get(url: str, headers: dict[str, str] | None = None, timeout: float = 3.0):
    """
    Minimal HTTP GET.  Returns (status_code, response_headers, body_bytes).
    Raises urllib.error.URLError on network failure.
    """
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, dict(resp.headers), resp.read()

# ── Anthropic ─────────────────────────────────────────────────────────────────

_ANTHROPIC_CACHE: dict = {}
_ANTHROPIC_CACHE_TS: float = 0.0
_ANTHROPIC_CACHE_TTL = 30.0   # seconds between live probes

def _fetch_anthropic() -> QuotaRecord:
    global _ANTHROPIC_CACHE, _ANTHROPIC_CACHE_TS

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        # No key — return a neutral mock
        return QuotaRecord(
            provider      = "Anthropic",
            model         = "claude-opus-4-5",
            remaining_pct = 100.0,
            tokens_left   = "—",
            resets_in     = _seconds_to_human(_next_five_hour_reset()),
            status        = "healthy",
            action_label  = "Set ANTHROPIC_API_KEY",
            action_value  = "export ANTHROPIC_API_KEY=sk-ant-…",
        )

    now = time.time()
    if _ANTHROPIC_CACHE and (now - _ANTHROPIC_CACHE_TS) < _ANTHROPIC_CACHE_TTL:
        return _ANTHROPIC_CACHE  # type: ignore[return-value]

    try:
        # Minimal messages request — 1 token budget so it fails cheap but
        # still returns rate-limit headers.
        body = json.dumps({
            "model":      "claude-opus-4-5",
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
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            hdrs = dict(resp.headers)
    except urllib.error.HTTPError as e:
        hdrs = dict(e.headers)
    except Exception:
        hdrs = {}

    remaining = int(hdrs.get("anthropic-ratelimit-tokens-remaining", 0) or 0)
    limit      = int(hdrs.get("anthropic-ratelimit-tokens-limit",     400_000) or 400_000)
    reset_at   = hdrs.get("anthropic-ratelimit-tokens-reset", "")  # ISO-8601

    if reset_at:
        try:
            import datetime
            dt   = datetime.datetime.fromisoformat(reset_at.replace("Z", "+00:00"))
            diff = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            resets_in = _seconds_to_human(max(diff, 0))
        except Exception:
            resets_in = _seconds_to_human(_next_five_hour_reset())
    else:
        resets_in = _seconds_to_human(_next_five_hour_reset())

    if limit <= 0:
        limit = 400_000

    pct    = min((remaining / limit) * 100, 100.0)
    record = QuotaRecord(
        provider      = "Anthropic",
        model         = "claude-opus-4-5",
        remaining_pct = round(pct, 1),
        tokens_left   = _fmt_tokens(remaining),
        resets_in     = resets_in,
        status        = _status_from_pct(pct),
        action_label  = "Copy API Key",
        action_value  = api_key[:12] + "…",
    )
    _ANTHROPIC_CACHE    = record  # type: ignore[assignment]
    _ANTHROPIC_CACHE_TS = now
    return record

# ── OpenAI ────────────────────────────────────────────────────────────────────

_OPENAI_CACHE: dict = {}
_OPENAI_CACHE_TS: float = 0.0
_OPENAI_CACHE_TTL = 30.0

def _fetch_openai() -> list[QuotaRecord]:
    global _OPENAI_CACHE, _OPENAI_CACHE_TS

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        mock_records = [
            QuotaRecord(
                provider      = "OpenAI",
                model         = "codex / o4-mini",
                remaining_pct = 100.0,
                tokens_left   = "—",
                resets_in     = _seconds_to_human(60),
                status        = "healthy",
                action_label  = "Set OPENAI_API_KEY",
                action_value  = "export OPENAI_API_KEY=sk-…",
            )
        ]
        return mock_records

    now = time.time()
    if _OPENAI_CACHE and (now - _OPENAI_CACHE_TS) < _OPENAI_CACHE_TTL:
        return _OPENAI_CACHE  # type: ignore[return-value]

    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            hdrs = dict(resp.headers)
    except urllib.error.HTTPError as e:
        hdrs = dict(e.headers)
    except Exception:
        hdrs = {}

    # OpenAI injects these on chat/completions, not /models, so they may be absent
    tpm_remaining = int(hdrs.get("x-ratelimit-remaining-tokens",   0) or 0)
    rpm_remaining = int(hdrs.get("x-ratelimit-remaining-requests", 0) or 0)
    tpm_limit     = int(hdrs.get("x-ratelimit-limit-tokens",   500_000) or 500_000)
    rpm_limit     = int(hdrs.get("x-ratelimit-limit-requests",     500) or 500)

    reset_tokens_in   = hdrs.get("x-ratelimit-reset-tokens",   "60s")
    reset_requests_in = hdrs.get("x-ratelimit-reset-requests", "60s")

    def _parse_reset(s: str) -> str:
        """Parse '18m30s' / '30s' OpenAI reset strings."""
        import re
        m = re.fullmatch(r"(?:(\d+)m)?(?:(\d+)s)?", s or "")
        if not m:
            return "< 1m"
        mins = int(m.group(1) or 0)
        secs = int(m.group(2) or 0)
        return _seconds_to_human(mins * 60 + secs)

    if tpm_limit <= 0:
        tpm_limit = 500_000
    if rpm_limit <= 0:
        rpm_limit = 500

    tpm_pct = min((tpm_remaining / tpm_limit) * 100, 100.0) if tpm_remaining else 100.0
    rpm_pct = min((rpm_remaining / rpm_limit) * 100, 100.0) if rpm_remaining else 100.0

    records = [
        QuotaRecord(
            provider      = "OpenAI",
            model         = "o4-mini (TPM)",
            remaining_pct = round(tpm_pct, 1),
            tokens_left   = _fmt_tokens(tpm_remaining) if tpm_remaining else "—",
            resets_in     = _parse_reset(reset_tokens_in),
            status        = _status_from_pct(tpm_pct),
            action_label  = "Copy API Key",
            action_value  = api_key[:12] + "…",
        ),
        QuotaRecord(
            provider      = "OpenAI",
            model         = "o4-mini (RPM)",
            remaining_pct = round(rpm_pct, 1),
            tokens_left   = f"{rpm_remaining} req" if rpm_remaining else "—",
            resets_in     = _parse_reset(reset_requests_in),
            status        = _status_from_pct(rpm_pct),
            action_label  = "Copy API Key",
            action_value  = api_key[:12] + "…",
        ),
    ]

    _OPENAI_CACHE    = records  # type: ignore[assignment]
    _OPENAI_CACHE_TS = now
    return records

# ── OmniRoute ─────────────────────────────────────────────────────────────────

OMNIROUTE_BASE    = "http://localhost:20128"
_OMNIROUTE_ROUTES = [
    ("Kimi / Moonshot",  "kimi-k2",         "Route via OmniRoute",  "kimi-k2"),
    ("OpenCode",         "opencode-latest",  "Route via OmniRoute",  "opencode-latest"),
    ("Qwen",             "qwen3-235b",       "Route via OmniRoute",  "qwen3-235b"),
    ("Manus / Agent",    "manus-agent-v2",   "Route via OmniRoute",  "manus-agent-v2"),
]

_OMNIROUTE_CACHE: dict = {}
_OMNIROUTE_CACHE_TS: float = 0.0
_OMNIROUTE_CACHE_TTL = 20.0

def _fetch_omniroute() -> list[QuotaRecord]:
    global _OMNIROUTE_CACHE, _OMNIROUTE_CACHE_TS

    now = time.time()
    if _OMNIROUTE_CACHE and (now - _OMNIROUTE_CACHE_TS) < _OMNIROUTE_CACHE_TTL:
        return _OMNIROUTE_CACHE  # type: ignore[return-value]

    # Probe OmniRoute health — try /v1/ then /
    reachable = False
    hdrs: dict[str, str] = {}
    for probe in ("/v1/", "/"):
        try:
            status, resp_hdrs, _ = _http_get(
                f"{OMNIROUTE_BASE}{probe}", timeout=2.0
            )
            if status < 500:
                reachable = True
                hdrs = resp_hdrs
                break
        except Exception:
            continue

    reset_secs = _next_five_hour_reset()

    records: list[QuotaRecord] = []
    for provider, model, action_label, action_value in _OMNIROUTE_ROUTES:
        if reachable:
            # OmniRoute doesn't expose per-model quotas publicly, so we
            # synthesise a "healthy — upstream reachable" record.
            pct = 100.0
            tokens_left = "unlimited*"
            resets_in   = _seconds_to_human(reset_secs)
            status_val: Status = "healthy"
        else:
            # Unreachable — warn but keep UI useful
            pct         = 0.0
            tokens_left = "unreachable"
            resets_in   = "—"
            status_val  = "exhausted"

        records.append(QuotaRecord(
            provider      = f"OmniRoute › {provider}",
            model         = model,
            remaining_pct = pct,
            tokens_left   = tokens_left,
            resets_in     = resets_in,
            status        = status_val,
            action_label  = action_label,
            action_value  = action_value,
        ))

    # Prepend an overall OmniRoute gateway record
    gateway_pct = 100.0 if reachable else 0.0
    records.insert(0, QuotaRecord(
        provider      = "OmniRoute",
        model         = "gateway",
        remaining_pct = gateway_pct,
        tokens_left   = "reachable" if reachable else "unreachable",
        resets_in     = _seconds_to_human(reset_secs) if reachable else "—",
        status        = "healthy" if reachable else "exhausted",
        action_label  = "Open OmniRoute",
        action_value  = OMNIROUTE_BASE,
    ))

    _OMNIROUTE_CACHE    = records  # type: ignore[assignment]
    _OMNIROUTE_CACHE_TS = now
    return records

# ── Cursor ────────────────────────────────────────────────────────────────────

def _fetch_cursor() -> QuotaRecord:
    """Cursor has no public quota API. Return an informational mock."""
    return QuotaRecord(
        provider      = "Cursor",
        model         = "local CLI / agent",
        remaining_pct = 100.0,
        tokens_left   = "—",
        resets_in     = _next_midnight_utc(),
        status        = "healthy",
        action_label  = "Open Cursor",
        action_value  = "cursor .",
    )

# ── Public API ────────────────────────────────────────────────────────────────

def get_all_quotas() -> list[dict]:
    """
    Gather quota records for all providers and return them as plain dicts
    suitable for JSON serialisation.
    """
    records: list[QuotaRecord] = []

    records.append(_fetch_anthropic())
    records.extend(_fetch_openai())
    records.extend(_fetch_omniroute())
    records.append(_fetch_cursor())

    return [
        {
            "provider":      r.provider,
            "model":         r.model,
            "remaining_pct": r.remaining_pct,
            "tokens_left":   r.tokens_left,
            "resets_in":     r.resets_in,
            "status":        r.status,
            "action_label":  r.action_label,
            "action_value":  r.action_value,
        }
        for r in records
    ]
