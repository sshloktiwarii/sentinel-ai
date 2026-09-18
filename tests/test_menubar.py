"""
tests/test_menubar.py

Unit tests for sentinel/menubar.py.
Tests status icons, title updates, menu structure, alert engine debouncing,
and dashboard launcher actions.
"""

from unittest.mock import MagicMock, patch
import pytest

from sentinel.menubar import (
    DEBOUNCE_INTERVAL_SEC,
    SWAP_ALERT_THRESHOLD_MB,
    TDI_ALERT_THRESHOLD,
    SentinelMenuBarApp,
)


class TestStatusIcon:
    def test_green_icon_for_nominal_tdi(self):
        assert SentinelMenuBarApp.get_status_icon(0.0) == "🟢"
        assert SentinelMenuBarApp.get_status_icon(0.08) == "🟢"
        assert SentinelMenuBarApp.get_status_icon(0.29) == "🟢"

    def test_yellow_icon_for_moderate_tdi(self):
        assert SentinelMenuBarApp.get_status_icon(0.30) == "🟡"
        assert SentinelMenuBarApp.get_status_icon(0.45) == "🟡"
        assert SentinelMenuBarApp.get_status_icon(0.69) == "🟡"

    def test_red_icon_for_critical_tdi(self):
        assert SentinelMenuBarApp.get_status_icon(0.70) == "🔴"
        assert SentinelMenuBarApp.get_status_icon(0.85) == "🔴"
        assert SentinelMenuBarApp.get_status_icon(1.00) == "🔴"


class TestAlertEngine:
    @pytest.fixture
    def app(self):
        with patch.object(SentinelMenuBarApp, "update_metrics"):
            with patch("rumps.Timer"):
                app = SentinelMenuBarApp()
                yield app

    def test_no_alert_when_below_thresholds(self, app):
        alerts = app.check_alerts(tdi=0.10, swap_used_mb=0.0, now=1000.0)
        assert alerts == []

    def test_tdi_alert_dispatched_when_crossing(self, app):
        with patch.object(app, "dispatch_notification") as mock_dispatch:
            alerts = app.check_alerts(tdi=0.80, swap_used_mb=0.0, now=1000.0)
            assert alerts == ["tdi"]
            mock_dispatch.assert_called_once()
            assert "critical" in mock_dispatch.call_args[0][0].lower()

    def test_swap_alert_dispatched_when_crossing(self, app):
        with patch.object(app, "dispatch_notification") as mock_dispatch:
            alerts = app.check_alerts(tdi=0.20, swap_used_mb=600.0, now=1000.0)
            assert alerts == ["swap"]
            mock_dispatch.assert_called_once()
            assert "swap" in mock_dispatch.call_args[0][0].lower()

    def test_both_alerts_when_both_cross(self, app):
        with patch.object(app, "dispatch_notification") as mock_dispatch:
            alerts = app.check_alerts(tdi=0.90, swap_used_mb=1024.0, now=1000.0)
            assert set(alerts) == {"tdi", "swap"}
            assert mock_dispatch.call_count == 2

    def test_alerts_are_debounced_within_5_minutes(self, app):
        with patch.object(app, "dispatch_notification") as mock_dispatch:
            # First trigger at t = 1000
            app.check_alerts(tdi=0.85, swap_used_mb=0.0, now=1000.0)
            assert mock_dispatch.call_count == 1

            # Second trigger 60s later (should be ignored)
            alerts2 = app.check_alerts(tdi=0.85, swap_used_mb=0.0, now=1060.0)
            assert alerts2 == []
            assert mock_dispatch.call_count == 1

            # Third trigger at 301s later (should fire again)
            alerts3 = app.check_alerts(tdi=0.85, swap_used_mb=0.0, now=1301.0)
            assert alerts3 == ["tdi"]
            assert mock_dispatch.call_count == 2


class TestMenuStructureAndUpdates:
    @pytest.fixture
    def app(self):
        with patch("rumps.Timer"):
            with patch.object(SentinelMenuBarApp, "fetch_telemetry", return_value={"thrash_index": 0.0}):
                with patch.object(SentinelMenuBarApp, "fetch_quotas", return_value=[]):
                    app = SentinelMenuBarApp()
                    yield app

    def test_menu_structure_contains_required_items(self, app):
        menu_titles = [getattr(item, "title", None) for item in app.menu.values() if item is not None]
        assert "Sentinel-AI — Apple Silicon Monitor" in menu_titles
        assert "Open Dashboard" in menu_titles
        assert "Trigger Manual Refresh" in menu_titles
        assert "Quit Sentinel Bar" in menu_titles

        # Check disabled header
        assert app.item_header.callback is None

    def test_update_metrics_updates_labels_and_title(self, app):
        mock_telemetry = {
            "thrash_index": 0.12,
            "wired_mb": 2500.0,
            "limit_mb": 18432.0,
            "swap_used_mb": 100.0,
            "pageouts": 42,
        }
        mock_quotas = [
            {"id": "omniroute", "tokens_left": "402k tokens / 330 reqs"},
            {"id": "cursor", "tokens_left": "0 / 100 reqs", "status": "exhausted"},
        ]

        with patch.object(app, "fetch_telemetry", return_value=mock_telemetry):
            with patch.object(app, "fetch_quotas", return_value=mock_quotas):
                with patch.object(app, "check_alerts"):
                    app.update_metrics()

        assert app.title == "TDI: 0.12 · 🟢"
        assert "2,500 MB / 18,432 MB" in app.item_wired.title
        assert "100 MB" in app.item_swap.title
        assert "42" in app.item_swap.title
        assert "402k tokens / 330 reqs" in app.item_omni.title
        assert "0 / 100 reqs (Exhausted)" in app.item_cursor.title


    def test_open_dashboard_runs_subprocess(self, app):
        with patch("subprocess.Popen") as mock_popen:
            app.open_dashboard(None)
            mock_popen.assert_called_once_with(["open", "http://localhost:3000"])

    def test_quit_app_calls_rumps_quit(self, app):
        with patch("rumps.quit_application") as mock_quit:
            app.quit_app(None)
            mock_quit.assert_called_once()
