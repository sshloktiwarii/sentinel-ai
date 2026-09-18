"""
tests/test_ctypes_harvester.py

Unit and regression tests verifying pure Darwin C-bindings via ctypes in sentinel/harvester.py:
- Darwin library loading and function binding
- Structure definitions: XswUsage and VMStatistics64
- Hardware telemetry data integrity and range validation
- Execution latency SLA (< 0.2ms per call)
- Signature and return type fidelity
"""

import ctypes
import time
import pytest
from sentinel.harvester import (
    XswUsage,
    VMStatistics64,
    HOST_VM_INFO64,
    _libc,
    _get_page_size,
    get_wired_memory_mb,
    get_gpu_wired_limit,
    get_swap_usage,
    get_pageout_count,
    compute_thrash_danger_index,
)


class TestDarwinCBindings:
    """Test Darwin C-library symbols and prototypes."""

    def test_libc_loaded(self):
        assert _libc is not None, "libSystem must be successfully loaded on Darwin"

    def test_mach_host_self_binding(self):
        assert hasattr(_libc, "mach_host_self")
        host = _libc.mach_host_self()
        assert isinstance(host, int)
        assert host > 0

    def test_host_page_size_binding(self):
        assert hasattr(_libc, "host_page_size")
        host = _libc.mach_host_self()
        ps = ctypes.c_size_t(0)
        ret = _libc.host_page_size(host, ctypes.byref(ps))
        assert ret == 0
        assert ps.value in (4096, 16384)  # 16KB on Apple Silicon, 4KB on Intel

    def test_get_page_size_helper(self):
        ps = _get_page_size()
        assert ps in (4096, 16384)

    def test_host_statistics64_flavor_4(self):
        assert hasattr(_libc, "host_statistics64")
        host = _libc.mach_host_self()
        vm_stat = VMStatistics64()
        count = ctypes.c_uint32(ctypes.sizeof(VMStatistics64) // ctypes.sizeof(ctypes.c_int32))
        ret = _libc.host_statistics64(
            host,
            HOST_VM_INFO64,
            ctypes.byref(vm_stat),
            ctypes.byref(count),
        )
        assert ret == 0
        assert vm_stat.wire_count > 0

    def test_sysctlbyname_swapusage(self):
        assert hasattr(_libc, "sysctlbyname")
        usage = XswUsage()
        size = ctypes.c_size_t(ctypes.sizeof(XswUsage))
        ret = _libc.sysctlbyname(
            b"vm.swapusage",
            ctypes.byref(usage),
            ctypes.byref(size),
            None,
            0,
        )
        assert ret == 0
        # Swap total is either 0 (if disabled) or multiple of page size
        assert usage.xsu_total >= usage.xsu_used


class TestStructureLayouts:
    """Verify ctypes structure sizes and offsets align with Darwin headers."""

    def test_xsw_usage_layout(self):
        # struct xsw_usage: uint64 total, uint64 avail, uint64 used, uint32 pagesize, uint32 encrypted = 32 bytes
        assert ctypes.sizeof(XswUsage) == 32
        assert XswUsage.xsu_total.offset == 0
        assert XswUsage.xsu_avail.offset == 8
        assert XswUsage.xsu_used.offset == 16
        assert XswUsage.xsu_pagesize.offset == 24
        assert XswUsage.xsu_encrypted.offset == 28

    def test_vm_statistics64_fields(self):
        # VMStatistics64 count must be 38 32-bit words (152 bytes)
        assert ctypes.sizeof(VMStatistics64) == 152
        assert hasattr(VMStatistics64, "wire_count")
        assert hasattr(VMStatistics64, "pageouts")


class TestHarvesterFunctions:
    """Verify identical return types, ranges, and signatures without mocking."""

    def test_get_wired_memory_mb_returns_float(self):
        val = get_wired_memory_mb()
        assert isinstance(val, float)
        assert val > 0.0

    def test_get_gpu_wired_limit_returns_int(self):
        limit = get_gpu_wired_limit()
        assert isinstance(limit, int)
        assert limit > 0

    def test_get_swap_usage_returns_tuple_of_floats(self):
        res = get_swap_usage()
        assert isinstance(res, tuple)
        assert len(res) == 2
        total, used = res
        assert isinstance(total, float)
        assert isinstance(used, float)
        assert total >= 0.0
        assert used >= 0.0
        assert total >= used

    def test_get_pageout_count_returns_int(self):
        count = get_pageout_count()
        assert isinstance(count, int)
        assert count >= 0

    def test_compute_thrash_danger_index_returns_clamped_float(self):
        wired = get_wired_memory_mb()
        limit = get_gpu_wired_limit()
        swap = get_swap_usage()
        tdi = compute_thrash_danger_index(wired, limit, swap)
        assert isinstance(tdi, float)
        assert 0.0 <= tdi <= 1.0

    def test_compute_thrash_danger_index_calibrated_swap_no_hard_ceiling(self):
        # Cold swap >= 2048 alone should not force 1.0 without memory saturation
        score_2048 = compute_thrash_danger_index(100.0, 18432.0, 2048.0)
        assert score_2048 < 0.2
        # Only physical memory saturation forces 1.0
        assert compute_thrash_danger_index(18432.0, 18432.0, 0.0) == 1.0


class TestPerformanceLatencySLA:
    """Ensure the harvest cycle executes in < 0.2ms per call."""

    def test_harvest_cycle_latency_under_threshold(self):
        # Warm-up
        for _ in range(10):
            get_wired_memory_mb()
            get_gpu_wired_limit()
            get_swap_usage()
            get_pageout_count()

        iterations = 500
        t0 = time.perf_counter()
        for _ in range(iterations):
            w = get_wired_memory_mb()
            l = get_gpu_wired_limit()
            s = get_swap_usage()
            p = get_pageout_count()
            compute_thrash_danger_index(w, l, s)
        elapsed_total_s = time.perf_counter() - t0
        avg_ms_per_cycle = (elapsed_total_s / iterations) * 1000.0

        # Hard requirement: < 0.2ms per cycle
        assert avg_ms_per_cycle < 0.2, f"Expected harvest cycle < 0.2ms, got {avg_ms_per_cycle:.4f}ms"


class TestDefensiveFallbacks:
    """Test behavior when Darwin C-bindings are unavailable or sysctl calls fail."""

    def test_fallback_when_libc_is_none(self, monkeypatch):
        import sentinel.harvester as h
        monkeypatch.setattr(h, "_libc", None)

        limit = h.get_gpu_wired_limit()
        assert isinstance(limit, int)
        assert limit > 0

        swap = h.get_swap_usage()
        assert isinstance(swap, tuple)
        assert len(swap) == 2

        pageouts = h.get_pageout_count()
        assert isinstance(pageouts, int)

        wired = h.get_wired_memory_mb()
        assert isinstance(wired, float)

    def test_fallback_when_sysctl_returns_error(self, monkeypatch):
        import sentinel.harvester as h

        class DummyLibC:
            def sysctlbyname(self, *args):
                return -1  # Simulate error
            def mach_host_self(self):
                return 1
            def host_statistics64(self, *args):
                return -1  # Simulate error

        monkeypatch.setattr(h, "_libc", DummyLibC())

        # Should fall back cleanly without raising
        limit = h.get_gpu_wired_limit()
        assert isinstance(limit, int)
        assert limit > 0

