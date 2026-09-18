"""
sentinel/server.py

FastAPI application for Sentinel-AI.
Exposes:
  - WebSocket  /ws/telemetry           — live 1 s telemetry stream
  - GET        /api/history?window=…   — historical data for 1m / 5m / 1h windows
  - GET        /api/spikes             — top-5 spike events in the last 24 hours
"""

import asyncio
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from sentinel.database import get_history_window, get_spikes, init_db, insert_telemetry
from sentinel.harvester import (
    compute_thrash_danger_index,
    get_gpu_wired_limit,
    get_pageout_count,
    get_swap_usage,
    get_wired_memory_mb,
)

app = FastAPI(title="Sentinel-AI")

# Allow the Next.js dev server (port 3000) and production builds to call the API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _collect_reading() -> dict:
    """Gather one telemetry snapshot and return it as a plain dict."""
    limit_mb = get_gpu_wired_limit()
    wired_mb = get_wired_memory_mb()
    total_swap, used_swap = get_swap_usage()
    pageouts = get_pageout_count()
    thrash_index = compute_thrash_danger_index(wired_mb, limit_mb, used_swap)
    ts = time.time()
    return {
        "timestamp":    ts,
        "wired_mb":     wired_mb,
        "limit_mb":     limit_mb,
        "swap_total_mb": total_swap,
        "swap_used_mb": used_swap,
        "pageouts":     pageouts,
        "thrash_index": thrash_index,
    }

# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def _startup() -> None:
    """Ensure the database is initialised before the first connection arrives."""
    init_db()

# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket) -> None:
    """Stream live telemetry to the connected client at 1-second intervals."""
    await websocket.accept()
    try:
        while True:
            reading = await asyncio.get_event_loop().run_in_executor(
                None, _collect_reading
            )

            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda r=reading: insert_telemetry(
                    timestamp=r["timestamp"],
                    wired_mb=r["wired_mb"],
                    swap_used_mb=r["swap_used_mb"],
                    pageouts=r["pageouts"],
                    thrash_index=r["thrash_index"],
                ),
            )

            await websocket.send_json(reading)
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass

# ── REST: history ─────────────────────────────────────────────────────────────

@app.get("/api/history")
async def api_history(
    window: Literal["1m", "5m", "1h"] = Query(
        default="1m",
        description="Time window: '1m' (60 s raw), '5m' (300 s sampled), '1h' (3600 s bucketed).",
    )
) -> list[dict]:
    """Return historical telemetry for the requested time window.

    Results are oldest-first so the frontend can render them directly.
    """
    try:
        rows = await asyncio.get_event_loop().run_in_executor(
            None, lambda: get_history_window(window)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return rows

# ── REST: spikes ──────────────────────────────────────────────────────────────

@app.get("/api/spikes")
async def api_spikes() -> list[dict]:
    """Return the top-5 spike events (thrash_index >= 0.4 or swap > 0) in the last 24 h.

    Each item contains: timestamp, thrash_index, wired_mb, swap_used_mb, pageouts.
    Ordered by thrash_index descending.
    """
    rows = await asyncio.get_event_loop().run_in_executor(None, get_spikes)
    return rows
