"""Local web app: JSON API over KnowledgeStore plus the static page.

Binds to 127.0.0.1 only; nothing here is meant to face a network.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from .importers import Document, ImportErrorKM, list_claude_sessions, load_bytes, load_folder, load_text
from .repos import Repos, is_fastnode_db
from .store import CHECKS, RELATIONS, KnowledgeStore

WEB = Path(__file__).parent / "web"
MAX_BODY = 64 * 1024 * 1024
# Where a page's self-report lands (see Api.route's "diag" branch).
DIAG_PATH = Path(__file__).resolve().parent.parent / "data" / "repos" / "diag.json"
# The whiteboard's own constraint report: formulas that are not shown whole.
SELFCHECK_PATH = Path(__file__).resolve().parent.parent / "data" / "repos" / "selfcheck.json"
# Every request, one line: who is talking to this server and about which
# session. Diagnostic only; KM_REQLOG=off turns it off.
REQLOG = None if os.environ.get("KM_REQLOG") == "off" else Path(__file__).resolve().parent.parent / "data" / "requests.log"


class Raw:
    """A response that is bytes, not JSON: the exported PDF."""

    def __init__(self, data: bytes, ctype: str, filename: str):
        self.data = data
        self.ctype = ctype
        self.filename = filename


class Api:
    def __init__(self, repos: Repos | KnowledgeStore, claude_root: Path | None = None):
        # A bare store (tests, embedding) is wrapped so the routes see one shape.
        self.repos = repos if isinstance(repos, Repos) else _Fixed(repos)
        self.claude_root = claude_root
        # The port this server is bound to: the PDF is rendered by a browser that
        # has to fetch the print page from here. serve() fills it in.
        self.port = 0

    def route(self, method: str, path: str, query: dict, body: dict):
        parts = [p for p in path.split("/") if p][1:]  # drop "api"
        num = lambda i: int(parts[i])
        # Every library route is about one dsh session (?s=…): the graph beside a
        # conversation is that conversation's own knowledge and nothing else.
        session = (query.get("s") or [""])[0] or ((body.get("origin") or {}).get("session") if parts == ["pick"] else "")
        title = (query.get("t") or [""])[0]
        sessioned = isinstance(self.repos, Repos)

        # A page reports what it sees of its own right column. Written to disk so
        # a panel that stays blank can be read off instead of guessed at.
        if parts == ["diag"]:
            payload = body or json.loads((query.get("d") or ["{}"])[0] or "{}")
            DIAG_PATH.parent.mkdir(parents=True, exist_ok=True)
            DIAG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            return {"ok": True, "saved": str(DIAG_PATH)}

        # The whiteboard reports the formulas it could not show whole. Empty list
        # means the constraint holds; anything else names the card.
        if parts == ["selfcheck"]:
            payload = body or json.loads((query.get("d") or ["{}"])[0] or "{}")
            SELFCHECK_PATH.parent.mkdir(parents=True, exist_ok=True)
            SELFCHECK_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            return {"ok": True}

        # The page's own version: newest mtime among the files it is made of.
        # The page polls this and reloads itself when it changes, so an open
        # panel never keeps running an older graph.js.
        if parts == ["version"]:
            stamps = [p.stat().st_mtime for p in WEB.rglob("*") if p.is_file()]
            return {"v": f"{max(stamps):.3f}" if stamps else "0"}

        # Two routes touch no library at all and therefore name no session:
        # splitting an answer into pickable sentences, and listing Claude Code
        # transcripts. Nothing else may run without a session.
        if parts == ["split"] and method == "POST":
            from .split import split_markdown
            return [{"kind": u.kind, "text": u.text} for u in split_markdown(str(body.get("text", "")))]
        if parts == ["claude-sessions"]:
            return list_claude_sessions(self.claude_root)

        if sessioned:
            s, repo_path = self.repos.store_for(session, title)
        else:
            s, repo_path = self.repos.store, None
        # One screen: the chat picks sentences, the graph shows and edits.
        if parts == ["canvas"]:
            return s.canvas()
        if parts == ["target"] and method == "GET":
            return {"target": s.target()}
        if parts == ["target"] and method == "POST":
            return {"target": s.set_target(int(body["id"]))}
        if parts == ["pick"] and method == "POST":
            parent = body.get("parent")
            return s.pick(body.get("text", ""), body.get("origin") or {}, None if parent is None else int(parent),
                          body.get("title", ""))
        if parts == ["picked"]:
            return s.picked(query.get("message", [""])[0])
        if parts == ["meta"]:
            return {"relations": RELATIONS, "checks": CHECKS, "stats": s.stats(),
                    "repo": Path(repo_path).stem if repo_path else ""}
        if parts == ["sources"] and method == "GET":
            return s.sources()
        if parts == ["sources"] and method == "POST":
            return self._import(body, s)
        if len(parts) == 2 and parts[0] == "sources" and method == "DELETE":
            return {"ok": True, **s.delete_source(num(1))}
        if len(parts) == 2 and parts[0] == "sources" and method == "PATCH":
            return s.rename_source(num(1), body.get("title", ""))
        if len(parts) == 3 and parts[0] == "sources" and parts[2] == "units":
            return s.units(num(1))
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
        if parts == ["cards", "merge"] and method == "POST":
            return s.merge_cards(int(body["target"]), int(body["source"]))
        # A real PDF: the print page is handed to the browser already on this
        # machine, because only a browser draws KaTeX, highlighted code and
        # Chinese exactly the way the print preview shows them.
        if parts == ["pdf"]:
            from .pdf import render_pdf
            qs = urlencode({"s": session, "t": title, "auto": "0"})
            data = render_pdf(f"http://127.0.0.1:{self.port}/print?{qs}")
            return Raw(data, "application/pdf", (Path(repo_path).stem if repo_path else "knowledge") + ".pdf")
        if parts == ["mermaid"]:
            return {"mermaid": s.mermaid(), "repo": Path(repo_path).stem if repo_path else ""}
        # One export, four shapes: the diagram (with or without the card's own
        # words), a Markdown document that reads like the tree, and the raw data.
        if parts == ["export"]:
            fmt = (query.get("fmt") or ["markdown"])[0]
            out = s.export(fmt)
            stem = Path(repo_path).stem if repo_path else "knowledge"
            return {"format": out["format"], "mime": out["mime"], "text": out["text"],
                    "filename": stem + out["ext"], "repo": stem}
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

    def _import(self, body: dict, store: KnowledgeStore) -> dict:
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
        elif body.get("path"):
            p = Path(str(body["path"])).expanduser()
            if p.is_dir():
                docs, skipped = load_folder(str(p))
            elif p.is_file():
                docs = load_bytes(p.name, p.read_bytes())
            else:
                raise ValueError(f"找不到 {p}")
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
        return {"sources": [store.add_document(d) for d in docs], "skipped": skipped}


class _Fixed:
    """A single store given explicitly (tests, embedding): no session, no list."""

    def __init__(self, store: KnowledgeStore):
        self.store = store


def make_handler(api: Api):
    class Handler(BaseHTTPRequestHandler):
        server_version = "known_manage"

        def log_message(self, fmt, *args):
            pass

        def _note(self, method: str, url) -> None:
            if REQLOG is None:
                return
            try:
                REQLOG.parent.mkdir(parents=True, exist_ok=True)
                query = ("?" + url.query) if url.query else ""
                agent = (self.headers.get("User-Agent") or "")[:48]
                with REQLOG.open("a", encoding="utf-8") as fh:
                    fh.write(f"{time.strftime('%H:%M:%S')} {method} {url.path}{query} ua={agent}\n")
            except Exception:
                pass

        def _send(self, code: int, payload, ctype="application/json; charset=utf-8", extra: dict | None = None):
            data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _handle(self, method: str):
            url = urlsplit(self.path)
            self._note(method, url)
            if not url.path.startswith("/api/"):
                return self._static(url.path)
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    raise ValueError("文件太大（上限 64MB）")
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else {}
                out = api.route(method, url.path, parse_qs(url.query), body)
                if isinstance(out, Raw):
                    name = quote(out.filename)
                    self._send(200, out.data, out.ctype, {"Content-Disposition": f"attachment; filename*=UTF-8''{name}"})
                else:
                    self._send(200, out)
            except (ValueError, ImportErrorKM, KeyError, PermissionError, LookupError) as exc:
                code = 404 if isinstance(exc, (KeyError, LookupError)) else 403 if isinstance(exc, PermissionError) else 400
                msg = exc.args[0] if exc.args else str(exc)
                self._send(code, {"error": str(msg)})
            except Exception as exc:  # surface, never swallow
                traceback.print_exc()
                self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

        def _static(self, path: str):
            rel = "index.html" if path in ("", "/") else "print.html" if path in ("/print", "/print/") else path.lstrip("/")
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
    """Serve the session libraries, or one explicitly named file instead.

    @param repos_home - folder holding one library per session.
    @param db_path - exactly this library file; omit it to serve sessions.
    @param port - loopback port.
    @param claude_root - where Claude Code transcripts are read from.
    @returns the bound server.
    @throws ValueError when db_path names a file that is not a knowledge base.
    """
    if db_path:
        path = Path(db_path).expanduser()
        if not path.exists() or not is_fastnode_db(path):
            raise ValueError(f"{path} 不是知识库文件（不是 FastNode 数据库）")
        api = Api(KnowledgeStore(str(path), root_title=path.stem), claude_root)
    else:
        api = Api(Repos(Path(repos_home)), claude_root)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(api))
    api.port = server.server_address[1]   # the PDF renderer fetches /print from here
    return server
