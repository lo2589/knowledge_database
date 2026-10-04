"""Knowledge store on FastNode.

Three Node types, and the relations between them:

    source   one imported thing (a conversation, a document)
    unit     one piece cut from a source           unit  -in_source->  source
    card     one piece of knowledge you kept       card  -from_unit->  unit
                                                   card  -<relation>-> card

Card-to-card relations are the structure you build yourself; RELATIONS lists
the ones the UI offers, each read as "A <relation> B".
"""

from __future__ import annotations

import re
import threading
import time

import fastnode

from .importers import Document
from .split import split_markdown

RELATIONS = {
    "belongs_to": "属于",      # A 属于 B：B 是 A 的上一级。每张卡最多一个上级，组成层级树
    "prerequisite": "前提是",  # A 的前提是 B：先懂 B 才能懂 A
    "example_of": "是例子",    # A 是 B 的例子
    "refines": "细化了",       # A 细化了 B
    "contradicts": "矛盾",     # A 与 B 矛盾
    "related": "相关",
}
STATUSES = ("new", "kept", "dropped")
PARENT = "belongs_to"
# Did what the LLM said hold up? Set by you after checking against a source.
# "fixed": the LLM got it wrong and the card now says what the source says.
CHECKS = {"unchecked": "未核对", "ok": "对", "fixed": "改正过", "doubt": "存疑", "wrong": "错"}

# [[标题]] / [[标题|显示的字]] / [[#12]] inside a card body. Each one becomes a
# "mentions" link, kept in sync with the body on every save; it is separate
# from RELATIONS because the body, not the links panel, owns it.
MENTIONS = "mentions"
WIKILINK = re.compile(r"\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+))?\]\]")
_CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def wiki_targets(body: str) -> list[str]:
    """Targets of [[...]] in order, ignoring ones inside code."""
    seen, out = set(), []
    for m in WIKILINK.finditer(_CODE.sub(" ", body)):
        t = m.group(1).strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def now_ms() -> int:
    return int(time.time() * 1000)


def auto_title(body: str, limit: int = 40) -> str:
    """A title for a card nobody named: the first line that says something.
    A picked code block is named by its first line of code, not "[代码]"."""
    m = re.match(r"\s*(`{3,}|~{3,})([\w+-]*)\n(.*?)(\n\1|$)", body, re.S)
    if m:
        first = next((l.strip() for l in m.group(3).splitlines() if l.strip()), "")
        return plain(f"代码{('（' + m.group(2) + '）') if m.group(2) else ''}：{first}", limit)
    return plain(body, limit)


