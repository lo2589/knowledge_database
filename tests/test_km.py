import json
import threading
import unittest
import urllib.request

from km.importers import chat_export, claude_code_transcript, html_to_markdown, load_text
from km.server import Api, make_handler
from km.split import split_markdown, split_sentences
from km.store import KnowledgeStore, plain


class SplitTests(unittest.TestCase):
    def kinds(self, text):
        return [(u.kind, u.text) for u in split_markdown(text)]

    def test_chinese_sentences(self):
        self.assertEqual(split_sentences("第一句。第二句！第三句？"), ["第一句。", "第二句！", "第三句？"])

    def test_semicolon_does_not_split(self):
        s = "五条：只讲一个点；说得精确；答得上来。"
        self.assertEqual(split_sentences(s), [s])

    def test_inline_math_and_code_are_never_cut(self):
        s = "公式 $a. b$ 和代码 `x. y` 都在一句里。下一句。"
        self.assertEqual(split_sentences(s), ["公式 $a. b$ 和代码 `x. y` 都在一句里。", "下一句。"])

    def test_dollar_amounts_are_not_math(self):
        self.assertEqual(split_sentences("价格是 $5 和 $10。第二句。"), ["价格是 $5 和 $10。", "第二句。"])

    def test_shell_variables_are_not_math(self):
        s = 'echo "$HOME/.local/bin:$PATH" 写进去。下一句。'
        self.assertEqual(split_sentences(s), ['echo "$HOME/.local/bin:$PATH" 写进去。', "下一句。"])

    def test_english_abbreviations_urls_decimals(self):
        s = "See e.g. https://arxiv.org/abs/1234.5678. Pi is 3.14 here. Done."
        self.assertEqual(split_sentences(s), ["See e.g. https://arxiv.org/abs/1234.5678.", "Pi is 3.14 here.", "Done."])

    def test_blocks_stay_whole(self):
        doc = "前言。\n\n$$\na = b.\nc = d.\n$$\n\n| a | b |\n|---|---|\n| 1. | 2. |\n\n```py\nx = 1. ; y = 2.\n```\n\n\\begin{align}\na &= b\n\\end{align}"
        self.assertEqual([k for k, _ in self.kinds(doc)], ["sentence", "math", "table", "code", "math"])

    def test_math_fence_is_math(self):
        self.assertEqual(self.kinds("```math\nx^2\n```")[0][0], "math")

    def test_list_items_and_quotes(self):
        units = self.kinds("- 第一条。第二句。\n- 另一条\n\n> 引用一。引用二。")
        self.assertEqual([t for _, t in units], ["第一条。", "第二句。", "另一条", "> 引用一。", "> 引用二。"])

    def test_heading_sets_section(self):
        units = split_markdown("# 标题\n\n正文。")
        self.assertEqual((units[1].kind, units[1].section), ("sentence", "标题"))

    def test_soft_wrapped_cjk_joins_without_space(self):
        self.assertEqual(split_sentences_from("第一行\n第二行。"), ["第一行第二行。"])


def split_sentences_from(text):
    return [u.text for u in split_markdown(text)]


