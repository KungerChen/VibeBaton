"""Tests for standalone --app desktop window launching, launcher assets, and homepage GIFs."""

from __future__ import annotations

from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import urlopen

from vibebaton import cli, desktop_app
from vibebaton.web_server import VibeBatonWebServer, _CanvasHTTPServer, create_server

REPO_ROOT = Path(__file__).resolve().parents[1]


class TestDesktopAppFinder(unittest.TestCase):
    def test_finds_windows_edge_by_env_dir(self) -> None:
        expected = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
        found = desktop_app.find_app_mode_browser(
            platform="win32",
            env={"ProgramFiles(x86)": r"C:\Program Files (x86)"},
            which=lambda _name: None,
            path_exists=lambda p: str(p) == str(expected),
        )
        self.assertEqual(found, expected)

    def test_finds_macos_chrome_bundle(self) -> None:
        expected = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        found = desktop_app.find_app_mode_browser(
            platform="darwin",
            env={},
            which=lambda _name: None,
            path_exists=lambda p: p == expected,
        )
        self.assertEqual(found, expected)

    def test_finds_linux_chromium_via_which(self) -> None:
        expected = Path("/usr/bin/chromium")
        found = desktop_app.find_app_mode_browser(
            platform="linux",
            env={},
            which=lambda name: "/usr/bin/chromium" if name == "chromium" else None,
            path_exists=lambda p: p == expected,
        )
        self.assertEqual(found, expected)

    def test_returns_none_when_no_supported_browser_found(self) -> None:
        found = desktop_app.find_app_mode_browser(
            platform="linux",
            env={},
            which=lambda _name: None,
            path_exists=lambda _p: False,
        )
        self.assertIsNone(found)


class TestLaunchStudioWindow(unittest.TestCase):
    def test_browser_mode_opens_default_browser_without_popen(self) -> None:
        opened: list[str] = []
        spawned: list[list[str]] = []
        mode = desktop_app.launch_studio_window(
            "http://127.0.0.1:7860",
            app_mode=False,
            popen=lambda cmd, **_kw: spawned.append(cmd),
            open_browser=lambda url: opened.append(url),
        )
        self.assertEqual(mode, "browser")
        self.assertEqual(opened, ["http://127.0.0.1:7860"])
        self.assertEqual(spawned, [])

    def test_app_mode_launches_chromeless_window_when_browser_available(self) -> None:
        opened: list[str] = []
        spawned: list[tuple[list[str], dict[str, object]]] = []
        browser = Path(r"C:\Edge\msedge.exe")

        mode = desktop_app.launch_studio_window(
            "http://127.0.0.1:7860",
            app_mode=True,
            window_size=(1440, 900),
            browser_path=browser,
            popen=lambda cmd, **kw: spawned.append((cmd, kw)),
            open_browser=lambda url: opened.append(url),
        )
        self.assertEqual(mode, "app")
        self.assertEqual(opened, [])
        self.assertEqual(len(spawned), 1)
        cmd, kw = spawned[0]
        self.assertEqual(
            cmd,
            [
                str(browser),
                "--app=http://127.0.0.1:7860",
                "--window-size=1440,900",
                "--new-window",
            ],
        )
        self.assertEqual(kw["stdout"], subprocess.DEVNULL)
        self.assertEqual(kw["stderr"], subprocess.DEVNULL)

    def test_app_mode_falls_back_when_browser_missing_or_popen_fails(self) -> None:
        opened: list[str] = []
        with patch.object(desktop_app, "find_app_mode_browser", return_value=None):
            mode = desktop_app.launch_studio_window(
                "http://127.0.0.1:7860",
                app_mode=True,
                open_browser=lambda url: opened.append(url),
            )
        self.assertEqual(mode, "browser_fallback")
        self.assertEqual(opened, ["http://127.0.0.1:7860"])

        opened.clear()

        def failing_popen(*_args: object, **_kwargs: object) -> object:
            raise OSError("spawn blocked")

        mode2 = desktop_app.launch_studio_window(
            "http://127.0.0.1:7860",
            app_mode=True,
            browser_path=Path("/usr/bin/google-chrome"),
            popen=failing_popen,
            open_browser=lambda url: opened.append(url),
        )
        self.assertEqual(mode2, "browser_fallback")
        self.assertEqual(opened, ["http://127.0.0.1:7860"])


