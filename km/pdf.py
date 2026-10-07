"""Printing the knowledge tree to PDF with the browser that is already here.

The tree is a web page: the formulas are KaTeX, the code is highlighted, the
Chinese is set in the system font. Only a browser draws that faithfully, and a
desktop already has one — so the print page is handed to headless
Chrome/Chromium/Edge and the PDF comes back. No extra Python dependency, and
what lands in the file is exactly what the print preview shows.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

# Where a browser usually lives, in the order worth trying.
CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
)
NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser")


def find_browser() -> str | None:
    """Which browser to render with: $KM_CHROME first, then the usual installs.

    @returns the executable path, or None when this machine has none of them.
    """
    explicit = os.environ.get("KM_CHROME")
    if explicit and Path(explicit).exists():
        return explicit
    for path in CANDIDATES:
        if Path(path).exists():
            return path
    for name in NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def render_pdf(url: str, timeout: int = 90) -> bytes:
    """Print the page at `url` to A4 and return the PDF bytes.

    @param url - the print page, already carrying its session.
    @param timeout - how long one browser attempt may take.
    @returns the PDF, ready to be written to a file.
    @throws RuntimeError when no browser is installed, or none produced a PDF.
    """
    browser = find_browser()
    if not browser:
        raise RuntimeError("这台机器上没有 Chrome / Chromium / Edge，生成不了 PDF；请用「打印 / 另存为 PDF」")
    with tempfile.TemporaryDirectory(prefix="km-pdf-") as tmp:
        out = Path(tmp) / "tree.pdf"
        args = [browser, "--headless=new", "--disable-gpu", "--disable-crash-reporter",
                "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
                "--virtual-time-budget=8000", f"--user-data-dir={Path(tmp) / 'profile'}",
                "--no-pdf-header-footer", f"--print-to-pdf={out}", url]
        last = ""
        # This environment's file rules can block the helper process Chrome's own
        # sandbox needs; then the strict run quietly produces nothing, so the
        # plain run is tried before giving up.
        for extra in ([], ["--no-sandbox"]):
            try:
                done = subprocess.run(args[:1] + extra + args[1:], capture_output=True, timeout=timeout)
                last = (done.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
                last = last[0][:200]
            except subprocess.TimeoutExpired:
                last = "渲染超时"
            except OSError as exc:
                raise RuntimeError(f"启动浏览器失败：{exc}") from exc
            if out.exists() and out.stat().st_size > 1000:
                return out.read_bytes()
        raise RuntimeError("浏览器没能生成 PDF" + (f"（{last}）" if last else ""))
