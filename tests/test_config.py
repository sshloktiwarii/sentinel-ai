"""
tests/test_config.py

Unit tests for sentinel/config.py zero-dependency user configuration engine.
Tests default values, missing config file auto-generation, invalid JSON recovery,
partial overrides merging, and reload_config cache invalidation.
"""

import json
from pathlib import Path
import pytest

from sentinel.config import (
    DEFAULT_CONFIG,
    get_config,
    load_config,
    reload_config,
)


class TestConfigDefaults:
    def test_default_config_keys_and_values(self):
        """Verify all canonical configuration keys and default values match specification."""
        assert DEFAULT_CONFIG["proxy_url"] == "http://localhost:20128"
        assert DEFAULT_CONFIG["poll_interval_seconds"] == 1.0
        assert DEFAULT_CONFIG["tdi_warning_threshold"] == 0.75
        assert DEFAULT_CONFIG["tdi_critical_threshold"] == 0.90
        assert DEFAULT_CONFIG["velocity_alert_tps"] == 150.0
        assert DEFAULT_CONFIG["velocity_alert_rpm"] == 45.0
        assert DEFAULT_CONFIG["notification_debounce_seconds"] == 60.0
        assert DEFAULT_CONFIG["swap_limit_ratio"] == 0.25

    def test_missing_file_auto_generation(self, tmp_path):
        """When config.json does not exist, load_config must auto-create it with formatted default JSON."""
        target_file = tmp_path / "subdir" / "config.json"
        assert not target_file.exists()

        loaded = load_config(config_path=target_file)
        assert loaded == DEFAULT_CONFIG
        assert target_file.is_file()

        # Verify on-disk file content is valid formatted JSON matching defaults
        raw_disk = json.loads(target_file.read_text(encoding="utf-8"))
        assert raw_disk == DEFAULT_CONFIG

    def test_corrupt_json_fallback(self, tmp_path, caplog):
        """Corrupt or malformed JSON must log a warning and fall back to in-memory defaults."""
        corrupt_file = tmp_path / "corrupt_config.json"
        corrupt_file.write_text("{ this is definitely not valid json : [", encoding="utf-8")

        loaded = load_config(config_path=corrupt_file)
        assert loaded == DEFAULT_CONFIG
        assert any("Failed to load or parse config" in record.message for record in caplog.records)

    def test_non_dict_json_fallback(self, tmp_path, caplog):
        """JSON that parses to a list or primitive must log a warning and fall back to defaults."""
        non_dict_file = tmp_path / "array_config.json"
        non_dict_file.write_text("[1, 2, 3]", encoding="utf-8")

        loaded = load_config(config_path=non_dict_file)
        assert loaded == DEFAULT_CONFIG
        assert any("not a valid JSON object" in record.message for record in caplog.records)


class TestConfigOverridesAndReload:
    def test_user_overrides_merged_with_defaults(self, tmp_path):
        """User overrides must merge cleanly on top of defaults without losing other keys."""
        config_file = tmp_path / "custom_config.json"
        custom_data = {
            "proxy_url": "http://127.0.0.1:9090",
            "velocity_alert_tps": 250.0,
            "swap_limit_ratio": 0.35,
        }
        config_file.write_text(json.dumps(custom_data), encoding="utf-8")

        loaded = load_config(config_path=config_file)
        assert loaded["proxy_url"] == "http://127.0.0.1:9090"
        assert loaded["velocity_alert_tps"] == 250.0
        assert loaded["swap_limit_ratio"] == 0.35
        # Unspecified keys must retain their default values
        assert loaded["tdi_warning_threshold"] == 0.75
        assert loaded["tdi_critical_threshold"] == 0.90
        assert loaded["velocity_alert_rpm"] == 45.0
        assert loaded["notification_debounce_seconds"] == 60.0

    def test_get_config_and_reload_config_cache(self, tmp_path, monkeypatch):
        """Verify get_config returns cached dictionary and reload_config invalidates cache."""
        config_file = tmp_path / "live_config.json"
        config_file.write_text(json.dumps({"proxy_url": "http://initial:1234"}), encoding="utf-8")

        monkeypatch.setattr("sentinel.config.CONFIG_PATH", config_file)
        reload_config()

        cfg1 = get_config()
        assert cfg1["proxy_url"] == "http://initial:1234"

        # Update file on disk without calling reload_config -> get_config remains cached
        config_file.write_text(json.dumps({"proxy_url": "http://updated:5678"}), encoding="utf-8")
        cfg2 = get_config()
        assert cfg2["proxy_url"] == "http://initial:1234"

        # Call reload_config() -> cache is invalidated and updated
        cfg3 = reload_config()
        assert cfg3["proxy_url"] == "http://updated:5678"
        assert get_config()["proxy_url"] == "http://updated:5678"