class ImporterTests(unittest.TestCase):
    def test_claude_code_keeps_only_what_was_said(self):
        lines = [
            {"type": "ai-title", "aiTitle": "会话标题"},
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "<system-reminder>noise</system-reminder>问题？"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "secret"}, {"type": "text", "text": "回答一。"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "tool output"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "回答二。"}]}},
            {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "subagent"}},
        ]
        doc = claude_code_transcript("\n".join(json.dumps(l) for l in lines), "x")
        self.assertEqual(doc.title, "会话标题")
        self.assertEqual(doc.messages, [{"speaker": "user", "text": "问题？"},
                                        {"speaker": "assistant", "text": "回答一。\n\n回答二。"}])

    def test_chatgpt_follows_current_branch(self):
        conv = {"title": "T", "current_node": "c", "mapping": {
            "a": {"message": {"author": {"role": "user"}, "content": {"parts": ["问"]}}, "parent": None},
            "b": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["旧回答"]}}, "parent": "a"},
            "c": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["新回答 \\(x\\)"]}}, "parent": "a"},
        }}
        doc = chat_export([conv], "f")[0]
        self.assertEqual([m["text"] for m in doc.messages], ["问", "新回答 \\(x\\)"])

    def test_claude_ai_export(self):
        doc = chat_export([{"name": "N", "chat_messages": [{"sender": "human", "text": "hi"}, {"sender": "assistant", "text": "yo"}]}], "f")[0]
        self.assertEqual([m["speaker"] for m in doc.messages], ["user", "assistant"])

    def test_html_keeps_katex_mathjax_tables_code(self):
        html = ("<h2>T</h2><p>a <span class='katex'><span class='katex-mathml'><math><semantics>"
                "<annotation encoding='application/x-tex'>x^2</annotation></semantics></math></span>"
                "<span class='katex-html'>x2</span></span> b <script type='math/tex; mode=display'>\\int f</script></p>"
                "<table><tr><th>h</th></tr><tr><td>1</td></tr></table>"
                "<pre><code class='language-py'>print(1)</code></pre>")
        md = html_to_markdown(html)
        self.assertIn("## T", md)
        self.assertIn("$x^2$", md)
        self.assertIn("$$\n\\int f\n$$", md)
        self.assertIn("| h |", md)
        self.assertIn("```py\nprint(1)\n```", md)

    def test_pasted_html_is_converted(self):
        self.assertEqual(load_text("<p>hi <b>there</b></p><p>x</p>").format, "html")
        self.assertEqual(load_text("# md\n\ntext").format, "markdown")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.s = KnowledgeStore(":memory:")
        doc = load_text("# T\n\n第一句。第二句。\n\n$$x^2$$", "资料")
        doc.messages.insert(0, {"speaker": "user", "text": "我的问题？很长。"})
        self.sid = self.s.add_document(doc)["id"]
        self.units = self.s.units(self.sid)

    def test_split_order_and_question_kept_whole(self):
        self.assertEqual([(u["kind"], u["text"]) for u in self.units],
                         [("question", "我的问题？很长。"), ("heading", "# T"), ("sentence", "第一句。"),
                          ("sentence", "第二句。"), ("math", "$$x^2$$")])

    def test_status_counts(self):
        self.s.update_unit(self.units[2]["id"], status="kept")
        self.s.update_unit(self.units[3]["id"], status="dropped")
        self.assertEqual(self.s.sources()[0]["counts"], {"new": 3, "kept": 1, "dropped": 1})
        with self.assertRaises(ValueError):
            self.s.update_unit(self.units[2]["id"], status="bogus")

    def test_merge_moves_card_provenance(self):
        a, b = self.units[2], self.units[3]
        card = self.s.create_card("c", "body", [b["id"]])
        merged = self.s.merge_units(a["id"], b["id"])
        self.assertEqual(merged["text"], "第一句。第二句。")
        self.assertEqual(self.s.card(card["id"])["origins"][0]["unit"], a["id"])

    def test_cards_links_and_graph(self):
        c1 = self.s.create_card("", "梯度 $\\nabla$", [self.units[2]["id"]])
        c2 = self.s.create_card("主题", "优化", [])
        self.assertEqual(c1["title"], "梯度 $\\nabla$")
        self.s.link_cards(c1["id"], "belongs_to", c2["id"])
        self.assertEqual(self.s.card(c2["id"])["in"], [{"relation": "belongs_to", "id": c1["id"], "title": plain(c1["title"], 120)}])
        self.assertIn({"from": c1["id"], "to": c2["id"], "relation": "belongs_to"}, self.s.graph()["edges"])
        self.assertEqual([c["id"] for c in self.s.cards("优化")], [c2["id"]])
        with self.assertRaises(ValueError):
            self.s.link_cards(c1["id"], "made_up", c2["id"])
        with self.assertRaises(ValueError):
            self.s.link_cards(c1["id"], "related", c1["id"])
        self.s.unlink_cards(c1["id"], "belongs_to", c2["id"])  # cut loose → back under the root
        self.assertIn({"from": c1["id"], "to": self.s.root, "relation": "belongs_to"}, self.s.graph()["edges"])

    def test_card_survives_source_deletion(self):
        c = self.s.create_card("t", "b", [self.units[2]["id"]])
        self.s.delete_source(self.sid)
        self.assertEqual(self.s.card(c["id"])["origins"], [])
        self.assertEqual(self.s.stats(), {"sources": 0, "units": 0, "cards": 2})  # + the root


