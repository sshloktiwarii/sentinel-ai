import re
import subprocess

def get_gpu_wired_limit() -> int:
    """Execute `sysctl -n iogpu.wired_limit_mb` and return integer MB.

    Falls back to 16384 on any error or unparseable output.
    """
    try:
        output = subprocess.check_output(
            ["sysctl", "-n", "iogpu.wired_limit_mb"],
            text=True,
        )
        return int(output.strip())
    except Exception:
        return 16384

def get_swap_usage() -> tuple[float, float]:
    """Execute `sysctl -n vm.swapusage` and parse total/used MB as floats.

    Returns (total_mb, used_mb). Falls back to (0.0, 0.0) on any error.
    """
    try:
        result = subprocess.run(
            ["sysctl", "-n", "vm.swapusage"],
            capture_output=True,
            text=True,
        )
        output = result.stdout
        total_match = re.search(r"total\s*=\s*([\d.]+)M", output)
        used_match = re.search(r"used\s*=\s*([\d.]+)M", output)
        if not total_match or not used_match:
            return 0.0, 0.0
        return float(total_match.group(1)), float(used_match.group(1))
    except Exception:
        return 0.0, 0.0

def get_pageout_count() -> int:
    """Execute `vm_stat` and extract the cumulative 'Pageouts' count.

    Returns 0 on any error or if the line is absent.
    """
    try:
        result = subprocess.run(
            ["vm_stat"],
            capture_output=True,
            text=True,
        )
        for line in result.stdout.splitlines():
            if re.match(r"\s*Pageouts:", line, re.IGNORECASE):
                match = re.search(r"([\d]+)", line)
                if match:
                    return int(match.group(1))
        return 0
    except Exception:
        return 0

def compute_thrash_danger_index(
    wired_mb: int, limit_mb: int, swap_used_mb: float
) -> float:
    """Compute a 0.0–1.0 memory pressure index.

    Returns 1.0 immediately when:
      - wired_mb >= limit_mb  (including limit_mb == 0)
      - swap_used_mb > 2048 MB

    Otherwise blends the wired ratio and swap ratio and clamps to [0.0, 1.0].
    """
    # Hard-ceiling conditions
    if limit_mb == 0 or wired_mb >= limit_mb:
        return 1.0
    if swap_used_mb > 2048.0:
        return 1.0

    wired_ratio = wired_mb / limit_mb
    swap_ratio = swap_used_mb / 2048.0

    index = (wired_ratio + swap_ratio) / 2.0
    return min(max(index, 0.0), 1.0)
