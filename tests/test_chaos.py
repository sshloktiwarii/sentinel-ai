import pytest
from unittest.mock import patch
from sentinel.harvester import (
    get_gpu_wired_limit,
    get_swap_usage,
    get_pageout_count,
    compute_thrash_danger_index,
)

def test_gpu_wired_limit_fallback():
    with patch("subprocess.check_output", side_effect=Exception("Permission denied")):
        val = get_gpu_wired_limit()
        assert val == 16384

def test_swap_usage_malformed_string():
    with patch("subprocess.check_output", return_value=b"corrupted system string\n"):
        total, used = get_swap_usage()
        assert total == 0.0
        assert used == 0.0

def test_pageout_count_missing_key():
    with patch("subprocess.check_output", return_value=b"Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1200.\n"):
        assert get_pageout_count() == 0

def test_thrash_danger_index_bounds():
    assert compute_thrash_danger_index(18000, 16000, 500.0) == 1.0
    assert compute_thrash_danger_index(1000, 16000, 0.0) < 0.2
    assert 0.0 <= compute_thrash_danger_index(0, 0, -10.0) <= 1.0