class StructureTests(unittest.TestCase):
    """Hierarchy, in-body links, checking and board placement."""

    def setUp(self):
        self.s = KnowledgeStore(":memory:")
        self.root = self.s.create_card("Transformer", "总览", [])["id"]
        self.attn = self.s.create_card("注意力", "$\\mathrm{softmax}(QK^T/\\sqrt{d_k})V$", [])["id"]
        self.mask = self.s.create_card("因果遮罩", "下三角", [])["id"]

    def titles(self, nodes):
        return [(n["title"], self.titles(n["children"])) for n in nodes]

    def test_move_builds_ordered_tree(self):
        self.s.move_card(self.attn, self.root)
        tree = self.s.move_card(self.mask, self.root, before=self.attn)
        self.assertEqual(self.titles(tree), [("知识库", [("Transformer", [("因果遮罩", []), ("注意力", [])])])])

    def test_one_parent_only_and_no_cycles(self):
        self.s.move_card(self.attn, self.root)
        self.s.link_cards(self.attn, "belongs_to", self.mask)  # re-filing replaces the parent
        self.assertEqual([l["id"] for l in self.s.card(self.attn)["out"] if l["relation"] == "belongs_to"], [self.mask])
        with self.assertRaises(ValueError):
            self.s.move_card(self.mask, self.attn)  # attn is under mask

    def test_deleting_a_card_puts_its_children_in_its_place(self):
        self.s.move_card(self.attn, self.root)
        self.s.move_card(self.mask, self.root)
        self.s.delete_card(self.root)  # "Transformer" was first under the root
        self.assertEqual(self.titles(self.s.tree()), [("知识库", [("注意力", []), ("因果遮罩", [])])])
        with self.assertRaises(ValueError):
            self.s.delete_card(self.s.root)

    def test_wikilinks_follow_body_and_renames(self):
        self.s.update_card(self.root, body="见 [[注意力]] 和 [[位置编码|位置]]，代码里的 `[[不算]]`")
        card = self.s.card(self.root)
        self.assertEqual(card["refs"], {"注意力": self.attn, "位置编码": None})
        pos = self.s.create_card("位置编码", "wpe", [])["id"]
        self.assertEqual(self.s.card(self.root)["refs"]["位置编码"], pos)
        self.s.update_card(self.attn, title="自注意力")
        self.assertIn("[[自注意力]]", self.s.card(self.root)["body"])
        self.s.update_card(self.root, body="不再提了")
        self.assertEqual(self.s.card(self.root)["mentions_out"], [])

    def test_check_and_place(self):
        c = self.s.check_card(self.attn, "doubt", "模型说除以 d_k，源码是 sqrt")
        self.assertEqual((c["check"], c["check_note"]), ("doubt", "模型说除以 d_k，源码是 sqrt"))
        with self.assertRaises(ValueError):
            self.s.check_card(self.attn, "maybe")
        self.s.place_card(self.attn, 120, 40)
        self.assertEqual({c["id"]: (c["x"], c["y"]) for c in self.s.board()["cards"]}[self.attn], (120, 40))
        self.s.place_card(self.attn, None, None)
        self.assertEqual({c["id"]: c["x"] for c in self.s.board()["cards"]}[self.attn], None)

    def test_structure_stays_strict_under_random_edits(self):
        import random
        from km.store import check_structure
        rnd = random.Random(7)
        ids = [self.root, self.attn, self.mask] + [self.s.create_card(f"卡{i}", "x", [])["id"] for i in range(12)]
        for _ in range(200):
            a, b = rnd.sample(ids, 2)
            op = rnd.choice(["move", "move", "link", "unlink", "relink", "delete"])
            try:
                if op == "move":
                    self.s.move_card(a, b, before=rnd.choice(ids + [None]))
                elif op == "link":
                    self.s.link_cards(a, "belongs_to", b)
                elif op == "unlink":
                    self.s.unlink_cards(a, "belongs_to", b)
                elif op == "relink":
                    self.s.link_cards(a, "related", b)
                    self.s.relink_cards(a, "related", b, "belongs_to")
                elif len(ids) > 5:
                    self.s.delete_card(a)
                    ids.remove(a)
            except ValueError:
                pass  # refused cycles / self-links are fine; corruption is not
            self.assertEqual(check_structure(self.s.structure()), [])
        data = self.s.structure()
        self.assertEqual(len(data["structure"]["entries"]), len(ids) + 1)  # + the root

    def test_structure_export_shape(self):
        self.s.move_card(self.attn, self.root)
        self.s.link_cards(self.mask, "prerequisite", self.attn)
        d = self.s.structure()
        e = d["structure"]["entries"][f"c{self.attn}"]
        self.assertEqual((e["level"], e["parent"], e["order"]), (2, f"c{self.root}", 0))
        self.assertEqual(e["path"], [f"c{self.s.root}", f"c{self.root}", f"c{self.attn}"])
        self.assertIn({"id": f"c{self.mask}-prerequisite-c{self.attn}", "from": f"c{self.mask}",
                       "to": f"c{self.attn}", "relation": "prerequisite"}, d["refs"])
        self.assertIn("softmax", d["nodes"][f"c{self.attn}"]["definition"])

    def test_relink_changes_kind(self):
        self.s.link_cards(self.mask, "related", self.attn)
        self.s.relink_cards(self.mask, "related", self.attn, "prerequisite")
        self.assertEqual([l["relation"] for l in self.s.card(self.mask)["out"] if l["relation"] != "belongs_to"], ["prerequisite"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        from http.server import ThreadingHTTPServer
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Api(KnowledgeStore(":memory:"))))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        # Never through HTTP_PROXY: this is loopback.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_flow(self):
        code, made = self.call("POST", "/api/sources", {"text": "第一句。第二句。", "title": "t"})
        self.assertEqual((code, made["sources"][0]["units"]), (200, 2))
        _, units = self.call("GET", f"/api/sources/{made['sources'][0]['id']}/units")
        code, card = self.call("POST", "/api/cards", {"title": "c", "body": units[0]["text"], "units": [units[0]["id"]]})
        self.assertEqual(code, 200)
        _, other = self.call("POST", "/api/cards", {"title": "d", "body": "x", "units": []})
        code, linked = self.call("POST", "/api/links", {"from": card["id"], "relation": "related", "to": other["id"]})
        self.assertEqual((code, [l["relation"] for l in linked["out"]]), (200, ["belongs_to", "related"]))

    def test_errors_are_plain_messages(self):
        self.assertEqual(self.call("POST", "/api/sources", {"text": "  "}), (400, {"error": "没有内容可导入"}))
        self.assertEqual(self.call("GET", "/api/cards/999")[0], 404)
        code, body = self.call("POST", "/api/sources", {"claude_session": "/etc/passwd"})
        self.assertEqual(code, 403)

    def test_static_is_confined(self):
        req = urllib.request.Request(self.base + "/../km/store.py")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.opener.open(req, timeout=5)
        self.assertEqual(ctx.exception.code, 404)
        with self.opener.open(self.base + "/", timeout=5) as r:
            self.assertIn("知识整理", r.read().decode())


if __name__ == "__main__":
    unittest.main()