class TestCliUiAppFlag(unittest.TestCase):
    def test_parser_app_flag_default_and_enabled(self) -> None:
        default_args = cli.build_parser().parse_args(["ui"])
        self.assertIs(default_args.app, False)

        app_args = cli.build_parser().parse_args(["ui", "--app"])
        self.assertIs(app_args.app, True)

    def test_cmd_ui_app_flag_and_fallback_notice(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            stdout = io.StringIO()
            with (
                redirect_stdout(stdout),
                patch.object(VibeBatonWebServer, "serve_forever", autospec=True, side_effect=KeyboardInterrupt),
                patch.object(desktop_app, "launch_studio_window", return_value="browser_fallback") as launcher,
            ):
                rc = cli.main(["ui", "--repo", repo, "--port", "0", "--app"])
            self.assertEqual(rc, 0)
            launcher.assert_called_once()
            _, kwargs = launcher.call_args
            self.assertIs(kwargs["app_mode"], True)
            out_text = stdout.getvalue()
            self.assertIn("Listening on http://127.0.0.1:", out_text)
            self.assertIn("opened in default browser", out_text)


class TestLauncherAndGifCollateral(unittest.TestCase):
    def test_launcher_scripts_and_gif_assets_exist_and_are_documented(self) -> None:
        bat = REPO_ROOT / "VibeBaton-Studio.bat"
        ps1 = REPO_ROOT / "scripts" / "launch-studio.ps1"
        gifs = (
            "docs/assets/studio-replay-demo.gif",
            "docs/assets/studio-liquid-theme.gif",
            "docs/assets/studio-dag-redaction.gif",
        )
        self.assertTrue(bat.is_file(), f"missing {bat}")
        self.assertTrue(ps1.is_file(), f"missing {ps1}")
        for rel in gifs:
            path = REPO_ROOT / rel
            self.assertTrue(path.is_file(), f"missing {path}")
            self.assertGreater(path.stat().st_size, 100_000, f"unexpectedly small GIF: {path}")

        readme_en = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        readme_zh = (REPO_ROOT / "README.zh-CN.md").read_text(encoding="utf-8")
        for doc in (readme_en, readme_zh):
            for needle in (*gifs, "baton ui --app", "VibeBaton-Studio.bat", "launch-studio.ps1"):
                with self.subTest(needle=needle):
                    self.assertIn(needle, doc)

    def test_launch_script_stops_stale_ui_and_rebuilds_outdated_dist(self) -> None:
        ps1_text = (REPO_ROOT / "scripts" / "launch-studio.ps1").read_text(encoding="utf-8")
        self.assertIn("vibebaton\\s+ui", ps1_text)
        self.assertIn("Stop-Process", ps1_text)
        self.assertIn("LastWriteTimeUtc", ps1_text)


class TestUpgradeRefreshSemantics(unittest.TestCase):
    def test_windows_server_disables_reuse_address(self) -> None:
        if sys.platform == "win32":
            self.assertFalse(_CanvasHTTPServer.allow_reuse_address)

    def test_index_html_sets_no_cache_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dist = root / "dist"
            dist.mkdir()
            (dist / "index.html").write_text("<html>v1.2.0</html>", encoding="utf-8")
            server = create_server(REPO_ROOT, port=0, static_dir=dist)
            import threading

            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                with urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
                    self.assertEqual(resp.status, 200)
                    self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_multi_resolution_icons_and_manifest_exist(self) -> None:
        import json
        import struct

        public_dir = REPO_ROOT / "web" / "public"
        ico_data = (public_dir / "favicon.ico").read_bytes()
        reserved, ico_type, count = struct.unpack_from("<HHH", ico_data, 0)
        self.assertEqual((reserved, ico_type), (0, 1))
        self.assertGreaterEqual(count, 6)
        widths = [ico_data[6 + i * 16] for i in range(count)]
        self.assertIn(0, widths)  # 0 denotes 256x256 in ICO headers
        self.assertIn(48, widths)

        for name in ("icon-32.png", "icon-48.png", "icon-64.png", "icon-192.png", "icon-256.png", "icon-512.png"):
            png_bytes = (public_dir / name).read_bytes()
            self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

        manifest = json.loads((public_dir / "manifest.webmanifest").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(manifest.get("icons", [])), 4)

        index_html = (REPO_ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("./icon-256.png", index_html)
        self.assertIn("./favicon.ico", index_html)
        self.assertIn("./icon-192.png", index_html)
        self.assertIn("./manifest.webmanifest", index_html)



if __name__ == "__main__":
    unittest.main()
