import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from km.importers import chat_export, claude_code_transcript, html_to_markdown, load_text
from km.repos import Repos
from km.server import Api, make_handler
from km.split import split_markdown, split_sentences
from km.store import KnowledgeStore, check_structure, plain


class SplitTests(unittest.TestCase):
    def kinds(self, text):
        return [(u.kind, u.text) for u in split_markdown(text)]

    def test_chinese_sentences(self):
        self.assertEqual(split_sentences("第一句。第二句！第三句？"), ["第一句。", "第二句！", "第三句？"])

    def test_semicolon_does_not_split(self):
        s = "五条：只讲一个点；说得精确；答得上来。"
        self.assertEqual(split_sentences(s), [s])

    def test_inline_labelled_records_are_independent(self):
        s = 'A：节点旁显示数量 B：前端过滤无效节点 C：后端按条件计数'
        self.assertEqual(split_sentences(s), [
            'A：节点旁显示数量', 'B：前端过滤无效节点', 'C：后端按条件计数'])
        self.assertEqual(split_sentences('只有 A：一个标签，不拆分。'),
                         ['只有 A：一个标签，不拆分。'])
        formatted = '**A**：显示数量 **B**：过滤节点 **C：**按条件计数'
        self.assertEqual(split_sentences(formatted),
                         ['**A**：显示数量', '**B**：过滤节点', '**C：**按条件计数'])

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
        self.assertEqual([k for k, _ in self.kinds(doc)], ["sentence", "math", "table_item", "code", "math"])

    def test_table_fields_are_independent_with_row_and_column_context(self):
        table = "| 模型 | 价格 | 上下文 |\n|:---|---:|---|\n| A | $5 | 8K |\n| B | — | 32K |"
        self.assertEqual(self.kinds(table), [
            ("table_item", "模型：A · 价格：$5"),
            ("table_item", "模型：A · 上下文：8K"),
            ("table_item", "模型：B · 上下文：32K"),
        ])

    def test_table_without_outer_pipes_and_protected_pipes(self):
        table = "字段 | 值\n--- | ---\n公式 | $|x|$\n代码 | `a|b`\n转义 | a\\|b"
        self.assertEqual([t for _, t in self.kinds(table)], [
            "字段：公式 · 值：$|x|$",
            "字段：代码 · 值：`a|b`",
            "字段：转义 · 值：a\\|b",
        ])

    def test_one_column_table_is_one_unit_per_row(self):
        self.assertEqual(self.kinds("| 事项 |\n|---|\n| 一 |\n| 二 |"),
                         [("table_item", "一"), ("table_item", "二")])

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

    def test_html_table_without_header_keeps_first_record(self):
        md = html_to_markdown("<table><tr><td>A</td><td>5</td></tr><tr><td>B</td><td>8</td></tr></table>")
        self.assertEqual([u.text for u in split_markdown(md)],
                         ["列1：A · 列2：5", "列1：B · 列2：8"])


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

    def test_table_import_keeps_only_selected_datum_in_card(self):
        sid = self.s.add_document(load_text("| 模型 | 价格 | 上下文 |\n|---|---|---|\n| A | $5 | 8K |", "表"))["id"]
        units = self.s.units(sid)
        self.assertEqual([u["text"] for u in units], ["模型：A · 价格：$5", "模型：A · 上下文：8K"])
        card = self.s.create_card("", units[0]["text"], [units[0]["id"]])
        self.assertNotIn("8K", card["body"])

    def test_existing_whole_table_is_split_without_losing_card_origin(self):
        sid = self.s.add_document(load_text("引言。", "旧资料"))["id"]
        whole = "| 模型 | 价格 | 上下文 |\n|---|---|---|\n| A | $5 | 8K |"
        uid = self.s.db.create({"type": "unit", "summary": "旧表", "attrs": {
            "source": sid, "order": 1, "message": 0, "speaker": None,
            "kind": "table", "text": whole, "section": "", "status": "new"}})
        self.s.db.link(uid, "in_source", sid)
        card = self.s.create_card("旧表", whole, [uid])
        with self.s.lock:
            self.s._migrate_structured_units()
            self.s._migrate_structured_units()
        units = self.s.units(sid)
        self.assertEqual([u["kind"] for u in units], ["sentence", "table_legacy", "table_item", "table_item"])
        self.assertEqual([u["text"] for u in units[2:]], ["模型：A · 价格：$5", "模型：A · 上下文：8K"])
        self.assertEqual(self.s.card(card["id"])["origins"][0]["unit"], uid)
        self.assertEqual(self.s.sources()[0]["counts"], {"new": 3, "kept": 0, "dropped": 0})
        self.assertEqual(self.s.stats()["units"], len(self.units) + 3)

    def test_existing_inline_records_are_split_without_losing_card_origin(self):
        sid = self.s.add_document(load_text("引言。", "旧资料"))["id"]
        whole = "A：保留有效节点 B：丢弃无效节点 C：按条件计数"
        uid = self.s.db.create({"type": "unit", "summary": "旧记录", "attrs": {
            "source": sid, "order": 1, "message": 0, "speaker": None,
            "kind": "sentence", "text": whole, "section": "", "status": "new"}})
        self.s.db.link(uid, "in_source", sid)
        card = self.s.create_card("旧记录", whole, [uid])
        with self.s.lock:
            self.s._migrate_structured_units()
            self.s._migrate_structured_units()
        units = self.s.units(sid)
        self.assertEqual([u["kind"] for u in units],
                         ["sentence", "sentence_legacy", "sentence", "sentence", "sentence"])
        self.assertEqual([u["text"] for u in units[2:]],
                         ["A：保留有效节点", "B：丢弃无效节点", "C：按条件计数"])
        self.assertEqual(self.s.card(card["id"])["origins"][0]["unit"], uid)
        self.assertEqual(self.s.sources()[0]["counts"], {"new": 4, "kept": 0, "dropped": 0})

    def test_picked_cards_follow_text_when_split_indices_shift(self):
        origin = {"kind": "dsh", "session": "s", "message": "m", "index": 7}
        old = self.s.pick("旧合并数据", origin)
        new = self.s.pick("新拆出的单条数据", origin)
        self.assertNotEqual(old["origins"][0]["unit"], new["origins"][0]["unit"])
        self.assertEqual(self.s.picked("m"), {
            "旧合并数据": [old["id"]], "新拆出的单条数据": [new["id"]]})

    def test_deleted_picked_card_can_be_picked_again(self):
        origin = {"kind": "dsh", "session": "s", "message": "m-delete", "index": 0}
        first = self.s.pick("可重新入库的一句。", origin)
        self.s.delete_card(first["id"])
        self.assertEqual(self.s.picked("m-delete"), {})
        second = self.s.pick("可重新入库的一句。", origin)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.s.picked("m-delete"), {"可重新入库的一句。": [second["id"]]})

    def test_a_picked_sentence_remembers_which_turn_it_was_said_in(self):
        # 原文跳转要知道那句话在第几轮：长会话里只有那一轮能把它翻回页面。
        origin = {"kind": "dsh", "session": "s", "message": "m-turn", "index": 0, "turn": 7}
        card = self.s.pick("这句话忘不掉了。", origin)
        self.assertEqual(card["origins"][0]["dsh_turn"], 7)
        # 同一个消息里再点另一句，轮次一样记得住
        again = self.s.pick("这句话也忘不掉了。", origin)
        self.assertEqual(again["origins"][0]["dsh_turn"], 7)
        # 没有轮次的老卡片不写假数据
        plain_card = self.s.pick("老卡片。", {"kind": "dsh", "session": "s", "message": "m-old", "index": 0})
        self.assertIsNone(plain_card["origins"][0]["dsh_turn"])

    def test_user_message_can_be_picked_with_its_own_source(self):
        card = self.s.pick("用户自己的信息。", {"kind": "dsh", "session": "s", "message": "user:42",
                                           "index": 0, "speaker": "user", "question": "用户自己的信息。"})
        origin = card["origins"][0]
        self.assertEqual(self.s.units(origin["source"])[0]["speaker"], "user")
        self.assertEqual(self.s.picked("user:42"), {"用户自己的信息。": [card["id"]]})
        self.assertEqual(origin["source_title"], "用户自己的信息。")

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

    def test_card_merge_keeps_origins_children_and_relations(self):
        target = self.s.create_card("保留", "内容甲", [self.units[2]["id"]])["id"]
        source = self.s.create_card("吸收", "内容乙", [self.units[3]["id"]])["id"]
        child = self.s.create_card("子项", "子内容", [], parent=source)["id"]
        neighbor = self.s.create_card("邻项", "见 [[吸收]]", [])["id"]
        self.s.link_cards(source, "prerequisite", neighbor)
        self.s.link_cards(neighbor, "related", source)
        merged = self.s.merge_cards(target, source)
        self.assertEqual(merged["body"], "内容甲\n\n内容乙")
        self.assertEqual({o["unit"] for o in merged["origins"]},
                         {self.units[2]["id"], self.units[3]["id"]})
        self.assertEqual(self.s.card(child)["out"][0]["id"], target)
        self.assertIn({"relation": "prerequisite", "id": neighbor, "title": "邻项"}, merged["out"])
        self.assertIn({"relation": "related", "id": neighbor, "title": "邻项"}, merged["in"])
        self.assertIn("[[保留]]", self.s.card(neighbor)["body"])
        with self.assertRaises(KeyError):
            self.s.card(source)
        self.assertEqual(check_structure(self.s.structure()), [])

    def test_card_merge_accepts_descendant_as_survivor(self):
        source = self.s.create_card("父", "上", [])["id"]
        middle = self.s.create_card("中", "中", [], parent=source)["id"]
        target = self.s.create_card("下", "下", [], parent=middle)["id"]
        self.s.merge_cards(target, source)
        self.assertEqual(self.s.card(middle)["out"][0]["id"], target)
        self.assertEqual(check_structure(self.s.structure()), [])

    def test_deleting_a_source_takes_its_cards_and_nothing_else(self):
        """A card kept from a source has no origin once the source is gone, so it goes too."""
        from_source = self.s.create_card("从资料来的", "b", [self.units[2]["id"]])
        written = self.s.create_card("自己写的", "b", [])
        child = self.s.create_card("从资料来的下级", "b", [], parent=from_source["id"])
        out = self.s.delete_source(self.sid)
        self.assertEqual(out, {"units": len(self.units), "cards": 1})
        self.assertEqual(self.s.stats(), {"sources": 0, "units": 0, "cards": 3})  # 根 + 自己写的 + 升上来的下级
        self.assertIn(written["id"], self.s.canvas()["nodes"])
        self.assertIn(child["id"], self.s.canvas()["nodes"])
        # the deleted card's child rose to where the card was, under the root
        self.assertEqual(self.s.card(child["id"])["out"][0]["id"], self.s.root)


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

    def test_relation_edits_are_idempotent_and_failed_cycle_keeps_link(self):
        self.s.link_cards(self.mask, "related", self.attn)
        self.s.link_cards(self.mask, "related", self.attn)
        self.assertEqual(sum(l["relation"] == "related" and l["id"] == self.attn
                             for l in self.s.card(self.mask)["out"]), 1)
        self.s.link_cards(self.mask, "prerequisite", self.attn)
        self.s.relink_cards(self.mask, "related", self.attn, "prerequisite")
        self.assertEqual(sum(l["relation"] == "prerequisite" and l["id"] == self.attn
                             for l in self.s.card(self.mask)["out"]), 1)
        self.s.move_card(self.attn, self.root)
        self.s.link_cards(self.root, "related", self.attn)
        with self.assertRaises(ValueError):
            self.s.relink_cards(self.root, "related", self.attn, "belongs_to")
        self.assertIn({"relation": "related", "id": self.attn, "title": self.s.card(self.attn)["title"]},
                      self.s.card(self.root)["out"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        from http.server import ThreadingHTTPServer
        api = Api(KnowledgeStore(":memory:"))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(api))
        api.port = self.server.server_port   # the PDF route prints /print from this server
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

    def test_deleting_a_source_takes_the_cards_made_from_it(self):
        # 「删了资料卡片还在」不是安全，是半截状态：卡片的原文已经没了。
        _, made = self.call("POST", "/api/sources", {"text": "第一句。第二句。", "title": "资料"})
        sid = made["sources"][0]["id"]
        _, units = self.call("GET", f"/api/sources/{sid}/units")
        card = self.call("POST", "/api/cards", {"title": "卡", "body": units[0]["text"], "units": [units[0]["id"]]})[1]
        keep = self.call("POST", "/api/cards", {"title": "自己写的", "body": "不是从资料来的", "units": []})[1]
        code, out = self.call("DELETE", f"/api/sources/{sid}")
        self.assertEqual((code, out["cards"], out["units"]), (200, 1, 2))
        self.assertEqual(self.call("GET", f"/api/cards/{card['id']}")[0], 404)
        self.assertEqual(self.call("GET", f"/api/cards/{keep['id']}")[0], 200)
        _, canvas = self.call("GET", "/api/canvas")
        self.assertEqual(sorted(canvas["nodes"]), ["1", str(keep["id"])])

    def test_mermaid_export_keeps_the_tree_and_the_relations(self):
        _, made = self.call("POST", "/api/sources", {"text": "第一句。第二句。", "title": "资料"})
        _, units = self.call("GET", f"/api/sources/{made['sources'][0]['id']}/units")
        parent = self.call("POST", "/api/cards", {"title": "父卡", "body": "父卡正文。", "units": [units[0]["id"]]})[1]
        child = self.call("POST", "/api/cards", {"title": "子卡", "body": "子卡正文。", "units": [units[1]["id"]], "parent": parent["id"]})[1]
        self.call("POST", "/api/links", {"from": child["id"], "relation": "prerequisite", "to": parent["id"]})
        self.call("POST", f"/api/cards/{child['id']}/check", {"check": "doubt", "note": "待查"})
        code, out = self.call("GET", "/api/mermaid")
        text = out["mermaid"]
        self.assertEqual(code, 200)
        self.assertTrue(text.startswith("graph TD"))
        self.assertIn('n%d["父卡"]' % parent["id"], text)
        self.assertIn('n%d["子卡"]' % child["id"], text)
        self.assertIn("n%d --> n%d" % (parent["id"], child["id"]), text)          # 严格层级
        self.assertIn("-.->|前提是|", text)                                        # 语义关系
        self.assertIn("class n%d doubt;" % child["id"], text)                      # 核对状态
        self.assertTrue(text.endswith("\n"))

    def test_export_serves_every_shape_of_the_library(self):
        _, made = self.call("POST", "/api/sources", {"text": "第一句。第二句。", "title": "资料"})
        _, units = self.call("GET", f"/api/sources/{made['sources'][0]['id']}/units")
        card = self.call("POST", "/api/cards", {"title": "父卡", "body": "父卡正文。", "units": [units[0]["id"]]})[1]
        child = self.call("POST", "/api/cards", {"title": "子卡", "body": "子卡正文。", "units": [units[1]["id"]], "parent": card["id"]})[1]
        self.call("POST", "/api/links", {"from": child["id"], "relation": "related", "to": card["id"]})

        code, md = self.call("GET", "/api/export?fmt=markdown")
        self.assertEqual((code, md["filename"].endswith(".md"), md["format"]), (200, True, "markdown"))
        # 树就是标题层级；正文、原文和关系都在里面
        self.assertIn("## 1 父卡", md["text"])
        self.assertIn("### 1.1 子卡", md["text"])
        self.assertIn("父卡正文。", md["text"])
        self.assertIn("**原文**（资料）：", md["text"])
        self.assertIn("> 第一句。", md["text"])
        self.assertIn("相关 → 父卡", md["text"])

        _, thin = self.call("GET", "/api/export?fmt=mermaid")
        _, fat = self.call("GET", "/api/export?fmt=mermaid-full")
        self.assertNotIn("父卡正文。", thin["text"])
        self.assertIn("父卡<br/>父卡正文。", fat["text"])

        _, data = self.call("GET", "/api/export?fmt=json")
        self.assertTrue(data["filename"].endswith(".json"))
        self.assertEqual(json.loads(data["text"])["root"], "c1")

        code, bad = self.call("GET", "/api/export?fmt=pdf")
        self.assertEqual(code, 400)
        self.assertIn("导出格式", bad["error"])

    def test_print_page_is_served_for_the_pdf(self):
        # /print is the page the PDF is made from, and the page a person prints
        # by hand when no browser can be driven.
        with self.opener.open(self.base + "/print", timeout=5) as r:
            page = r.read().decode()
        self.assertEqual(r.status, 200)
        self.assertIn("km-app", page)
        self.assertIn("打印 / 另存为 PDF", page)

    def test_pdf_export_returns_a_real_pdf(self):
        from km.pdf import find_browser
        if not find_browser():
            self.skipTest("这台机器上没有 Chrome / Chromium / Edge")
        _, made = self.call("POST", "/api/sources", {"text": "第一句。第二句。", "title": "资料"})
        _, units = self.call("GET", f"/api/sources/{made['sources'][0]['id']}/units")
        self.call("POST", "/api/cards", {"title": "卡", "body": units[0]["text"], "units": [units[0]["id"]]})
        with self.opener.open(self.base + "/api/pdf", timeout=180) as r:
            data = r.read()
            disposition = r.headers.get("Content-Disposition", "")
            ctype = r.headers.get("Content-Type", "")
        self.assertEqual((r.status, ctype), (200, "application/pdf"))
        self.assertTrue(data.startswith(b"%PDF-"), "得是真正的 PDF")
        self.assertGreater(len(data), 5000)
        self.assertIn("attachment", disposition)

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
            self.assertIn("known-manage", r.read().decode())


class SessionLibraryTests(unittest.TestCase):
    """The graph belongs to one session: no default library, no list, no switching."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.repos = Repos(self.home)

    def test_each_session_gets_its_own_library(self):
        _, first = self.repos.store_for("session-aaa", "标题一")
        _, second = self.repos.store_for("session-bbb", "标题二")
        self.assertNotEqual(first, second)
        self.assertTrue(first.exists() and second.exists())
        self.assertEqual(self.repos.store_for("session-aaa", "标题一")[1], first)

    def test_there_is_no_default_library(self):
        self.assertFalse(hasattr(self.repos, "path"))
        self.assertFalse(hasattr(self.repos, "store"))
        with self.assertRaises(ValueError):
            self.repos.store_for("")

    def test_old_state_drops_the_global_repository(self):
        (self.home / "repos.json").write_text(json.dumps(
            {"current": "/tmp/x.db", "recent": ["/tmp/x.db"], "sessions": {"session-a": "/tmp/a.db"}}))
        self.assertEqual(Repos(self.home).state, {"sessions": {"session-a": "/tmp/a.db"}})


class SessionApiTests(unittest.TestCase):
    """Over HTTP: a session is required, and the repository routes are gone."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Api(Repos(self.home))))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
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

    def test_routes_that_need_no_library_still_work_without_a_session(self):
        # Splitting an answer into pickable sentences and listing Claude Code
        # transcripts touch no library: they must not be caught by the session
        # rule (they were once, which killed 「逐句入库」 in the chat).
        code, units = self.call("POST", "/api/split", {"text": "第一句。第二句。"})
        self.assertEqual(code, 200)
        self.assertEqual([u["text"] for u in units], ["第一句。", "第二句。"])
        self.assertEqual(self.call("GET", "/api/claude-sessions")[0], 200)

    def test_a_library_route_needs_a_session(self):
        code, body = self.call("GET", "/api/canvas")
        self.assertEqual(code, 400)
        self.assertIn("只属于会话", body["error"])

    def test_repository_routes_are_gone(self):
        self.assertEqual(self.call("GET", "/api/repos?s=session-aaa")[0], 404)
        self.assertEqual(self.call("POST", "/api/repos/open?s=session-aaa", {"path": "/tmp/x.db"})[0], 404)
        self.assertEqual(self.call("POST", "/api/repos?s=session-aaa", {"name": "x"})[0], 404)
        # and with no session at all, every library route refuses the same way
        code, body = self.call("GET", "/api/repos")
        self.assertEqual(code, 400)
        self.assertIn("只属于会话", body["error"])

    def test_sessions_never_see_each_others_cards(self):
        code, mine = self.call("GET", "/api/canvas?s=session-aaa&t=jia")
        self.assertEqual(code, 200)
        self.call("POST", "/api/cards?s=session-aaa", {"title": "only-jia", "body": "x", "units": []})
        _, again = self.call("GET", "/api/canvas?s=session-aaa")
        _, other = self.call("GET", "/api/canvas?s=session-bbb&t=yi")
        self.assertEqual(again["nodes"]["1"]["title"], mine["nodes"]["1"]["title"])
        self.assertNotEqual(other["nodes"]["1"]["title"], mine["nodes"]["1"]["title"])
        self.assertEqual(len(other["nodes"]), 1)
        self.assertEqual(len(again["nodes"]), 2)


if __name__ == "__main__":
    unittest.main()
