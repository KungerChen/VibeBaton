"""Render Studio icons from web/public/favicon.svg at every target size and repack favicon.ico.

Each size is rasterised separately from the vector source by the local Edge/Chrome (headless canvas),
so no PNG is an upscaled copy of a smaller one. Sizes up to SMALL_MAX use a simplified drawing whose
thin details would otherwise blur together. Standard library only; run from the repository root:

    python scripts/render-icons.py
"""

from __future__ import annotations

import base64
import html
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "web" / "public"
sys.path.insert(0, str(ROOT / "src"))

from vibebaton.desktop_app import _iter_windows_candidates, find_app_mode_browser  # noqa: E402

PNG_SIZES = (32, 48, 64, 192, 256, 512)  # files the page and manifest reference
ICO_SIZES = (16, 24, 32, 40, 48, 64, 128, 256)
ICO_BMP_MAX = 48  # small ICO frames as BMP for older shell code paths, larger ones as PNG
SMALL_MAX = 24


def small_variant(svg: str) -> str:
    """Drop the hairline rim and the grip mark, and thicken the baton, for 16/24 px."""
    svg = re.sub(r'\s*<rect x="\.5"[^>]*/>', "", svg)
    svg = re.sub(r'\s*<path [^>]*/>', "", svg)
    return svg.replace('y="12.25" width="22" height="7.5" rx="3.75"', 'y="11.5" width="23" height="9" rx="4.5"')


def sized(svg: str, size: int) -> str:
    """Give the SVG an intrinsic size equal to the target, so the browser rasterises at that size."""
    return re.sub(r'width="32" height="32"', f'width="{size}" height="{size}"', svg, count=1)


PAGE = """<!doctype html><meta charset="utf-8"><body><script>
const jobs = %s;
(async () => {
  const out = {};
  for (const [size, svg] of jobs) {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    let bin = '';
    for (let i = 0; i < rgba.length; i += 8192) bin += String.fromCharCode(...rgba.subarray(i, i + 8192));
    out[size] = btoa(bin);
  }
  document.body.textContent = 'ICONS:' + JSON.stringify(out) + ':ICONS';
})();
</script>"""


def _browsers() -> list[Path]:
    """Installed Chromium browsers; on some machines Edge's headless mode prints nothing, so try each."""
    if sys.platform == "win32":
        found = [p for p in _iter_windows_candidates(os.environ, shutil.which) if p.is_file()]
        return sorted(dict.fromkeys(found), key=lambda p: "chrome" not in p.name.lower())
    browser = find_app_mode_browser()
    return [browser] if browser is not None else []


def render(svg: str, sizes: list[int]) -> dict[int, bytes]:
    """Straight (non-premultiplied) RGBA pixels per size."""
    jobs = [[size, sized(small_variant(svg) if size <= SMALL_MAX else svg, size)] for size in sizes]
    for browser in _browsers():
        with tempfile.TemporaryDirectory(prefix="vibebaton-icons-", ignore_cleanup_errors=True) as tmp:
            page = Path(tmp) / "render.html"
            page.write_text(PAGE % json.dumps(jobs), encoding="utf-8")
            dom = subprocess.run(
                [str(browser), "--headless=new", "--disable-gpu", f"--user-data-dir={Path(tmp) / 'profile'}",
                 "--virtual-time-budget=15000", "--dump-dom", page.as_uri()],
                capture_output=True, text=True, encoding="utf-8", timeout=120,
            ).stdout or ""
        match = re.search(r"ICONS:(.*):ICONS", html.unescape(dom), re.S)
        if match is not None:
            payload = json.loads(match.group(1))
            return {int(k): base64.b64decode(v) for k, v in payload.items()}
    raise SystemExit("No installed Chrome/Edge returned rendered icons in headless mode.")


def encode_png(size: int, rgba: bytes) -> bytes:
    """RGBA PNG with a per-row best filter (None/Sub/Up) and maximum zlib compression."""
    stride = size * 4
    previous = bytes(stride)
    data = bytearray()
    for y in range(size):
        row = rgba[y * stride:(y + 1) * stride]
        sub_row = bytes((row[i] - (row[i - 4] if i >= 4 else 0)) & 0xFF for i in range(stride))
        up_row = bytes((row[i] - previous[i]) & 0xFF for i in range(stride))
        candidates = ((0, row), (1, sub_row), (2, up_row))
        kind, best = min(candidates, key=lambda item: sum(b if b < 128 else 256 - b for b in item[1]))
        data.append(kind)
        data += best
        previous = row

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    signature = b"\x89PNG\r\n\x1a\n"
    return signature + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(data), 9)) + chunk(b"IEND", b"")


def bmp_frame(size: int, rgba: bytes) -> bytes:
    """32-bit BGRA DIB (bottom-up, double height) plus an all-zero AND mask, as ICO frames expect."""
    rows = [rgba[y * size * 4:(y + 1) * size * 4] for y in range(size)]
    pixels = b"".join(bytes(b for i in range(0, len(row), 4) for b in (row[i + 2], row[i + 1], row[i], row[i + 3]))
                      for row in reversed(rows))
    mask_row = ((size + 31) // 32) * 4
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, len(pixels), 0, 0, 0, 0)
    return header + pixels + bytes(mask_row * size)


def build_ico(frames: dict[int, bytes]) -> bytes:
    entries, blobs = b"", b""
    offset = 6 + 16 * len(frames)
    for size, blob in frames.items():
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    return struct.pack("<HHH", 0, 1, len(frames)) + entries + blobs


def main() -> None:
    svg = (PUBLIC / "favicon.svg").read_text(encoding="utf-8")
    rendered = render(svg, sorted(set(PNG_SIZES) | set(ICO_SIZES)))
    for size in PNG_SIZES:
        (PUBLIC / f"icon-{size}.png").write_bytes(encode_png(size, rendered[size]))
    frames = {
        size: bmp_frame(size, rendered[size]) if size <= ICO_BMP_MAX else encode_png(size, rendered[size])
        for size in ICO_SIZES
    }
    (PUBLIC / "favicon.ico").write_bytes(build_ico(frames))
    print("Wrote", ", ".join(f"icon-{s}.png" for s in PNG_SIZES), "and favicon.ico", list(ICO_SIZES))


if __name__ == "__main__":
    main()
