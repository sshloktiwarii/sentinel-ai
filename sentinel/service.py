"""
sentinel/service.py

Native macOS background daemon persistence via launchd for Sentinel-AI.
Manages the user LaunchAgent plist (~/Library/LaunchAgents/com.sentinel.daemon.plist),
handling installation, uninstallation, process health queries, and log tailing.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ── LaunchAgent Constants ─────────────────────────────────────────────────────

SERVICE_LABEL = "com.sentinel.daemon"
DEFAULT_PLIST_DIR = os.path.expanduser("~/Library/LaunchAgents")
DEFAULT_PLIST_PATH = os.path.join(DEFAULT_PLIST_DIR, f"{SERVICE_LABEL}.plist")
DEFAULT_SENTINEL_DIR = os.path.expanduser("~/.sentinel")
DEFAULT_LOG_PATH = os.path.join(DEFAULT_SENTINEL_DIR, "daemon.log")
DEFAULT_ERR_PATH = os.path.join(DEFAULT_SENTINEL_DIR, "daemon.err")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


def get_repo_root() -> Path:
    """Resolve the absolute root path of the sentinel-ai repository."""
    return Path(__file__).resolve().parent.parent


def get_python_binary(repo_root: Path | None = None) -> str:
    """Resolve virtual environment python binary if present, falling back to sys.executable."""
    root = repo_root or get_repo_root()
    venv_python = root / ".venv" / "bin" / "python"
    if venv_python.is_file() and os.access(venv_python, os.X_OK):
        return str(venv_python)
    return sys.executable


def render_plist_dict(
    repo_root: Path | None = None,
    python_bin: str | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_path: str = DEFAULT_LOG_PATH,
    err_path: str = DEFAULT_ERR_PATH,
) -> dict[str, Any]:
    """Generate the launchd service dictionary for Sentinel-AI."""
    root = repo_root or get_repo_root()
    py_bin = python_bin or get_python_binary(root)

    return {
        "Label": SERVICE_LABEL,
        "ProgramArguments": [
            py_bin,
            "-m",
            "uvicorn",
            "sentinel.server:app",
            "--host",
            host,
            "--port",
            str(port),
        ],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": log_path,
        "StandardErrorPath": err_path,
    }


def render_plist_xml(plist_data: dict[str, Any]) -> bytes:
    """Serialize launchd dictionary to standard Apple XML plist format."""
    return plistlib.dumps(plist_data, fmt=plistlib.FMT_XML)


# ── Service Management Commands ───────────────────────────────────────────────

def install_service(
    plist_path: str = DEFAULT_PLIST_PATH,
    repo_root: Path | None = None,
    python_bin: str | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    auto_load: bool = True,
) -> int:
    """Create logs directory, write LaunchAgent plist, and load via launchctl."""
    root = repo_root or get_repo_root()
    py_bin = python_bin or get_python_binary(root)

    # 1. Ensure target directories exist
    os.makedirs(os.path.dirname(plist_path), exist_ok=True)
    os.makedirs(DEFAULT_SENTINEL_DIR, exist_ok=True)

    # 2. Render and write plist file
    plist_dict = render_plist_dict(
        repo_root=root,
        python_bin=py_bin,
        host=host,
        port=port,
    )
    xml_data = render_plist_xml(plist_dict)
    with open(plist_path, "wb") as f:
        f.write(xml_data)

    print(f"✓ Wrote LaunchAgent plist to: {plist_path}")
    print(f"  - Working Directory: {root}")
    print(f"  - Python Executable: {py_bin}")
    print(f"  - Logs: {DEFAULT_LOG_PATH}")

    # 3. Load with launchctl
    if auto_load:
        # Unload previous instance if running
        subprocess.run(
            ["launchctl", "unload", plist_path],
            capture_output=True,
            check=False,
        )
        res = subprocess.run(
            ["launchctl", "load", plist_path],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode == 0:
            print(f"✓ Successfully loaded {SERVICE_LABEL} via launchctl.")
        else:
            print(f"⚠️ launchctl load returned code {res.returncode}: {res.stderr.strip()}")
            return res.returncode

    return 0


def uninstall_service(plist_path: str = DEFAULT_PLIST_PATH) -> int:
    """Unload daemon from launchctl and delete plist file."""
    # 1. Unload from launchctl
    if os.path.exists(plist_path):
        res = subprocess.run(
            ["launchctl", "unload", plist_path],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode == 0:
            print(f"✓ Unloaded {SERVICE_LABEL} via launchctl.")
        else:
            print(f"ℹ️ launchctl unload (exit code {res.returncode}): {res.stderr.strip() or 'already unloaded'}")

    # 2. Delete plist
    if os.path.exists(plist_path):
        try:
            os.remove(plist_path)
            print(f"✓ Removed plist file: {plist_path}")
        except Exception as e:
            print(f"❌ Failed to delete plist file: {e}")
            return 1
    else:
        print(f"ℹ️ Plist file does not exist: {plist_path}")

    print(f"✓ {SERVICE_LABEL} uninstalled cleanly.")
    return 0


def get_service_status(
    plist_path: str = DEFAULT_PLIST_PATH,
    api_url: str = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/api/telemetry",
) -> dict[str, Any]:
    """Query launchctl and HTTP telemetry endpoint to inspect daemon health."""
    status_info: dict[str, Any] = {
        "label": SERVICE_LABEL,
        "plist_exists": os.path.exists(plist_path),
        "plist_path": plist_path,
        "loaded": False,
        "pid": None,
        "last_exit_code": None,
        "http_ok": False,
        "status": "uninstalled",
        "telemetry": None,
    }

    # 1. Query launchctl list
    res = subprocess.run(["launchctl", "list"], capture_output=True, text=True, check=False)
    if res.returncode == 0:
        for line in res.stdout.splitlines():
            if SERVICE_LABEL in line:
                status_info["loaded"] = True
                parts = line.strip().split()
                if len(parts) >= 3:
                    # Format: PID  Status  Label
                    raw_pid, raw_status = parts[0], parts[1]
                    status_info["pid"] = int(raw_pid) if raw_pid.isdigit() else None
                    status_info["last_exit_code"] = int(raw_status) if raw_status.lstrip("-").isdigit() else None
                break

    # 2. Query HTTP healthcheck
    try:
        req = urllib.request.Request(api_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            code = getattr(resp, "status", getattr(resp, "code", 200))
            if code == 200:
                status_info["http_ok"] = True
                try:
                    raw_body = resp.read()
                    if isinstance(raw_body, bytes):
                        raw_body = raw_body.decode("utf-8", errors="ignore")
                    status_info["telemetry"] = json.loads(raw_body)
                except Exception:
                    pass
    except Exception:
        status_info["http_ok"] = False

    # Determine overall status string
    if not status_info["plist_exists"]:
        status_info["status"] = "uninstalled"
    elif status_info["loaded"] and status_info["http_ok"]:
        status_info["status"] = "running"
    elif status_info["loaded"]:
        status_info["status"] = "loaded (backend unhealthy)"
    else:
        status_info["status"] = "stopped"

    return status_info


def print_service_status(status_info: dict[str, Any]) -> None:
    """Pretty-print service status dictionary."""
    print("=" * 60)
    print(f"  Sentinel-AI Service Status ({status_info['label']})")
    print("=" * 60)
    print(f"  Status:          {status_info['status'].upper()}")
    print(f"  Plist Exists:    {'Yes' if status_info['plist_exists'] else 'No'} ({status_info['plist_path']})")
    print(f"  Launchctl Loaded:{'Yes' if status_info['loaded'] else 'No'}")
    print(f"  PID:             {status_info['pid'] if status_info['pid'] else 'None'}")
    print(f"  Last Exit Code:  {status_info['last_exit_code'] if status_info['last_exit_code'] is not None else 'N/A'}")
    print(f"  HTTP Healthcheck:{'ONLINE (200 OK)' if status_info['http_ok'] else 'OFFLINE / UNREACHABLE'}")

    if status_info.get("telemetry"):
        tel = status_info["telemetry"]
        print("-" * 60)
        print("  Telemetry Snapshot:")
        print(f"    - Thrash Index: {tel.get('thrash_index', 0.0)}")
        print(f"    - Wired VRAM:   {tel.get('wired_mb', 0.0):,.0f} MB / {tel.get('limit_mb', 0.0):,.0f} MB")
        print(f"    - Swap Used:    {tel.get('swap_used_mb', 0.0):,.0f} MB")
    print("=" * 60)


def tail_logs(
    log_path: str = DEFAULT_LOG_PATH,
    lines: int = 50,
    follow: bool = False,
) -> int:
    """Print or follow recent log lines from standard output log."""
    if not os.path.exists(log_path):
        print(f"ℹ️ Log file not found: {log_path}")
        return 1

    cmd = ["tail", f"-n{lines}"]
    if follow:
        cmd.append("-f")
    cmd.append(log_path)

    try:
        subprocess.run(cmd, check=False)
        return 0
    except KeyboardInterrupt:
        return 0


# ── CLI Entrypoint ────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    """Parse CLI commands for sentinel-service."""
    parser = argparse.ArgumentParser(
        prog="sentinel-service",
        description="Native macOS launchd background service manager for Sentinel-AI.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Service command to run")

    # install
    subparsers.add_parser("install", help="Install and load Sentinel LaunchAgent daemon.")

    # uninstall
    subparsers.add_parser("uninstall", help="Unload and remove Sentinel LaunchAgent daemon.")

    # status
    subparsers.add_parser("status", help="Inspect launchctl process state and HTTP API health.")

    # logs
    parser_logs = subparsers.add_parser("logs", help="Tail daemon log file.")
    parser_logs.add_argument("-n", "--lines", type=int, default=50, help="Number of lines to show (default: 50)")
    parser_logs.add_argument("-f", "--follow", action="store_true", help="Follow log output in real-time")

    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 0

    if args.command == "install":
        return install_service()
    elif args.command == "uninstall":
        return uninstall_service()
    elif args.command == "status":
        status_data = get_service_status()
        print_service_status(status_data)
        return 0 if status_data["status"] == "running" else 1
    elif args.command == "logs":
        return tail_logs(lines=args.lines, follow=args.follow)

    return 0


if __name__ == "__main__":
    sys.exit(main())
