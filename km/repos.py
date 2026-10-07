"""One knowledge repository per dsh session, and nothing else.

There is deliberately no default repository and no repository list: a request
names its session and gets that session's own file. The file is created the
first time that session asks for it and is remembered afterwards, so reopening
the same conversation reopens the same library.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from pathlib import Path

from .store import KnowledgeStore

FASTNODE_TABLES = {"nodes", "postings", "links"}


def is_fastnode_db(path: Path) -> bool:
    """Whether a file is a knowledge base (never write FastNode tables into some other SQLite file)."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
        finally:
            con.close()
    except sqlite3.Error:
        return False
    return FASTNODE_TABLES <= tables


class Repos:
    """The session → library home. It has no library of its own."""

    def __init__(self, home: Path):
        self.home = Path(home).expanduser().resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.state_path = self.home / "repos.json"
        self.lock = threading.Lock()
        self.state = self._load_state()
        self.stores: dict[str, KnowledgeStore] = {}

    def store_for(self, session: str, title: str = "") -> tuple[KnowledgeStore, Path]:
        """That session's own library, created on first use.

        @param session - the dsh session id the caller is asking for.
        @param title - the session title, used once to name a brand-new file.
        @returns the open store and its path.
        @throws ValueError when the caller names no session.
        """
        if not session:
            raise ValueError("这个白板只属于会话：请求里没有 ?s=<会话 id>")
        path = self._session_path(session)
        if path is None:
            path = self._new_session_path(session, title)
            self._bind(session, path)
        return self._open_store(path), path

    def _session_path(self, session: str) -> Path | None:
        remembered = self.state.get("sessions", {}).get(session)
        if not remembered:
            return None
        path = Path(remembered)
        return path if path.exists() else None

    def _new_session_path(self, session: str, title: str) -> Path:
        stem = re.sub(r"[/\\:*?\"<>|\s]+", "", title or "")[:24]
        tail = re.sub(r"[^0-9a-zA-Z]", "", session)[-6:]
        path = self.home / (f"会话-{stem}-{tail}.db" if stem else f"会话-{tail}.db")
        n = 2
        while path.exists():
            path = self.home / f"会话-{stem}-{tail}-{n}.db"
            n += 1
        return path

    def _bind(self, session: str, path: Path) -> None:
        with self.lock:
            self.state.setdefault("sessions", {})[session] = str(path)
            self._save_state()

    def _open_store(self, path: Path) -> KnowledgeStore:
        key = str(Path(path).resolve())
        with self.lock:
            if key not in self.stores:
                self.stores[key] = KnowledgeStore(key, root_title=Path(path).stem)
            return self.stores[key]

    # --- persistence -------------------------------------------------------------

    def _load_state(self) -> dict:
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        # Older state files also carried a global "current" and a "recent" list
        # of switchable repositories. Only the session map is still meaningful.
        return {"sessions": state.get("sessions", {})} if isinstance(state, dict) else {}

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.state_path)
