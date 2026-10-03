"""Knowledge repositories: one FastNode database file each, switchable at runtime.

New repositories live in one home directory; any existing repository file
elsewhere can be opened too and is remembered in the recent list. Opening a
file first checks that it is a FastNode database, so pointing at some other
SQLite file never gets FastNode's tables written into it.
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
    def __init__(self, home: Path, initial: Path | None = None):
        self.home = Path(home).expanduser().resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.state_path = self.home / "repos.json"
        self.lock = threading.Lock()
        self.state = self._load_state()
        target = Path(initial).expanduser().resolve() if initial else None
        if target is None and self.state.get("current") and Path(self.state["current"]).exists():
            target = Path(self.state["current"])
        if target is None:
            target = self.home / "我的知识库.db"
        self.path = target
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists() and self.path.stat().st_size and not is_fastnode_db(self.path):
            raise ValueError(f"{self.path} 不是知识库文件")
        self.store = KnowledgeStore(str(self.path), root_title=self.path.stem)
        self._remember(self.path)

    # --- queries ---------------------------------------------------------------

    def list(self) -> dict:
        with self.lock:
            paths = {p.resolve() for p in self.home.glob("*.db")}
            paths |= {Path(p) for p in self.state.get("recent", []) if Path(p).exists()}
            paths.add(self.path)
            repos = []
            for p in sorted(paths, key=lambda p: (p != self.path, p.stem)):
                st = p.stat() if p.exists() else None
                repos.append({"name": p.stem, "path": str(p), "current": p == self.path,
                              "inside_home": p.parent == self.home,
                              "size": st.st_size if st else 0, "mtime": int(st.st_mtime * 1000) if st else 0})
            return {"home": str(self.home), "current": str(self.path), "repos": repos}

    # --- changes ---------------------------------------------------------------

    def create(self, name: str) -> dict:
        name = (name or "").strip()
        if not name or re.search(r"[/\\:*?\"<>|]", name) or name.startswith("."):
            raise ValueError("仓库名不能为空，也不能带 / \\ : * ? \" < > |")
        path = self.home / f"{name}.db"
        if path.exists():
            raise ValueError(f"已经有叫「{name}」的仓库了")
        return self._switch(path)

    def open(self, path: str) -> dict:
        p = Path(path).expanduser()
        if p.is_dir():
            raise ValueError("这是个文件夹。要打开仓库请选 .db 文件；要把文件夹里的文档导进来，用「导入 → 文件夹」")
        if not p.exists():
            raise ValueError(f"找不到 {p}")
        if not is_fastnode_db(p):
            raise ValueError(f"{p} 不是知识库文件（不是 FastNode 数据库）")
        return self._switch(p.resolve())

    def forget(self, path: str) -> dict:
        """Drop a repository from the recent list (the file is left alone)."""
        with self.lock:
            p = str(Path(path).expanduser().resolve())
            if p == str(self.path):
                raise ValueError("正在用的仓库不能移出列表，先切到别的仓库")
            self.state["recent"] = [r for r in self.state.get("recent", []) if r != p]
            self._save_state()
        return self.list()

    def _switch(self, path: Path) -> dict:
        with self.lock:
            store = KnowledgeStore(str(path), root_title=path.stem)
            self.store, self.path = store, path
        self._remember(path)
        return self.list()

    # --- persistence -------------------------------------------------------------

    def _load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _remember(self, path: Path) -> None:
        with self.lock:
            p = str(path)
            recent = [p] + [r for r in self.state.get("recent", []) if r != p]
            self.state = {"current": p, "recent": recent[:30]}
            self._save_state()

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.state_path)