def plain(md: str, limit: int = 80) -> str:
    """One-line plain-text preview of Markdown, for FastNode's summary field."""
    text = re.sub(r"```.*?```", " [代码] ", md, flags=re.S)
    text = re.sub(r"^\s*\|?\s*:?-{2,}.*$", " ", text, flags=re.M)  # table separator rows
    text = re.sub(r"\$\$.*?\$\$|\\\[.*?\\\]", " [公式] ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " [图] ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*{1,3}|(?<!\w)_{1,3}(?=\S)|(?<=\S)_{1,3}(?!\w)|`", "", text)  # emphasis/code marks vanish, snake_case stays
    text = re.sub(r"^\s*(#{1,6}|>)\s*|\|", " ", text, flags=re.M)
    text = re.sub(r"\s+", " ", text).strip()
    return (text[: limit - 1] + "…") if len(text) > limit else (text or "（空）")


class KnowledgeStore:
    def __init__(self, path: str, root_title: str = "知识库"):
        self.db = fastnode.Store(path)
        self.lock = threading.Lock()
        with self.lock:
            self.root = self._ensure_root(root_title)
            self._adopt_orphans()

    # --- sources and units -------------------------------------------------

    def add_document(self, doc: Document) -> dict:
        """Store one document and cut it into units, in reading order."""
        with self.lock:
            sid = self.db.create({
                "type": "source",
                "summary": plain(doc.title, 120),
                "attrs": {"title": doc.title, "format": doc.format, "created": now_ms()},
            })
            nodes, order = [], 0
            for mi, msg in enumerate(doc.messages):
                speaker = msg.get("speaker")
                if speaker == "user":
                    # What you asked stays whole: it is context for what follows.
                    pieces = [("question", msg["text"].strip(), "")]
                else:
                    pieces = [(u.kind, u.text, u.section) for u in split_markdown(msg["text"])]
                for kind, text, section in pieces:
                    if not text:
                        continue
                    nodes.append({
                        "type": "unit",
                        "summary": plain(text),
                        "attrs": {"source": sid, "order": order, "message": mi, "speaker": speaker,
                                  "kind": kind, "text": text, "section": section, "status": "new"},
                    })
                    order += 1
            ids = self.db.create_many(nodes) if nodes else []
            for uid in ids:
                self.db.link(uid, "in_source", sid)
            return {"id": sid, "title": doc.title, "units": len(ids)}

    def sources(self) -> list[dict]:
        with self.lock:
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "source"},
                                 "order_by": {"field": "/created", "direction": "desc"},
                                 "include_data": True, "limit": 1000})
            out = []
            for n in res["nodes"]:
                counts = {}
                for st in STATUSES:
                    counts[st] = self.db.query({"predicate": {"op": "and", "args": [
                        {"op": "eq", "field": "/source", "value": n["id"]},
                        {"op": "eq", "field": "/status", "value": st}]}, "limit": 0})["total"]
                out.append({"id": n["id"], **n["attrs"], "counts": counts})
            return out

    def delete_source(self, sid: int) -> None:
        with self.lock:
            ids = self.db.query({"predicate": {"op": "eq", "field": "/source", "value": sid},
                                 "limit": 100000})["ids"]
            for uid in ids:
                self.db.delete(uid)
            self.db.delete(sid)

    def units(self, sid: int) -> list[dict]:
        with self.lock:
            res = self.db.query({"predicate": {"op": "and", "args": [
                {"op": "eq", "field": "@type", "value": "unit"},
                {"op": "eq", "field": "/source", "value": sid}]},
                "order_by": {"field": "/order"}, "include_data": True, "limit": 100000})
            out = []
            for n in res["nodes"]:
                cards = [l["id"] for l in self._links(n["id"])["in"] if l["relation"] == "from_unit"]
                out.append({"id": n["id"], **n["attrs"], "cards": cards})
            return out

    def update_unit(self, uid: int, *, status: str | None = None, text: str | None = None) -> dict:
        patch: dict = {}
        if status is not None:
            if status not in STATUSES:
                raise ValueError(f"status 只能是 {STATUSES}")
            patch["status"] = status
        if text is not None:
            if not text.strip():
                raise ValueError("内容不能为空")
            patch["text"] = text
        with self.lock:
            self._need(uid, "unit")
            body = {"attrs": patch}
            if text is not None:
                body["summary"] = plain(text)
            self.db.patch(uid, body)
            return self._get(uid)

    def merge_units(self, keep: int, absorb: int) -> dict:
        """Append unit `absorb` to unit `keep` and delete it: fixes a cut in the wrong place."""
        with self.lock:
            a, b = self._need(keep, "unit"), self._need(absorb, "unit")
            if a["attrs"]["source"] != b["attrs"]["source"]:
                raise ValueError("只能合并同一份资料里的句子")
            first, second = sorted([a, b], key=lambda n: n["attrs"]["order"])
            glue = "\n\n" if {first["attrs"]["kind"], second["attrs"]["kind"]} - {"sentence"} else (
                "" if _cjk_end(first["attrs"]["text"]) else " ")
            text = first["attrs"]["text"] + glue + second["attrs"]["text"]
            status = "kept" if "kept" in (a["attrs"]["status"], b["attrs"]["status"]) else first["attrs"]["status"]
            self.db.patch(first["id"], {"summary": plain(text), "attrs": {"text": text, "status": status,
                                                                          "kind": "sentence" if glue != "\n\n" else "block"}})
            for link in self._links(second["id"])["in"]:
                if link["relation"] == "from_unit":
                    self.db.link(link["id"], "from_unit", first["id"])
            self.db.delete(second["id"])
            return self._get(first["id"])

    # --- cards -------------------------------------------------------------

    def create_card(self, title: str, body: str, unit_ids: list[int], parent: int | None = None) -> dict:
        """New card, filed as the last child of `parent` (default: the root)."""
        if not body.strip():
            raise ValueError("卡片内容不能为空")
        with self.lock:
            for uid in unit_ids:
                self._need(uid, "unit")
            parent = self.root if parent is None else parent
            self._need(parent, "card")
            t = now_ms()
            title = title.strip() or auto_title(body)
            cid = self.db.create({"type": "card", "summary": plain(title, 120),
                                  "attrs": {"title": title, "body": body, "created": t, "updated": t}})
            for uid in unit_ids:
                self.db.link(cid, "from_unit", uid)
                self.db.patch(uid, {"attrs": {"status": "kept"}})
            self.db.link(cid, PARENT, parent)
            self.db.patch(cid, {"attrs": {"pos": len(self._children(parent)) - 1}})
            self._sync_mentions(cid, body)
            self._resolve_dangling(title)
            return self._card(cid)

    def update_card(self, cid: int, *, title: str | None = None, body: str | None = None) -> dict:
        with self.lock:
            self._need(cid, "card")
            attrs: dict = {"updated": now_ms()}
            patch: dict = {"attrs": attrs}
            if title is not None:
                attrs["title"] = title.strip() or "（无标题）"
                patch["summary"] = plain(attrs["title"], 120)
            if body is not None:
                if not body.strip():
                    raise ValueError("卡片内容不能为空")
                attrs["body"] = body
            old_title = self.db.get(cid, links="none")["attrs"]["title"]
            self.db.patch(cid, patch)
            if title is not None and attrs["title"] != old_title:
                self._rename_references(cid, old_title, attrs["title"])
                self._resolve_dangling(attrs["title"])
            if body is not None:
                self._sync_mentions(cid, body)
            return self._card(cid)

    def delete_card(self, cid: int) -> None:
        """Delete a card; its children take its place under its parent, in order."""
        with self.lock:
            self._need(cid, "card")
            if cid == self.root:
                raise ValueError("根节点不能删")
            parent = self._parent_of(cid)
            siblings = [c["id"] for c in self._children(parent)]
            kids = [c["id"] for c in self._children(cid)]
            at = siblings.index(cid)
            order = siblings[:at] + kids + siblings[at + 1:]
            self.db.delete(cid)
            for k in kids:
                self.db.link(k, PARENT, parent)
            for i, x in enumerate(order):
                self.db.patch(x, {"attrs": {"pos": i}})

    def card(self, cid: int) -> dict:
        with self.lock:
            self._need(cid, "card")
            return self._card(cid)

    def cards(self, q: str = "") -> list[dict]:
        with self.lock:
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                                 "order_by": {"field": "/updated", "direction": "desc"},
                                 "include_data": True, "limit": 100000})
            terms = [t.lower() for t in q.split() if t]
            out = []
            for n in res["nodes"]:
                a = n["attrs"]
                hay = (a["title"] + "\n" + a["body"]).lower()
                if all(t in hay for t in terms):
                    links = self._links(n["id"])
                    degree = sum(1 for l in links["out"] + links["in"] if l["relation"] in RELATIONS)
                    out.append({"id": n["id"], "title": a["title"], "body": a["body"],
                                "updated": a["updated"], "degree": degree})
            return out

    def link_cards(self, a: int, relation: str, b: int) -> dict:
        if relation not in RELATIONS:
            raise ValueError(f"关系只能是 {list(RELATIONS)}")
        if a == b:
            raise ValueError("卡片不能连到自己")
        with self.lock:
            self._need(a, "card")
            self._need(b, "card")
            if relation == PARENT:
                self._move(a, b)
            else:
                self.db.link(a, relation, b)
            return self._card(a)

    def unlink_cards(self, a: int, relation: str, b: int) -> dict:
        with self.lock:
            if relation == PARENT:
                # Never leave a card hanging: cutting it from its parent files it under the root.
                if self._parent_of(a) == b and b != self.root:
                    self._move(a, self.root)
            else:
                self.db.unlink(a, relation, b)
            return self._card(a)

    # --- hierarchy, placement, checking -------------------------------------

    def move_card(self, cid: int, parent: int | None, before: int | None = None) -> list[dict]:
        """Put a card under `parent` (None = the root), just before sibling `before`
        (None = last). This is the drag-and-drop in the tree. Both the old and
        the new sibling lists are renumbered 0..n-1, so orders never collide."""
        with self.lock:
            return self._move(cid, parent, before)

    def _move(self, cid: int, parent: int | None, before: int | None = None) -> list[dict]:
        """move_card without taking the lock (callers already hold it)."""
        self._need(cid, "card")
        parent = self.root if parent is None else parent
        self._need(parent, "card")
        old = self._parent_of(cid)
        self._set_parent(cid, parent)
        if old is not None and old != parent:
            for k, sid in enumerate(c["id"] for c in self._children(old)):
                self.db.patch(sid, {"attrs": {"pos": k}})
        siblings = [c for c in self._children(parent) if c["id"] != cid]
        ids = [c["id"] for c in siblings]
        ids.insert(ids.index(before) if before in ids else len(ids), cid)
        for k, sid in enumerate(ids):
            self.db.patch(sid, {"attrs": {"pos": k}})
        return self._tree()

    def tree(self) -> list[dict]:
        with self.lock:
            return self._tree()

    def place_card(self, cid: int, x: float | None, y: float | None) -> dict:
        """Where the card sits on the board; None, None takes it off the board."""
        with self.lock:
            self._need(cid, "card")
            self.db.patch(cid, {"attrs": {"x": x, "y": y}})
            return self._get(cid)

    def check_card(self, cid: int, check: str, note: str = "") -> dict:
        if check not in CHECKS:
            raise ValueError(f"核对状态只能是 {list(CHECKS)}")
        with self.lock:
            self._need(cid, "card")
            self.db.patch(cid, {"attrs": {"check": check, "check_note": note}})
            return self._card(cid)

    def board(self) -> dict:
        with self.lock:
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                                 "include_data": True, "limit": 100000})
            cards, edges = [], []
            for n in res["nodes"]:
                a = n["attrs"]
                cards.append({"id": n["id"], "title": a["title"], "body": a["body"],
                              "x": a.get("x"), "y": a.get("y"), "check": a.get("check", "unchecked")})
                for l in self._links(n["id"])["out"]:
                    if l["relation"] in RELATIONS or l["relation"] == MENTIONS:
                        edges.append({"from": n["id"], "to": l["id"], "relation": l["relation"]})
            return {"cards": cards, "edges": edges}

    def _parent_of(self, cid: int) -> int | None:
        ups = [l["id"] for l in self._links(cid)["out"] if l["relation"] == PARENT]
        return ups[0] if ups else None

    def _set_parent(self, cid: int, parent: int | None) -> None:
        if cid == self.root:
            raise ValueError("根节点不能挂到别处")
        parent = self.root if parent is None else parent
        if parent == cid:
            raise ValueError("卡片不能挂在自己下面")
        up = parent
        while up is not None:  # refuse cycles: the new parent must not sit under this card
            if up == cid:
                raise ValueError("不能挂到它自己的下级下面，会转圈")
            up = self._parent_of(up)
        for l in self._links(cid)["out"]:
            if l["relation"] == PARENT:
                self.db.unlink(cid, PARENT, l["id"])
        if parent is not None:
            self.db.link(cid, PARENT, parent)

    def _children(self, parent: int | None) -> list[dict]:
        parent = self.root if parent is None else parent
        ids = [l["id"] for l in self._links(parent)["in"] if l["relation"] == PARENT]
        nodes = [self.db.get(i, links="none") for i in ids]
        nodes.sort(key=lambda n: (n["attrs"].get("pos", 1e9), n["attrs"]["created"]))
        return [{"id": n["id"], **n["attrs"]} for n in nodes]

    def _tree(self) -> list[dict]:
        """The whole tree as one root node in a list (kept a list for callers)."""
        def build(parent):
            return [{"id": c["id"], "title": c["title"], "check": c.get("check", "unchecked"),
                     "children": build(c["id"])} for c in self._children(parent)]
        r = self.db.get(self.root, links="none")["attrs"]
        return [{"id": self.root, "title": r["title"], "check": r.get("check", "unchecked"),
                 "root": True, "children": build(self.root)}]

    def structure(self) -> dict:
        """The tree in the strict form (single root; parent, level, order and
        path for every card) plus the non-tree relations, as knowledge-tree
        viewers expect it. Raises if the stored tree breaks those rules."""
        with self.lock:
            entries, nodes, refs = {}, {}, []
            key = lambda i: f"c{i}"

            def walk(cid, parent, level, path):
                n = self.db.get(cid, links="none")
                a = n["attrs"]
                path = path + [key(cid)]
                nodes[key(cid)] = {"id": key(cid), "name": a["title"], "definition": a["body"],
                                   "node_type": "root" if cid == self.root else "card",
                                   "check": a.get("check", "unchecked")}
                kids = self._children(cid)
                entries[key(cid)] = {"parent": None if parent is None else key(parent), "level": level,
                                     "order": a.get("pos", 0) if parent is not None else 0, "path": path}
                for c in kids:
                    walk(c["id"], cid, level + 1, path)

            walk(self.root, None, 0, [])
            for nid in list(nodes):
                for l in self._links(int(nid[1:]))["out"]:
                    if (l["relation"] in RELATIONS and l["relation"] != PARENT) or l["relation"] == MENTIONS:
                        refs.append({"id": f"{nid}-{l['relation']}-c{l['id']}", "from": nid,
                                     "to": key(l["id"]), "relation": l["relation"]})
            data = {"root": key(self.root), "nodes": nodes,
                    "structure": {"root": key(self.root), "entries": entries}, "refs": refs,
                    "partners": [], "qa": [], "flows": {}}
            problems = check_structure(data)
            if problems:
                raise ValueError("层级结构不合格：" + "；".join(problems))
            return data

    def _ensure_root(self, title: str) -> int:
        ids = self.db.query({"predicate": {"op": "eq", "field": "/root", "value": True}, "limit": 2})["ids"]
        if ids:
            return ids[0]
        t = now_ms()
        return self.db.create({"type": "card", "summary": title,
                               "attrs": {"title": title, "body": "这个仓库所有知识的根。", "root": True,
                                         "created": t, "updated": t, "pos": 0}})

    def _adopt_orphans(self) -> None:
        """Every card but the root hangs somewhere; ones that do not (older
        libraries, deletes elsewhere) are filed at the end of the root."""
        res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                             "include_data": True, "limit": 100000})
        loose = sorted((n for n in res["nodes"] if n["id"] != self.root and self._parent_of(n["id"]) is None),
                       key=lambda n: (n["attrs"].get("pos", 1e9), n["attrs"]["created"]))
        if not loose:
            return
        base = len(self._children(self.root))
        for i, n in enumerate(loose):
            self.db.link(n["id"], PARENT, self.root)
            self.db.patch(n["id"], {"attrs": {"pos": base + i}})

    def relink_cards(self, a: int, relation: str, b: int, new_relation: str) -> dict:
        """Change what kind of relation an existing link is."""
        if new_relation not in RELATIONS:
            raise ValueError(f"关系只能是 {list(RELATIONS)}")
        with self.lock:
            if not any(l["relation"] == relation and l["id"] == b for l in self._links(a)["out"]):
                raise KeyError("这条关系不存在")
            if relation == PARENT:
                self._move(a, self.root)  # the old parent link becomes something else
            else:
                self.db.unlink(a, relation, b)
            if new_relation == PARENT:
                self._move(a, b)
            else:
                self.db.link(a, new_relation, b)
            return self._card(a)

    def rename_source(self, sid: int, title: str) -> dict:
        title = title.strip()
        if not title:
            raise ValueError("标题不能为空")
        with self.lock:
            self._need(sid, "source")
            self.db.patch(sid, {"summary": plain(title, 120), "attrs": {"title": title}})
            return self._get(sid)

    def graph(self) -> dict:
        with self.lock:
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                                 "include_data": True, "limit": 100000})
            nodes = [{"id": n["id"], "title": n["attrs"]["title"]} for n in res["nodes"]]
            edges = []
            for n in res["nodes"]:
                for l in self._links(n["id"])["out"]:
                    if l["relation"] in RELATIONS or l["relation"] == MENTIONS:
                        edges.append({"from": n["id"], "to": l["id"], "relation": l["relation"]})
            return {"nodes": nodes, "edges": edges}

    def stats(self) -> dict:
        with self.lock:
            count = lambda t: self.db.query({"predicate": {"op": "eq", "field": "@type", "value": t}, "limit": 0})["total"]
            return {"sources": count("source"), "units": count("unit"), "cards": count("card")}

    # --- internals ---------------------------------------------------------

    def _get(self, nid: int) -> dict:
        n = self.db.get(nid, links="none")
        return {"id": n["id"], **n["attrs"]}

    def _need(self, nid: int, kind: str) -> dict:
        n = self.db.get(nid, links="none")
        if n is None or n["type"] != kind:
            raise KeyError(f"没有这张{'卡片' if kind == 'card' else '记录'}：{nid}")
        return n

    def _links(self, nid: int) -> dict:
        n = self.db.get(nid, links="summary", link_limit=10000)
        return n["links"] if n else {"out": [], "in": []}

    def _card(self, cid: int) -> dict:
        n = self.db.get(cid, links="summary", link_limit=10000)
        a = n["attrs"]
        out_links = [{"relation": l["relation"], "id": l["id"], "title": l["summary"]}
                     for l in n["links"]["out"] if l["relation"] in RELATIONS]
        in_links = [{"relation": l["relation"], "id": l["id"], "title": l["summary"]}
                    for l in n["links"]["in"] if l["relation"] in RELATIONS]
        mentions_out = [{"id": l["id"], "title": l["summary"]} for l in n["links"]["out"] if l["relation"] == MENTIONS]
        mentions_in = [{"id": l["id"], "title": l["summary"]} for l in n["links"]["in"] if l["relation"] == MENTIONS]
        refs = {t: self._resolve(t) for t in wiki_targets(a["body"])}
        origins = []
        for l in n["links"]["out"]:
            if l["relation"] == "from_unit":
                u = self.db.get(l["id"], links="none")
                if u is None:
                    continue
                src = self.db.get(u["attrs"]["source"], links="none")
                sa = src["attrs"] if src else {}
                origins.append({"unit": u["id"], "text": u["attrs"]["text"], "source": u["attrs"]["source"],
                                "index": u["attrs"].get("order", 0),
                                "source_title": sa.get("title", "（资料已删除）"),
                                "dsh_session": sa.get("dsh_session"), "dsh_message": sa.get("dsh_message")})
        return {"id": cid, "title": a["title"], "body": a["body"], "created": a["created"],
                "updated": a["updated"], "out": out_links, "in": in_links, "origins": origins,
                "mentions_out": mentions_out, "mentions_in": mentions_in, "refs": refs,
                "check": a.get("check", "unchecked"), "check_note": a.get("check_note", ""),
                "x": a.get("x"), "y": a.get("y")}

    # --- one screen: chat on the left picks, the graph on the right shows -------

    def target(self) -> int:
        """The card new picks hang under (what the graph shows as 挂载点)."""
        with self.lock:
            t = self.db.get(self.root, links="none")["attrs"].get("target")
            n = self.db.get(t, links="none") if t else None
            return t if n and n["type"] == "card" else self.root

    def set_target(self, cid: int) -> int:
        with self.lock:
            self._need(cid, "card")
            self.db.patch(self.root, {"attrs": {"target": cid}})
            return cid

    def pick(self, text: str, origin: dict, parent: int | None = None, title: str = "") -> dict:
        """One sentence chosen in the chat becomes a card under `parent` (default:
        the current target). The sentence is kept as a unit of a source for its
        message, so the card links back to exactly where it was said."""
        text = (text or "").strip()
        if not text:
            raise ValueError("选中的内容是空的")
        if origin.get("kind") != "dsh" or not origin.get("message"):
            raise ValueError("origin 需要 kind=dsh 和 message")
        parent = parent if parent is not None else self.target()
        with self.lock:
            msg, sess, idx = str(origin["message"]), str(origin.get("session", "")), int(origin.get("index", 0))
            hit = self.db.query({"predicate": {"op": "and", "args": [
                {"op": "eq", "field": "@type", "value": "source"},
                {"op": "eq", "field": "/dsh_message", "value": msg}]}, "limit": 1})["ids"]
            if hit:
                sid = hit[0]
            else:
                q = (origin.get("question") or "对话").replace("\n", " ").strip()
                sid = self.db.create({"type": "source", "summary": plain(q, 120),
                                      "attrs": {"title": q[:80], "format": "dsh", "created": now_ms(),
                                                "dsh_session": sess, "dsh_message": msg, "cwd": origin.get("cwd", "")}})
            unit = self.db.query({"predicate": {"op": "and", "args": [
                {"op": "eq", "field": "/source", "value": sid},
                {"op": "eq", "field": "/order", "value": idx}]}, "limit": 1})["ids"]
            if unit:
                uid = unit[0]
            else:
                uid = self.db.create({"type": "unit", "summary": plain(text),
                                      "attrs": {"source": sid, "order": idx, "message": 0, "speaker": "assistant",
                                                "kind": "sentence", "text": text, "section": "", "status": "kept"}})
                self.db.link(uid, "in_source", sid)
        return self.create_card(title, text, [uid], parent)

    def picked(self, message: str) -> dict:
        """Which sentences of one chat message are already cards: {index: [card ids]}."""
        with self.lock:
            hit = self.db.query({"predicate": {"op": "and", "args": [
                {"op": "eq", "field": "@type", "value": "source"},
                {"op": "eq", "field": "/dsh_message", "value": str(message)}]}, "limit": 1})["ids"]
            if not hit:
                return {}
            out = {}
            for u in self.db.query({"predicate": {"op": "eq", "field": "/source", "value": hit[0]},
                                    "include_data": True, "limit": 100000})["nodes"]:
                cards = [l["id"] for l in self._links(u["id"])["in"] if l["relation"] == "from_unit"]
                if cards:
                    out[str(u["attrs"]["order"])] = cards
            return out

    def canvas(self) -> dict:
        """Everything the single screen draws, in one read: every card with its
        place in the tree, content, check, origins and relations; the imported
        sources (their sentences are pickable on the canvas); the target."""
        data = self.structure()  # validates the tree; raises if broken
        target = self.target()
        with self.lock:
            entries = data["structure"]["entries"]
            nodes = {}
            for key, e in entries.items():
                cid = int(key[1:])
                c = self._card(cid)
                kids = sorted((k for k, x in entries.items() if x["parent"] == key), key=lambda k: entries[k]["order"])
                original = "\n\n".join(o["text"] for o in c["origins"])
                nodes[cid] = {
                    "id": cid, "title": c["title"], "body": c["body"], "check": c["check"],
                    "check_note": c["check_note"], "level": e["level"], "order": e["order"],
                    "parent": int(e["parent"][1:]) if e["parent"] else None,
                    "children": [int(k[1:]) for k in kids], "root": cid == self.root,
                    "origins": c["origins"], "edited": bool(c["origins"]) and c["body"].strip() != original.strip(),
                    "out": c["out"], "in": c["in"], "mentions_out": c["mentions_out"], "refs": c["refs"],
                    "x": c["x"], "y": c["y"], "updated": c["updated"], "created": c["created"],
                }
            sources = []
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "source"},
                                 "order_by": {"field": "/created", "direction": "desc"}, "include_data": True, "limit": 1000})
            for n in res["nodes"]:
                if n["attrs"].get("format") == "dsh":
                    continue  # their text lives in the chat on the left
                sources.append({"id": n["id"], "title": n["attrs"]["title"]})
            return {"root": self.root, "target": target, "nodes": nodes, "sources": sources,
                    "refs": [{"from": int(r["from"][1:]), "to": int(r["to"][1:]), "relation": r["relation"]} for r in data["refs"]]}

    def _resolve(self, target: str) -> int | None:
        """[[target]] → card id: "#12" by id, otherwise by exact title."""
        if re.fullmatch(r"#\d+", target):
            n = self.db.get(int(target[1:]), links="none")
            return n["id"] if n and n["type"] == "card" else None
        ids = self.db.query({"predicate": {"op": "and", "args": [
            {"op": "eq", "field": "@type", "value": "card"},
            {"op": "eq", "field": "/title", "value": target}]}, "limit": 1})["ids"]
        return ids[0] if ids else None

    def _sync_mentions(self, cid: int, body: str) -> None:
        want = {t for t in (self._resolve(x) for x in wiki_targets(body)) if t and t != cid}
        have = {l["id"] for l in self._links(cid)["out"] if l["relation"] == MENTIONS}
        for t in have - want:
            self.db.unlink(cid, MENTIONS, t)
        for t in want - have:
            self.db.link(cid, MENTIONS, t)

    def _rename_references(self, cid: int, old: str, new: str) -> None:
        """Rewrite [[old]] in every card that mentions this one, so renames never break links."""
        pattern = re.compile(r"\[\[" + re.escape(old) + r"(\|[^\[\]\n]+)?\]\]")
        for l in self._links(cid)["in"]:
            if l["relation"] != MENTIONS:
                continue
            other = self.db.get(l["id"], links="none")
            body = pattern.sub(lambda m: "[[" + new + (m.group(1) or "") + "]]", other["attrs"]["body"])
            if body != other["attrs"]["body"]:
                self.db.patch(other["id"], {"attrs": {"body": body}})

    def _resolve_dangling(self, title: str) -> None:
        """A new (or renamed) card may be what some [[title]] elsewhere was waiting for."""
        res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                             "include_data": True, "limit": 100000})
        for n in res["nodes"]:
            if "[[" + title in n["attrs"]["body"]:
                self._sync_mentions(n["id"], n["attrs"]["body"])


def _cjk_end(text: str) -> bool:
    return bool(text) and ("　" <= text[-1] <= "鿿" or "＀" <= text[-1] <= "￯")


def check_structure(d: dict) -> list[str]:
    """The same rules a strict knowledge-tree viewer enforces before it draws."""
    errs, nodes = [], d.get("nodes", {})
    entries, root = d["structure"]["entries"], d["structure"]["root"]
    if root not in nodes or root not in entries:
        errs.append("ROOT_MISSING")
    elif entries[root]["parent"] is not None:
        errs.append("ROOT_PARENT_NOT_NULL")
    for nid, e in entries.items():
        if nid not in nodes:
            errs.append(f"STRUCTURE_NODE_MISSING {nid}")
        if nid != root and e["parent"] not in entries:
            errs.append(f"PARENT_MISSING {nid}")
        seen, chain, cur = set(), [], nid
        while cur is not None:
            if cur in seen:
                errs.append(f"CYCLE {nid}")
                break
            seen.add(cur)
            chain.append(cur)
            cur = entries.get(cur, {}).get("parent")
        path = list(reversed(chain))
        if e["level"] != len(path) - 1:
            errs.append(f"LEVEL_MISMATCH {nid}")
        if e["path"] != path:
            errs.append(f"PATH_MISMATCH {nid}")
    buckets: dict = {}
    for nid, e in entries.items():
        buckets.setdefault(e["parent"], []).append(e["order"])
    for p, orders in buckets.items():
        if len(set(orders)) != len(orders):
            errs.append(f"DUPLICATE_SIBLING_ORDER {p}")
    for r in d.get("refs", []):
        if r["from"] not in nodes or r["to"] not in nodes:
            errs.append(f"BROKEN_REF {r.get('id', '')}")
    return errs
