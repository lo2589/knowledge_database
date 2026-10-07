"""Codex conversations kept next to the knowledge they produced.

A chat is one JSON file: the thread to resume, the directory it works in, and
every turn that was said. It lives beside the session libraries, so a chat and
the cards picked out of it stay one thing — and the page can come back to a
conversation after a reload, or after the browser was closed.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

CHAT_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def new_id(prefix: str = "codex") -> str:
    """A fresh chat id: readable, sortable, and safe as a query value."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{prefix}-{stamp}-{int(time.time() * 1000) % 1000:03d}"


def path_for(home: Path, chat_id: str) -> Path:
    """Where one chat's file lives.
    @throws ValueError when the id is not a plain name (never a path)."""
    if not CHAT_ID.match(chat_id or ""):
        raise ValueError(f"对话 id 不合法：{chat_id}")
    return Path(home) / f"{chat_id}.json"


def load(home: Path, chat_id: str) -> dict:
    """The stored chat, or a fresh empty one when there is nothing yet."""
    path = path_for(home, chat_id)
    if not path.is_file():
        return {"id": chat_id, "thread": "", "cwd": "", "created": int(time.time() * 1000), "turns": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("turns", [])
    return data


def save(home: Path, chat: dict) -> None:
    """Write one chat back to disk, in full."""
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    path = path_for(home, chat["id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(chat, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def recent(home: Path, limit: int = 30) -> list[dict]:
    """The newest chats first: id, title, directory, when, how many turns."""
    home = Path(home)
    if not home.is_dir():
        return []
    out = []
    for path in home.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        turns = data.get("turns") or []
        first = (turns[0].get("q") if turns else "") or ""
        out.append({"id": data.get("id") or path.stem, "title": first.replace("\n", " ")[:60],
                    "cwd": data.get("cwd", ""), "turns": len(turns),
                    "at": (turns[-1].get("at") if turns else data.get("created")) or 0})
    out.sort(key=lambda c: c["at"], reverse=True)
    return out[:limit]
