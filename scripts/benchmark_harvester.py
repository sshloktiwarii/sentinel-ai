#!/usr/bin/env python3
"""
scripts/benchmark_harvester.py

Benchmark comparing Pure Darwin C-Bindings (ctypes) vs. Legacy Subprocess
for Apple Silicon hardware telemetry in Sentinel-AI.
"""

from __future__ import annotations

import statistics
import time
from sentinel.harvester import (
    compute_thrash_danger_index,
    get_gpu_wired_limit,
    get_pageout_count,
    get_swap_usage,
    get_wired_memory_mb,
    _fallback_get_gpu_wired_limit_subprocess,
    _fallback_get_pageout_count_subprocess,
    _fallback_get_swap_usage_subprocess,
    _fallback_get_wired_memory_mb_subprocess,
)


def run_benchmark():
    print("=" * 72)
    print("  SENTINEL-AI TELEMETRY HARVESTER BENCHMARK")
    print("  Pure Darwin C-Bindings (ctypes) vs. Subprocess (sysctl + vm_stat)")
    print("=" * 72)

    # Warm-up
    for _ in range(20):
        get_wired_memory_mb()
        get_gpu_wired_limit()
        get_swap_usage()
        get_pageout_count()

    ctypes_cycles = 1000
    subprocess_cycles = 50

    print(f"\n[1] Benchmarking Pure Darwin C-Bindings ({ctypes_cycles:,} iterations)...")
    ctypes_times = []
    for _ in range(ctypes_cycles):
        t0 = time.perf_counter_ns()
        w = get_wired_memory_mb()
        l = get_gpu_wired_limit()
        s = get_swap_usage()
        p = get_pageout_count()
        tdi = compute_thrash_danger_index(w, l, s)
        t1 = time.perf_counter_ns()
        ctypes_times.append((t1 - t0) / 1_000_000.0)  # ms

    print(f"[2] Benchmarking Legacy Subprocess Spawns ({subprocess_cycles:,} iterations)...")
    subp_times = []
    for _ in range(subprocess_cycles):
        t0 = time.perf_counter_ns()
        w = _fallback_get_wired_memory_mb_subprocess()
        l = _fallback_get_gpu_wired_limit_subprocess()
        s = _fallback_get_swap_usage_subprocess()
        p = _fallback_get_pageout_count_subprocess()
        tdi = compute_thrash_danger_index(w, l, s)
        t1 = time.perf_counter_ns()
        subp_times.append((t1 - t0) / 1_000_000.0)  # ms

    # Metrics
    ctypes_mean = statistics.mean(ctypes_times)
    ctypes_median = statistics.median(ctypes_times)
    ctypes_p99 = sorted(ctypes_times)[int(0.99 * len(ctypes_times))]
    ctypes_min = min(ctypes_times)
    ctypes_max = max(ctypes_times)

    subp_mean = statistics.mean(subp_times)
    subp_median = statistics.median(subp_times)
    subp_p99 = sorted(subp_times)[int(0.99 * len(subp_times))]
    subp_min = min(subp_times)
    subp_max = max(subp_times)

    speedup = subp_mean / ctypes_mean

    print("\n" + "-" * 72)
    print(f"{'Metric':<25} | {'Subprocess (Legacy)':<20} | {'ctypes (Darwin)':<20}")
    print("-" * 72)
    print(f"{'Mean Latency':<25} | {subp_mean:>16.4f} ms | {ctypes_mean:>16.4f} ms")
    print(f"{'Median Latency':<25} | {subp_median:>16.4f} ms | {ctypes_median:>16.4f} ms")
    print(f"{'Min Latency':<25} | {subp_min:>16.4f} ms | {ctypes_min:>16.4f} ms")
    print(f"{'P99 Latency':<25} | {subp_p99:>16.4f} ms | {ctypes_p99:>16.4f} ms")
    print(f"{'Max Latency':<25} | {subp_max:>16.4f} ms | {ctypes_max:>16.4f} ms")
    print("-" * 72)
    print(f"Speedup Factor: {speedup:,.1f}x faster")
    print(f"Target SLA (<0.2000 ms): {'PASSED' if ctypes_mean < 0.2 else 'FAILED'} (Actual: {ctypes_mean:.4f} ms)")
    print("-" * 72)

    # Component-level breakdown for ctypes
    print("\n[3] Component Breakdown (ctypes, 1,000 iterations):")
    comps = {
        "get_wired_memory_mb()": get_wired_memory_mb,
        "get_gpu_wired_limit()": get_gpu_wired_limit,
        "get_swap_usage()": get_swap_usage,
        "get_pageout_count()": get_pageout_count,
    }
    for name, fn in comps.items():
        times = []
        for _ in range(1000):
            t0 = time.perf_counter_ns()
            fn()
            t1 = time.perf_counter_ns()
            times.append((t1 - t0) / 1_000_000.0)
        print(f"  - {name:<26}: mean = {statistics.mean(times):.5f} ms, p99 = {sorted(times)[990]:.5f} ms")

    print("=" * 72)


if __name__ == "__main__":
    run_benchmark()
