"""
sentinel/server.py

FastAPI application for Sentinel-AI.
Exposes a WebSocket endpoint at /ws/telemetry that:
  - Collects a fresh reading from sentinel.harvester every second
  - Persists each reading to sentinel.database
  - Broadcasts the reading as a JSON payload to every connected client
"""

import asyncio
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from sentinel.database import init_db, insert_telemetry
from sentinel.harvester import (
    compute_thrash_danger_index,
    get_gpu_wired_limit,
    get_pageout_count,
    get_swap_usage,
    get_wired_memory_mb,
)

app = FastAPI(title="Sentinel-AI")

def _collect_reading() -> dict:
    """Gather one telemetry snapshot and return it as a plain dict."""
    limit_mb = get_gpu_wired_limit()
    wired_mb = get_wired_memory_mb()          # active wired footprint, not the ceiling
    total_swap, used_swap = get_swap_usage()  # used_swap is a plain float
    pageouts = get_pageout_count()
    thrash_index = compute_thrash_danger_index(wired_mb, limit_mb, used_swap)
    ts = time.time()
    return {
        "timestamp": ts,
        "wired_mb": wired_mb,
        "limit_mb": limit_mb,
        "swap_total_mb": total_swap,
        "swap_used_mb": used_swap,
        "pageouts": pageouts,
        "thrash_index": thrash_index,
    }

@app.on_event("startup")
async def _startup() -> None:
    """Ensure the database is initialised before the first connection arrives."""
    init_db()

@app.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket) -> None:
    """Stream live telemetry to the connected client at 1-second intervals."""
    await websocket.accept()
    try:
        while True:
            reading = await asyncio.get_event_loop().run_in_executor(
                None, _collect_reading
            )

            # Persist to database (non-blocking via executor)
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
