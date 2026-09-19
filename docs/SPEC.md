# Sentinel-AI Spec Contract

## 1. Module: `sentinel/harvester.py`
Functions required:
- `get_gpu_wired_limit() -> int`:
  Executes `sysctl -n iogpu.wired_limit_mb`. Returns integer MB (fallback default: 16384).
- `get_swap_usage() -> tuple[float, float]`:
  Executes `sysctl -n vm.swapusage`. Parses total/used MB as floats.
- `get_pageout_count() -> int`:
  Executes `vm_stat`. Extracts cumulative 'pageouts' count.
- `compute_thrash_danger_index(wired_mb: int, limit_mb: int, swap_used_mb: float) -> float`:
  Computes a 0.0 to 1.0 pressure index. Returns 1.0 if wired >= limit or swap > 2048 MB.

## 2. Module: `sentinel/database.py`
- SQLite database (`sentinel.db`) operating strictly in WAL mode (`PRAGMA journal_mode=WAL;`).
- Schema: `telemetry` table (id, timestamp, wired_mb, swap_used_mb, pageouts, thrash_index).

## 3. Module: `sentinel/server.py`
- FastAPI app with WebSocket endpoint `/ws/telemetry` streaming live readings every 1s.
