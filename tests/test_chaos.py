import pytest
from unittest.mock import patch
from sentinel.harvester import (
    get_gpu_wired_limit,
    get_swap_usage,
    get_pageout_count,
    get_wired_memory_mb,
    compute_thrash_danger_index,
)

# ---------------------------------------------------------------------------
# get_gpu_wired_limit
# ---------------------------------------------------------------------------

def test_gpu_wired_limit_fallback():
    """Both sysctl calls fail — must fall back to 18432."""
    with patch("subprocess.check_output", side_effect=Exception("Permission denied")):
        val = get_gpu_wired_limit()
        assert val == 18432

def test_gpu_wired_limit_uses_hw_memsize_when_iogpu_is_zero():
    """iogpu returns 0, so limit should be derived from hw.memsize."""
    def _fake_check_output(cmd, **kwargs):
        if "iogpu.wired_limit_mb" in cmd:
            return "0\n"
        if "hw.memsize" in cmd:
            return f"{24 * 1024 * 1024 * 1024}\n"  # 24 GB
        raise Exception("unexpected call")

    with patch("subprocess.check_output", side_effect=_fake_check_output):
        val = get_gpu_wired_limit()
        expected = int(24 * 1024 * 1024 * 1024 * 0.75 / (1024 * 1024))
        assert val == expected

def test_gpu_wired_limit_primary_path():
    """iogpu returns a valid positive value — use it directly."""
    with patch("subprocess.check_output", return_value="16384\n"):
        val = get_gpu_wired_limit()
        assert val == 16384

# ---------------------------------------------------------------------------
# get_swap_usage
# ---------------------------------------------------------------------------

def test_swap_usage_malformed_string():
    with patch("subprocess.check_output", return_value=b"corrupted system string\n"):
        total, used = get_swap_usage()
        assert total == 0.0
        assert used == 0.0

# ---------------------------------------------------------------------------
# get_pageout_count
# ---------------------------------------------------------------------------

def test_pageout_count_missing_key():
    vm_stat_output = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free: 1200.\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value.stdout = vm_stat_output
        assert get_pageout_count() == 0

# ---------------------------------------------------------------------------
# get_wired_memory_mb
# ---------------------------------------------------------------------------

def test_get_wired_memory_mb_normal():
    """Parse wired pages and page size from realistic vm_stat output."""
    vm_stat_output = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free:                               12345.\n"
        "Pages wired down:                          1000.\n"
        "Pageouts:                                     0.\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value.stdout = vm_stat_output
        result = get_wired_memory_mb()
        expected = (1000 * 16384) / (1024 * 1024)
        assert result == pytest.approx(expected)

def test_get_wired_memory_mb_default_page_size():
    """When page size is missing from header, default 16384 is used."""
    vm_stat_output = (
        "Mach Virtual Memory Statistics:\n"
        "Pages wired down:                           500.\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value.stdout = vm_stat_output
        result = get_wired_memory_mb()
        expected = (500 * 16384) / (1024 * 1024)
        assert result == pytest.approx(expected)

def test_get_wired_memory_mb_missing_line():
    """Returns 0.0 when 'Pages wired down' line is absent."""
    vm_stat_output = (
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
        "Pages free: 1200.\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value.stdout = vm_stat_output
        assert get_wired_memory_mb() == 0.0

def test_get_wired_memory_mb_exception():
    """Returns 0.0 on subprocess error."""
    with patch("subprocess.run", side_effect=Exception("oops")):
        assert get_wired_memory_mb() == 0.0

# ---------------------------------------------------------------------------
# compute_thrash_danger_index
# ---------------------------------------------------------------------------

def test_thrash_danger_index_bounds():
    # wired >= limit -> 1.0
    assert compute_thrash_danger_index(18000, 16000, 500.0) == 1.0
    # low wired, no swap -> well below 0.2
    assert compute_thrash_danger_index(1000, 16000, 0.0) < 0.2
    # limit == 0 treated as 18432; swap negative clamped to 0 -> score is 0.0
    assert 0.0 <= compute_thrash_danger_index(0, 0, -10.0) <= 1.0

def test_thrash_danger_index_weighted_blend():
    """Verify the 0.7/0.3 weighted formula at a known midpoint."""
    # wired=9216 (50% of 18432), swap=3072 (50% of 6144)
    # score = 0.7 * 0.5 + 0.3 * 0.5 = 0.5
    result = compute_thrash_danger_index(9216.0, 18432.0, 3072.0)
    assert result == pytest.approx(0.5, abs=1e-4)

def test_thrash_danger_index_cold_swap_no_premature_panic():
    """Cold swap (even >= 2048 MB) does not force 1.0; 70/30 weighting applies."""
    # wired=100.0, limit=18432.0, swap=2048.0 (swap_ratio = 2048/6144 = 1/3)
    # expected = 0.7 * (100.0 / 18432.0) + 0.3 * (2048.0 / 6144.0) ≈ 0.1038
    result = compute_thrash_danger_index(100.0, 18432.0, 2048.0)
    expected = (0.7 * (100.0 / 18432.0)) + (0.3 * (2048.0 / 6144.0))
    assert result == pytest.approx(expected, abs=1e-4)
    assert result < 0.2

    # Even with 3000 MB swap, score is weighted and well below emergency 1.0
    result_3000 = compute_thrash_danger_index(100.0, 18432.0, 3000.0)
    expected_3000 = (0.7 * (100.0 / 18432.0)) + (0.3 * (3000.0 / 6144.0))
    assert result_3000 == pytest.approx(expected_3000, abs=1e-4)
    assert result_3000 < 0.25

def test_thrash_danger_index_swap_ratio_capped_at_one():
    """Swap ratio is capped at 1.0 for swap >= swap_limit_mb (6144 MB)."""
    assert compute_thrash_danger_index(0.0, 18432.0, 6144.0) == 0.3
    assert compute_thrash_danger_index(0.0, 18432.0, 10000.0) == 0.3

def test_thrash_danger_index_saturation_forces_emergency_one():
    """Only physical memory saturation (mem_ratio >= 1.0) forces 1.0 immediately."""
    assert compute_thrash_danger_index(18432.0, 18432.0, 0.0) == 1.0
    assert compute_thrash_danger_index(20000.0, 18432.0, 500.0) == 1.0

def test_thrash_danger_index_custom_swap_limit():
    """Verify custom swap_limit_mb scaling."""
    result = compute_thrash_danger_index(9216.0, 18432.0, 1024.0, swap_limit_mb=2048.0)
    assert result == pytest.approx(0.5, abs=1e-4)

def test_thrash_danger_index_negative_limit_uses_default():
    """Negative limit_mb falls back to 18432."""
    result = compute_thrash_danger_index(9216.0, -1.0, 0.0)
    expected = round(0.7 * (9216.0 / 18432.0), 4)
    assert result == pytest.approx(expected, abs=1e-4)
