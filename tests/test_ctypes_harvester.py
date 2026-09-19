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
    get_total_physical_memory_mb,
    get_dynamic_swap_limit_mb,
    is_apple_silicon,
    check_architecture_guardrail,
    __all__,
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

    def test_get_gpu_wired_limit_returns_number(self):
        limit = get_gpu_wired_limit()
        assert isinstance(limit, (int, float))
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
        assert isinstance(limit, (int, float))
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
        assert isinstance(limit, (int, float))
        assert limit > 0


class TestDynamicArchitectureAndLimits:
    """Tests for dynamic RAM queries, scaling limits, Apple Silicon detection, and architecture guardrails."""

    def test_all_helpers_exported(self):
        import sentinel.harvester as h
        expected_helpers = [
            "get_total_physical_memory_mb",
            "get_dynamic_swap_limit_mb",
            "is_apple_silicon",
            "get_gpu_wired_limit",
            "get_swap_usage",
            "get_pageout_count",
            "get_wired_memory_mb",
            "compute_thrash_danger_index",
            "check_architecture_guardrail",
            "get_engine_pressure_snapshot",
            "XswUsage",
            "VMStatistics64",
            "HOST_VM_INFO64",
        ]
        for helper in expected_helpers:
            assert helper in h.__all__, f"{helper} must be in __all__"
            assert hasattr(h, helper), f"Module must have attribute {helper}"

    def test_get_total_physical_memory_mb(self):
        import sentinel.harvester as h
        h.get_total_physical_memory_mb.cache_clear()
        mem = h.get_total_physical_memory_mb()
        assert isinstance(mem, float)
        assert mem > 0.0

        # Verify LRU cache functionality
        info_before = h.get_total_physical_memory_mb.cache_info()
        h.get_total_physical_memory_mb()
        info_after = h.get_total_physical_memory_mb.cache_info()
        assert info_after.hits > info_before.hits

    def test_get_total_physical_memory_mb_fallback_when_sysctl_fails(self, monkeypatch):
        import sentinel.harvester as h
        h.get_total_physical_memory_mb.cache_clear()

        class DummyLibC:
            def sysctlbyname(self, *args):
                return -1

        monkeypatch.setattr(h, "_libc", DummyLibC())
        # Fallback to 8192.0 MB
        assert h.get_total_physical_memory_mb() == 8192.0

    @pytest.mark.parametrize(
        "ram_gb,ram_mb,expected_gpu_limit,expected_swap_limit",
        [
            (8, 8192.0, 6144.0, 2048.0),
            (16, 16384.0, 12288.0, 4096.0),
            (24, 24576.0, 18432.0, 6144.0),
            (64, 65536.0, 49152.0, 16384.0),
        ],
    )
    def test_dynamic_memory_scaling_mock_values(
        self, monkeypatch, ram_gb, ram_mb, expected_gpu_limit, expected_swap_limit
    ):
        import sentinel.harvester as h

        h.get_total_physical_memory_mb.cache_clear()
        h.get_dynamic_swap_limit_mb.cache_clear()
        monkeypatch.setattr(h, "get_total_physical_memory_mb", lambda: ram_mb)

        # 1. Verify dynamic swap limit calculation
        swap_lim = h.get_dynamic_swap_limit_mb()
        assert swap_lim == expected_swap_limit

        # 2. Verify dynamic GPU limit calculation when iogpu fails or returns 0
        class DummyLibC:
            def sysctlbyname(self, name, *args):
                return -1  # force iogpu sysctl failure
            def mach_host_self(self):
                return 1
            def host_statistics64(self, *args):
                return -1

        monkeypatch.setattr(h, "_libc", DummyLibC())
        gpu_lim = h.get_gpu_wired_limit()
        assert gpu_lim == expected_gpu_limit

    def test_is_apple_silicon_detection(self):
        import sentinel.harvester as h
        result = h.is_apple_silicon()
        assert isinstance(result, bool)

        # Verify cached
        info_before = h.is_apple_silicon.cache_info()
        h.is_apple_silicon()
        info_after = h.is_apple_silicon.cache_info()
        assert info_after.hits > info_before.hits

    def test_non_apple_silicon_guardrail_logs_notice_once(self, monkeypatch, caplog):
        import sentinel.harvester as h
        import logging

        monkeypatch.setattr(h, "is_apple_silicon", lambda: False)
        monkeypatch.setattr(h, "_non_arm64_notice_logged", False)

        with caplog.at_level(logging.WARNING, logger="sentinel.harvester"):
            res1 = h.check_architecture_guardrail()
            assert res1 is False
            assert "Non-Apple Silicon Mac detected. Unified VRAM tracking is disabled; swap and pageout telemetry remain active." in caplog.text

            warning_count = len([rec for rec in caplog.records if rec.levelno == logging.WARNING])
            assert warning_count == 1

            # Second call must not duplicate the log
            res2 = h.check_architecture_guardrail()
            assert res2 is False
            warning_count_second = len([rec for rec in caplog.records if rec.levelno == logging.WARNING])
            assert warning_count_second == 1

    def test_non_apple_silicon_allows_swap_and_pageouts(self, monkeypatch):
        import sentinel.harvester as h
        monkeypatch.setattr(h, "is_apple_silicon", lambda: False)
        monkeypatch.setattr(h, "_non_arm64_notice_logged", True)

        total, used = h.get_swap_usage()
        assert isinstance(total, float)
        assert isinstance(used, float)
        pageouts = h.get_pageout_count()
        assert isinstance(pageouts, int)

    def test_compute_thrash_danger_index_dynamic_resolution(self, monkeypatch):
        import sentinel.harvester as h
        monkeypatch.setattr(h, "get_total_physical_memory_mb", lambda: 24576.0)
        monkeypatch.setattr(h, "get_dynamic_swap_limit_mb", lambda: 6144.0)

        # When limit_mb <= 0, resolves dynamically to get_total_physical_memory_mb() * 0.75 = 18432.0
        # When swap_limit_mb is None or <= 0, resolves to get_dynamic_swap_limit_mb() = 6144.0
        # wired=9216 (50% of 18432), swap=3072 (50% of 6144) -> 0.7*0.5 + 0.3*0.5 = 0.5
        score_auto = h.compute_thrash_danger_index(9216.0, 0.0, 3072.0, swap_limit_mb=None)
        assert score_auto == pytest.approx(0.5, abs=1e-4)

        score_neg = h.compute_thrash_danger_index(9216.0, -100.0, 3072.0, swap_limit_mb=-50.0)
        assert score_neg == pytest.approx(0.5, abs=1e-4)

        # Saturation triggers 1.0 immediately
        assert h.compute_thrash_danger_index(18432.0, 0.0, 0.0) == 1.0
        assert h.compute_thrash_danger_index(20000.0, 18432.0, 0.0) == 1.0

        # Custom swap_limit_mb overrides dynamic swap limit
        score_custom = h.compute_thrash_danger_index(9216.0, 18432.0, 3072.0, swap_limit_mb=3072.0)
        # swap_ratio = 3072/3072 = 1.0 -> 0.7*0.5 + 0.3*1.0 = 0.65
        assert score_custom == pytest.approx(0.65, abs=1e-4)


