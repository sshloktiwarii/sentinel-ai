"""
tests/test_service.py

Unit tests for sentinel/service.py:
- LaunchAgent plist generation and XML structure validation
- Path resolution for repo root and virtualenv Python
- Service install and uninstall workflows (mocking launchctl)
- Process status detection via launchctl list and HTTP healthcheck
- Log inspection and CLI entrypoint argument handling
"""

import os
import plistlib
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from sentinel.service import (
    DEFAULT_LOG_PATH,
    DEFAULT_PLIST_PATH,
    SERVICE_LABEL,
    get_python_binary,
    get_repo_root,
    get_service_status,
    install_service,
    main,
    render_plist_dict,
    render_plist_xml,
    tail_logs,
    uninstall_service,
)


class TestPlistGeneration:
    """Test launchd property list construction and formatting."""

    def test_render_plist_dict_keys(self):
        repo_root = Path("/fake/repo/sentinel-ai")
        python_bin = "/fake/repo/sentinel-ai/.venv/bin/python"
        plist = render_plist_dict(repo_root=repo_root, python_bin=python_bin)

        assert plist["Label"] == SERVICE_LABEL
        assert plist["WorkingDirectory"] == str(repo_root)
        assert plist["RunAtLoad"] is True
        assert plist["KeepAlive"] is True
        assert "StandardOutPath" in plist
        assert "StandardErrorPath" in plist

        args = plist["ProgramArguments"]
        assert args[0] == python_bin
        assert args[1:4] == ["-m", "uvicorn", "sentinel.server:app"]
        assert "--host" in args
        assert "--port" in args

    def test_render_plist_xml_serialization(self):
        plist_dict = render_plist_dict()
        xml_bytes = render_plist_xml(plist_dict)
        assert xml_bytes.startswith(b"<?xml")
        # Validate round-trip deserialization
        loaded = plistlib.loads(xml_bytes)
        assert loaded["Label"] == SERVICE_LABEL
        assert loaded["RunAtLoad"] is True

    def test_get_repo_root_and_python_binary(self):
        root = get_repo_root()
        assert root.is_dir()
        assert (root / "sentinel").is_dir()

        py_bin = get_python_binary(root)
        assert os.path.exists(py_bin)
        assert os.access(py_bin, os.X_OK)


class TestServiceInstallAndUninstall:
    """Test filesystem interactions and launchctl lifecycle calls."""

    def test_install_service_creates_files_and_loads(self, tmp_path):
        plist_file = tmp_path / "com.sentinel.daemon.plist"
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()
        py_bin = str(tmp_path / "python")

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            code = install_service(
                plist_path=str(plist_file),
                repo_root=repo_dir,
                python_bin=py_bin,
                auto_load=True,
            )
            assert code == 0
            assert plist_file.is_file()

            # Ensure launchctl load was invoked with target plist
            calls = [call[0][0] for call in mock_run.call_args_list]
            assert ["launchctl", "unload", str(plist_file)] in calls
            assert ["launchctl", "load", str(plist_file)] in calls

            # Verify written XML content
            loaded = plistlib.loads(plist_file.read_bytes())
            assert loaded["Label"] == SERVICE_LABEL
            assert loaded["WorkingDirectory"] == str(repo_dir)

    def test_uninstall_service_unloads_and_deletes_file(self, tmp_path):
        plist_file = tmp_path / "com.sentinel.daemon.plist"
        plist_file.write_bytes(b"dummy plist")

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr="")
            code = uninstall_service(plist_path=str(plist_file))
            assert code == 0
            assert not plist_file.exists()

            calls = [call[0][0] for call in mock_run.call_args_list]
            assert ["launchctl", "unload", str(plist_file)] in calls


class TestServiceStatus:
    """Test process inspection via launchctl and HTTP telemetry."""

    def test_status_when_plist_missing(self, tmp_path):
        plist_file = tmp_path / "missing.plist"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="")
            status = get_service_status(plist_path=str(plist_file))
            assert status["plist_exists"] is False
            assert status["status"] == "uninstalled"
            assert status["loaded"] is False

    def test_status_running_healthy(self, tmp_path):
        plist_file = tmp_path / "com.sentinel.daemon.plist"
        plist_file.write_bytes(b"dummy")

        mock_launchctl = MagicMock(
            returncode=0,
            stdout=f"54321\t0\t{SERVICE_LABEL}\n1234\t0\tcom.other.service\n",
        )

        mock_http_resp = MagicMock()
        mock_http_resp.__enter__.return_value = mock_http_resp
        mock_http_resp.status = 200
        mock_http_resp.code = 200
        mock_http_resp.read.return_value = b'{"thrash_index": 0.15, "wired_mb": 2048}'

        with patch("subprocess.run", return_value=mock_launchctl):
            with patch("urllib.request.urlopen", return_value=mock_http_resp):
                status = get_service_status(plist_path=str(plist_file))

        assert status["plist_exists"] is True
        assert status["loaded"] is True
        assert status["pid"] == 54321
        assert status["last_exit_code"] == 0
        assert status["http_ok"] is True
        assert status["status"] == "running"
        assert status["telemetry"]["thrash_index"] == 0.15

    def test_status_stopped_or_crashed(self, tmp_path):
        plist_file = tmp_path / "com.sentinel.daemon.plist"
        plist_file.write_bytes(b"dummy")

        # Daemon stopped: PID shows '-'
        mock_launchctl = MagicMock(
            returncode=0,
            stdout=f"-\t1\t{SERVICE_LABEL}\n",
        )

        with patch("subprocess.run", return_value=mock_launchctl):
            with patch("urllib.request.urlopen", side_effect=Exception("Connection refused")):
                status = get_service_status(plist_path=str(plist_file))

        assert status["loaded"] is True
        assert status["pid"] is None
        assert status["last_exit_code"] == 1
        assert status["http_ok"] is False
        assert status["status"] == "loaded (backend unhealthy)"


class TestLogTailingAndCLI:
    """Test log inspection and CLI argument parsing."""

    def test_tail_logs_missing_file(self, tmp_path, capsys):
        code = tail_logs(log_path=str(tmp_path / "nonexistent.log"))
        assert code == 1
        captured = capsys.readouterr()
        assert "not found" in captured.out.lower()

    def test_tail_logs_invokes_tail(self, tmp_path):
        log_file = tmp_path / "daemon.log"
        log_file.write_text("line 1\nline 2\n")

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            code = tail_logs(log_path=str(log_file), lines=20, follow=True)
            assert code == 0
            mock_run.assert_called_once_with(["tail", "-n20", "-f", str(log_file)], check=False)

    def test_cli_subcommands_routing(self):
        with patch("sentinel.service.install_service", return_value=0) as mock_install:
            code = main(["install"])
            assert code == 0
            mock_install.assert_called_once()

        with patch("sentinel.service.uninstall_service", return_value=0) as mock_uninstall:
            code = main(["uninstall"])
            assert code == 0
            mock_uninstall.assert_called_once()

        with patch("sentinel.service.get_service_status") as mock_status:
            with patch("sentinel.service.print_service_status"):
                mock_status.return_value = {"status": "running"}
                code = main(["status"])
                assert code == 0
                mock_status.assert_called_once()

        with patch("sentinel.service.tail_logs", return_value=0) as mock_logs:
            code = main(["logs", "-n", "30", "-f"])
            assert code == 0
            mock_logs.assert_called_once_with(lines=30, follow=True)
