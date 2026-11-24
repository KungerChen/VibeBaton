"""Launch VibeBaton Studio in a browser tab or chromeless --app desktop window."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Callable, Mapping
import webbrowser


_MACOS_APP_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)

_LINUX_BROWSER_NAMES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
)


def _iter_windows_candidates(
    env: Mapping[str, str],
    which: Callable[[str], str | None],
) -> list[Path]:
    candidates: list[Path] = []
    pf86 = env.get("ProgramFiles(x86)")
    pf = env.get("ProgramFiles")
    local_app = env.get("LOCALAPPDATA")

    def add_rel(base: str | None, *parts: str) -> None:
        if base:
            candidates.append(Path(base, *parts))

    # Edge (preinstalled on modern Windows)
    add_rel(pf86, "Microsoft", "Edge", "Application", "msedge.exe")
    add_rel(pf, "Microsoft", "Edge", "Application", "msedge.exe")
    add_rel(local_app, "Microsoft", "Edge", "Application", "msedge.exe")
    for cmd in ("msedge", "msedge.exe"):
        resolved = which(cmd)
        if resolved:
            candidates.append(Path(resolved))

    # Chrome
    add_rel(pf, "Google", "Chrome", "Application", "chrome.exe")
    add_rel(pf86, "Google", "Chrome", "Application", "chrome.exe")
    add_rel(local_app, "Google", "Chrome", "Application", "chrome.exe")
    for cmd in ("chrome", "chrome.exe"):
        resolved = which(cmd)
        if resolved:
            candidates.append(Path(resolved))

    # Brave
    add_rel(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    add_rel(local_app, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    for cmd in ("brave", "brave.exe"):
        resolved = which(cmd)
        if resolved:
            candidates.append(Path(resolved))

    return candidates


def find_app_mode_browser(
    platform: str | None = None,
    which: Callable[[str], str | None] = shutil.which,
    env: Mapping[str, str] | None = None,
    path_exists: Callable[[Path], bool] | None = None,
) -> Path | None:
    """Locate a Chromium-family browser binary supporting `--app=URL` mode."""
    plat = (platform if platform is not None else sys.platform).lower()
    env_map = env if env is not None else os.environ
    exists_fn = path_exists if path_exists is not None else Path.is_file

    if plat.startswith("win"):
        for candidate in _iter_windows_candidates(env_map, which):
            if exists_fn(candidate):
                return candidate
        return None

    if plat == "darwin":
        for raw_path in _MACOS_APP_CANDIDATES:
            candidate = Path(raw_path)
            if exists_fn(candidate):
                return candidate
        return None

    for name in _LINUX_BROWSER_NAMES:
        resolved = which(name)
        if resolved:
            candidate = Path(resolved)
            if exists_fn(candidate):
                return candidate
    return None


def launch_studio_window(
    url: str,
    *,
    app_mode: bool = False,
    window_size: tuple[int, int] = (1440, 900),
    popen: Callable[..., object] = subprocess.Popen,
    open_browser: Callable[[str], object] = webbrowser.open,
    browser_path: Path | None = None,
) -> str:
    """Open VibeBaton Studio in standard browser mode or chromeless `--app` window."""
    if not app_mode:
        open_browser(url)
        return "browser"

    browser = browser_path if browser_path is not None else find_app_mode_browser()
    if browser is None:
        open_browser(url)
        return "browser_fallback"

    try:
        popen(
            [
                str(browser),
                f"--app={url}",
                f"--window-size={window_size[0]},{window_size[1]}",
                "--new-window",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return "app"
    except OSError:
        open_browser(url)
        return "browser_fallback"
