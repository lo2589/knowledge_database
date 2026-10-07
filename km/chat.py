"""Chatting with Codex from the web page, one turn at a time.

The Codex CLI is driven as a subprocess (`codex exec --json`), so a chat runs
with the account and the configuration that are already on this machine: no API
key to paste, no second login, and every turn ends up in the same session files
Codex writes anyway. All this module does is turn its event stream into the few
things a page needs — the answer as it is written, the reasoning behind it, the
commands it ran, and the thread id that lets the next turn continue the same
conversation.

The visitor's text never reaches a shell: the prompt goes in on stdin, and every
argument is passed as its own argv entry.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from collections import deque

# Where a Codex CLI tends to live, in the order worth trying.
CANDIDATES = (
    "/Applications/ChatGPT.app/Contents/Resources/codex",   # the desktop app ships one
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    os.path.expanduser("~/.codex/bin/codex"),
    os.path.expanduser("~/.local/bin/codex"),
)
NAMES = ("codex", "codex-cli")
# One turn may legitimately take minutes before the first token: on some
# networks the CLI spends ~2 minutes retrying its WebSocket transport ("Reconnecting…"
# on the status channel) before it falls back to plain HTTPS and answers. The page
# shows those lines while they happen; this is the ceiling for one turn.
DEFAULT_TIMEOUT = 900
TAIL_LINES = 40


def find_codex() -> str | None:
    """Which Codex CLI to drive: $KM_CODEX first, then the usual installs.

    @returns the executable, or None when this machine has no Codex at all.
    @throws ValueError when $KM_CODEX is set to something that is not there —
        quietly driving a different Codex than the one asked for is worse.
    """
    explicit = os.environ.get("KM_CODEX")
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise ValueError(f"KM_CODEX 指向的 Codex 不存在：{explicit}")
    for path in CANDIDATES:
        if os.path.exists(path):
            return path
    for name in NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def command(prompt_file: bool, thread: str | None = None, cwd: str | None = None,
            model: str | None = None, sandbox: str = "read-only",
            images: list[str] | None = None) -> list[str]:
    """The argv for one turn.

    The first turn of a conversation starts a thread and fixes the working
    directory; every later turn resumes that thread, and `resume` takes the
    sandbox as a config override because it has no `--sandbox` of its own.
    @param prompt_file - always True here: the prompt is written to stdin.
    @returns argv, safe to hand to subprocess.
    """
    exe = find_codex()
    if not exe:
        raise ValueError("这台机器上没有找到 Codex CLI（装好 ChatGPT/Codex 桌面版，或设 KM_CODEX=/path/to/codex）")
    base = [exe, "exec"]
    if thread:
        argv = base + ["resume", str(thread)]
        argv += ["-c", f'sandbox_mode="{sandbox}"']
    else:
        argv = base + ["-s", sandbox]
        if cwd:
            argv += ["-C", cwd]
    argv += ["--skip-git-repo-check", "--json"]
    for image in images or []:          # 图片附件：Codex 自己会看
        argv += ["-i", str(image)]
    if model:
        argv += ["-m", model]
    argv += ["-"]                      # the prompt arrives on stdin
    return argv


def normalize(event: dict) -> list[dict]:
    """One raw Codex event → zero or more events the page understands.

    @param event - a decoded line of `codex exec --json` output.
    @returns events like {"event": "text" | "reasoning" | "tool" | "thread" |
        "usage" | "error", ...}.
    """
    kind = event.get("type")
    if kind == "thread.started":
        return [{"event": "thread", "thread": event.get("thread_id", "")}]
    if kind == "turn.started":
        return [{"event": "turn", "at": time.time()}]
    if kind == "turn.completed":
        return [{"event": "usage", "usage": event.get("usage") or {}}]
    if kind == "error":
        return [_complaint(str(event.get("message", "")))]
    if isinstance(kind, str) and kind.startswith("item."):
        item = event.get("item") or {}
        what, text = item.get("type"), item.get("text")
        if what in ("agent_message", "assistant_message") and isinstance(text, str):
            return [{"event": "text", "id": item.get("id", ""), "text": text}]
        if what == "reasoning" and isinstance(text, str):
            return [{"event": "reasoning", "id": item.get("id", ""), "text": text}]
        if what in ("command_execution", "local_shell_call", "function_call", "tool_call"):
            detail = item.get("command") or item.get("query") or item.get("name") or ""
            if isinstance(detail, list):
                detail = " ".join(str(x) for x in detail)
            return [{"event": "tool", "id": item.get("id", ""), "name": str(item.get("name") or what),
                     "detail": str(detail)[:300], "status": item.get("status") or ""}]
        if what == "error":
            return [_complaint(str(item.get("message", "")))]
        return []
    return []


# The CLI narrates its own retries on the same channel it reports failures on.
# Those lines are progress, not a broken turn: they belong in a quiet status
# line, because on a slow network the first turn of a session spends a while
# there before it gets through.
NOT_FAILURES = ("Reconnecting", "Falling back", "stream disconnected", "retrying")


def _complaint(message: str) -> dict:
    """One CLI complaint → either a status line or an error."""
    if message.startswith(NOT_FAILURES):
        return {"event": "status", "message": message}
    return {"event": "error", "message": message}


class Turn:
    """One running turn: the child, its stderr tail, and how to stop it."""

    def __init__(self, argv: list[str], prompt: str, cwd: str | None,
                 images: list[str] | None = None, timeout: int = DEFAULT_TIMEOUT):
        self.argv = argv
        self.images = [str(i) for i in (images or [])]
        self.timeout = timeout
        self.started = time.time()
        self.stderr: deque[str] = deque(maxlen=TAIL_LINES)
        self._lock = threading.Lock()
        try:
            self.proc = subprocess.Popen(
                argv, cwd=cwd or None, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1)
        except OSError as exc:
            raise RuntimeError(f"启动 Codex 失败：{exc}") from exc
        self._drainer = threading.Thread(target=self._drain, daemon=True)
        self._drainer.start()
        try:
            self.proc.stdin.write(prompt)
            self.proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def _drain(self) -> None:
        """Codex writes warnings to stderr; keep the tail so a failure can say why."""
        try:
            for line in self.proc.stderr:
                line = line.strip()
                if line:
                    with self._lock:
                        self.stderr.append(line)
        except (ValueError, OSError):
            pass

    def tail(self) -> str:
        with self._lock:
            return "\n".join(self.stderr)

    def stop(self) -> None:
        """Nobody is listening any more: end the child."""
        proc = self.proc
        if proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                return
            for _ in range(20):
                if proc.poll() is not None:
                    return
                time.sleep(0.1)
            try:
                proc.kill()
            except OSError:
                pass

    def events(self):
        """Yield the page-facing events of this turn, in order.

        Stops (and kills the child) when the caller goes away, when the turn takes
        longer than the timeout, or when Codex exits.
        """
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                if time.time() - self.started > self.timeout:
                    yield {"event": "error", "message": f"这一轮超过 {self.timeout // 60} 分钟，已停掉"}
                    return
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    yield {"event": "raw", "text": line[:300]}
                    continue
                for out in normalize(raw):
                    yield out
            code = self.proc.wait(timeout=30)
            if code != 0:
                tail = self.tail()
                yield {"event": "error", "message": f"Codex 退出码 {code}" + (f"：{tail[-400:]}" if tail else "")}
        finally:
            self.stop()


def start(prompt: str, *, thread: str | None = None, cwd: str | None = None,
          model: str | None = None, sandbox: str = "read-only",
          images: list[str] | None = None, timeout: int = DEFAULT_TIMEOUT) -> Turn:
    """Begin one turn and hand back the object that streams it.

    @param images - absolute paths of pictures to send with the question.
    """
    if not (prompt or "").strip() and not images:
        raise ValueError("说点什么")
    return Turn(command(True, thread=thread, cwd=cwd, model=model, sandbox=sandbox, images=images),
                prompt, cwd, images, timeout)
