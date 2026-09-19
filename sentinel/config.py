"""
sentinel/config.py

Zero-dependency user configuration engine for Sentinel-AI.
Loads preferences from ~/.sentinel/config.json with fallback defaults,
auto-generates the initial configuration file on first boot, and
gracefully handles corrupted JSON.
"""

from __future__ import annotations

import functools
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("sentinel.config")

DEFAULT_CONFIG: dict[str, Any] = {
    "proxy_url": "http://localhost:20128",
    "poll_interval_seconds": 1.0,
    "tdi_warning_threshold": 0.75,
    "tdi_critical_threshold": 0.90,
    "velocity_alert_tps": 150.0,
    "velocity_alert_rpm": 45.0,
    "notification_debounce_seconds": 60.0,
    "swap_limit_ratio": 0.25,
}

CONFIG_DIR = Path.home() / ".sentinel"
CONFIG_PATH = CONFIG_DIR / "config.json"


def load_config(config_path: Path | None = None) -> dict[str, Any]:
    """Load configuration from disk, creating default config if missing.

    Merges user overrides on top of DEFAULT_CONFIG.
    Falls back to DEFAULT_CONFIG on missing or corrupt files.
    """
    path = config_path if config_path is not None else CONFIG_PATH

    if not path.exists():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to auto-generate default config at %s: %s", path, exc)
        return dict(DEFAULT_CONFIG)

    try:
        raw_text = path.read_text(encoding="utf-8")
        data = json.loads(raw_text)
        if not isinstance(data, dict):
            logger.warning("Config at %s is not a valid JSON object; falling back to defaults", path)
            return dict(DEFAULT_CONFIG)

        merged = dict(DEFAULT_CONFIG)
        merged.update(data)
        return merged
    except Exception as exc:
        logger.warning("Failed to load or parse config from %s (%s); falling back to defaults", path, exc)
        return dict(DEFAULT_CONFIG)


@functools.lru_cache(maxsize=1)
def get_config() -> dict[str, Any]:
    """Return cached user configuration dictionary."""
    return load_config()


def reload_config(config_path: Path | None = None) -> dict[str, Any]:
    """Invalidate cache and reload user configuration."""
    get_config.cache_clear()
    if config_path is not None:
        global CONFIG_PATH
        CONFIG_PATH = config_path
    return get_config()
