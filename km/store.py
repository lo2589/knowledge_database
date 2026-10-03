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
    "belongs_to": "属于",      # A 属于 B：B 是 A 的上级主题
    "prerequisite": "前提是",  # A 的前提是 B：先懂 B 才能懂 A
    "example_of": "是例子",    # A 是 B 的例子
    "refines": "细化了",       # A 细化了 B
    "contradicts": "矛盾",     # A 与 B 矛盾
    "related": "相关",
}
STATUSES = ("new", "kept", "dropped")


def now_ms() -> int:
    return int(time.time() * 1000)


def plain(md: str, limit: int = 80) -> str:
    """One-line plain-text preview of Markdown, for FastNode's summary field."""
    text = re.sub(r"```.*?```", " [代码] ", md, flags=re.S)
    text = re.sub(r"^\s*\|?\s*:?-{2,}.*$", " ", text, flags=re.M)  # table separator rows
    text = re.sub(r"\$\$.*?\$\$|\\\[.*?\\\]", " [公式] ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " [图] ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>*`|]+|(?<!\w)_+|_+(?!\w)", " ", text)  # keep snake_case intact
    text = re.sub(r"\s+", " ", text).strip()
    return (text[: limit - 1] + "…") if len(text) > limit else (text or "（空）")


class KnowledgeStore:
    def __init__(self, path: str):
        self.db = fastnode.Store(path)
        self.lock = threading.Lock()

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

    def create_card(self, title: str, body: str, unit_ids: list[int]) -> dict:
        if not body.strip():
            raise ValueError("卡片内容不能为空")
        with self.lock:
            for uid in unit_ids:
                self._need(uid, "unit")
            t = now_ms()
            title = title.strip() or plain(body, 40)
            cid = self.db.create({"type": "card", "summary": plain(title, 120),
                                  "attrs": {"title": title, "body": body, "created": t, "updated": t}})
            for uid in unit_ids:
                self.db.link(cid, "from_unit", uid)
                self.db.patch(uid, {"attrs": {"status": "kept"}})
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
            self.db.patch(cid, patch)
            return self._card(cid)

    def delete_card(self, cid: int) -> None:
        with self.lock:
            self._need(cid, "card")
            self.db.delete(cid)

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
            self.db.link(a, relation, b)
            return self._card(a)

    def unlink_cards(self, a: int, relation: str, b: int) -> dict:
        with self.lock:
            self.db.unlink(a, relation, b)
            return self._card(a)

    def graph(self) -> dict:
        with self.lock:
            res = self.db.query({"predicate": {"op": "eq", "field": "@type", "value": "card"},
                                 "include_data": True, "limit": 100000})
            nodes = [{"id": n["id"], "title": n["attrs"]["title"]} for n in res["nodes"]]
            edges = []
            for n in res["nodes"]:
                for l in self._links(n["id"])["out"]:
                    if l["relation"] in RELATIONS:
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
        origins = []
        for l in n["links"]["out"]:
            if l["relation"] == "from_unit":
                u = self.db.get(l["id"], links="none")
                if u is None:
                    continue
                src = self.db.get(u["attrs"]["source"], links="none")
                origins.append({"unit": u["id"], "text": u["attrs"]["text"], "source": u["attrs"]["source"],
                                "source_title": src["attrs"]["title"] if src else "（资料已删除）"})
        return {"id": cid, "title": a["title"], "body": a["body"], "created": a["created"],
                "updated": a["updated"], "out": out_links, "in": in_links, "origins": origins}


def _cjk_end(text: str) -> bool:
    return bool(text) and ("　" <= text[-1] <= "鿿" or "＀" <= text[-1] <= "￯")
