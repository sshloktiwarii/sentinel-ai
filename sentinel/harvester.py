import re
import subprocess

def get_gpu_wired_limit() -> int:
    """Return the GPU wired memory limit in MB.

    Resolution order:
    1. `sysctl -n iogpu.wired_limit_mb` — used if the value is > 0.
    2. `sysctl -n hw.memsize`           — limit_mb = int(hw_memsize * 0.75 / 1024^2).
    3. Hard fallback of 18432 MB.
    """
    # --- primary: iogpu.wired_limit_mb ---
    try:
        output = subprocess.check_output(
            ["sysctl", "-n", "iogpu.wired_limit_mb"],
            text=True,
        )
        value = int(output.strip())
        if value > 0:
            return value
    except Exception:
        pass

    # --- secondary: derive from hw.memsize ---
    try:
        output = subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"],
            text=True,
        )
        hw_memsize = int(output.strip())
        limit_mb = int(hw_memsize * 0.75 / (1024 * 1024))
        if limit_mb > 0:
            return limit_mb
    except Exception:
        pass

    # --- final fallback ---
    return 18432

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

def get_wired_memory_mb() -> float:
    """Execute `vm_stat` and return current wired memory in MB.

    Extracts the page size from the header line (defaults to 16384 bytes on
    Apple Silicon) and multiplies by the 'Pages wired down' count.
    Returns 0.0 on any error or if the line is absent.
    """
    DEFAULT_PAGE_SIZE = 16384
    try:
        result = subprocess.run(
            ["vm_stat"],
            capture_output=True,
            text=True,
        )
        output = result.stdout
        lines = output.splitlines()

        # Parse page size from header, e.g.:
        # "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
        page_size = DEFAULT_PAGE_SIZE
        if lines:
            header_match = re.search(r"page size of (\d+) bytes", lines[0])
            if header_match:
                page_size = int(header_match.group(1))

        for line in lines:
            if re.match(r"\s*Pages wired down:", line, re.IGNORECASE):
                match = re.search(r"(\d+)", line)
                if match:
                    count = int(match.group(1))
                    return (count * page_size) / (1024 * 1024)
        return 0.0
    except Exception:
        return 0.0

def compute_thrash_danger_index(
    wired_mb: float, limit_mb: float, swap_used_mb: float
) -> float:
    """Compute a 0.0–1.0 memory pressure index.

    - If limit_mb <= 0, it is treated as 18432.0.
    - Returns 1.0 immediately when wired_mb >= limit_mb or swap_used_mb >= 2048.0.
    - Otherwise: score = (0.7 * mem_ratio) + (0.3 * swap_ratio), clamped to [0.0, 1.0],
      rounded to 4 decimal places.
    """
    if limit_mb <= 0:
        limit_mb = 18432.0

    mem_ratio = wired_mb / limit_mb
    swap_ratio = min(1.0, swap_used_mb / 2048.0)

    if mem_ratio >= 1.0 or swap_used_mb >= 2048.0:
        return 1.0

    score = (0.7 * mem_ratio) + (0.3 * swap_ratio)
    return round(max(0.0, min(1.0, score)), 4)
