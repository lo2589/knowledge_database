"""Local web app: JSON API over KnowledgeStore plus the static page.

Binds to 127.0.0.1 only; nothing here is meant to face a network.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .importers import Document, ImportErrorKM, list_claude_sessions, load_bytes, load_folder, load_text
from .repos import Repos
from .store import CHECKS, RELATIONS, KnowledgeStore

WEB = Path(__file__).parent / "web"
MAX_BODY = 64 * 1024 * 1024


class Api:
    def __init__(self, repos: Repos | KnowledgeStore, claude_root: Path | None = None):
        # A bare store (tests, embedding) is wrapped so the routes see one shape.
        self.repos = repos if isinstance(repos, Repos) else _Fixed(repos)
        self.claude_root = claude_root

    @property
    def store(self) -> KnowledgeStore:
        return self.repos.store

    def route(self, method: str, path: str, query: dict, body: dict):
        parts = [p for p in path.split("/") if p][1:]  # drop "api"
        num = lambda i: int(parts[i])

        # Repositories: which knowledge base the rest of the routes act on.
        if parts == ["repos"] and method == "GET":
            return self.repos.list()
        if parts == ["repos"] and method == "POST":
            return self.repos.create(body.get("name", ""))
        if parts == ["repos", "open"] and method == "POST":
            return self.repos.open(body.get("path", ""))
        if parts == ["repos", "forget"] and method == "POST":
            return self.repos.forget(body.get("path", ""))

        s = self.store
        if parts == ["meta"]:
            return {"relations": RELATIONS, "checks": CHECKS, "stats": s.stats(),
                    "repo": Path(self.repos.path).stem if self.repos.path else ""}
        if parts == ["sources"] and method == "GET":
            return s.sources()
        if parts == ["sources"] and method == "POST":
            return self._import(body)
        if len(parts) == 2 and parts[0] == "sources" and method == "DELETE":
            s.delete_source(num(1))
            return {"ok": True}
        if len(parts) == 2 and parts[0] == "sources" and method == "PATCH":
            return s.rename_source(num(1), body.get("title", ""))
        if len(parts) == 3 and parts[0] == "sources" and parts[2] == "units":
            return s.units(num(1))
        if parts == ["claude-sessions"]:
            return list_claude_sessions(self.claude_root)
        if len(parts) == 2 and parts[0] == "units" and method == "PATCH":
            return s.update_unit(num(1), status=body.get("status"), text=body.get("text"))
        if parts == ["units", "merge"] and method == "POST":
            return s.merge_units(int(body["keep"]), int(body["absorb"]))
        if parts == ["cards"] and method == "GET":
            return s.cards(query.get("q", [""])[0])
        if parts == ["cards"] and method == "POST":
            parent = body.get("parent")
            return s.create_card(body.get("title", ""), body.get("body", ""), [int(x) for x in body.get("units", [])],
                                 None if parent is None else int(parent))
        if parts == ["structure"]:
            return s.structure()
        if parts == ["tree"]:
            return s.tree()
        if parts == ["board"]:
            return s.board()
        if len(parts) == 3 and parts[0] == "cards" and method == "POST":
            cid, action = num(1), parts[2]
            if action == "move":
                parent, before = body.get("parent"), body.get("before")
                return s.move_card(cid, None if parent is None else int(parent), None if before is None else int(before))
            if action == "place":
                x, y = body.get("x"), body.get("y")
                return s.place_card(cid, None if x is None else float(x), None if y is None else float(y))
            if action == "check":
                return s.check_card(cid, body.get("check", ""), body.get("note", ""))
        if len(parts) == 2 and parts[0] == "cards":
            if method == "GET":
                return s.card(num(1))
            if method == "PATCH":
                return s.update_card(num(1), title=body.get("title"), body=body.get("body"))
            if method == "DELETE":
                s.delete_card(num(1))
                return {"ok": True}
        if parts == ["links"] and method == "POST":
            return s.link_cards(int(body["from"]), body["relation"], int(body["to"]))
        if parts == ["links"] and method == "PATCH":
            return s.relink_cards(int(body["from"]), body["relation"], int(body["to"]), body["new_relation"])
        if parts == ["links"] and method == "DELETE":
            return s.unlink_cards(int(body["from"]), body["relation"], int(body["to"]))
        if parts == ["graph"]:
            return s.graph()
        raise LookupError(f"没有这个接口：{method} {path}")

    def _import(self, body: dict) -> dict:
        skipped: list[str] = []
        if body.get("messages"):
            # Already split into turns by the caller (the dsh plugin): keep speakers.
            msgs = [{"speaker": m.get("speaker"), "text": str(m.get("text", ""))}
                    for m in body["messages"] if str(m.get("text", "")).strip()]
            if not msgs:
                raise ValueError("没有内容可导入")
            docs = [Document(body.get("title") or "对话", body.get("format") or "dsh", msgs)]
        elif body.get("folder"):
            docs, skipped = load_folder(body["folder"])
        elif body.get("claude_session"):
            path = Path(body["claude_session"]).expanduser()
            root = (self.claude_root or Path.home() / ".claude" / "projects").resolve()
            if root not in path.resolve().parents or path.suffix != ".jsonl":
                raise PermissionError("只能导入 ~/.claude/projects 下的会话记录")
            docs = load_bytes(path.name, path.read_bytes())
        elif body.get("file_b64") is not None:
            docs = load_bytes(body.get("filename", "file.txt"), base64.b64decode(body["file_b64"]))
        elif body.get("text", "").strip():
            docs = [load_text(body["text"], body.get("title", ""))]
        else:
            raise ValueError("没有内容可导入")
        if body.get("title") and len(docs) == 1:
            docs[0].title = body["title"]
        return {"sources": [self.store.add_document(d) for d in docs], "skipped": skipped}


class _Fixed:
    """A single store presented as a repository set of one."""

    def __init__(self, store: KnowledgeStore):
        self.store, self.path = store, ""

    def list(self) -> dict:
        return {"home": "", "current": "", "repos": []}

    def create(self, name):
        raise ValueError("这个实例只有一个库，不能新建仓库")

    open = forget = create


def make_handler(api: Api):
    class Handler(BaseHTTPRequestHandler):
        server_version = "known_manage"

        def log_message(self, fmt, *args):
            pass

        def _send(self, code: int, payload, ctype="application/json; charset=utf-8"):
            data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _handle(self, method: str):
            url = urlsplit(self.path)
            if not url.path.startswith("/api/"):
                return self._static(url.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    raise ValueError("文件太大（上限 64MB）")
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else {}
                self._send(200, api.route(method, url.path, parse_qs(url.query), body))
            except (ValueError, ImportErrorKM, KeyError, PermissionError, LookupError) as exc:
                code = 404 if isinstance(exc, (KeyError, LookupError)) else 403 if isinstance(exc, PermissionError) else 400
                msg = exc.args[0] if exc.args else str(exc)
                self._send(code, {"error": str(msg)})
            except Exception as exc:  # surface, never swallow
                traceback.print_exc()
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

        def _static(self, path: str):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = (WEB / rel).resolve()
            if WEB.resolve() not in target.parents or not target.is_file():
                return self._send(404, {"error": "not found"})
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PATCH(self):
            self._handle("PATCH")

        def do_DELETE(self):
            self._handle("DELETE")

    Handler.api = api
    return Handler


def serve(repos_home: str, db_path: str | None = None, port: int = 8790,
          claude_root: Path | None = None) -> ThreadingHTTPServer:
    api = Api(Repos(Path(repos_home), Path(db_path) if db_path else None), claude_root)
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(api))
