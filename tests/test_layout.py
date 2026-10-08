"""The board's geometry, measured in a real browser.

These are the rules the whiteboard is not allowed to break, and the ones that were
broken when a level with many siblings was laid out as one endless row (84d106 was
11 857px wide, and 45 of its 60 cards sat outside the picture):

  1. a level wraps: the board's width stays inside a bound however many cards a
     level has, so no card is ever "thousands of pixels away";
  2. the active card and every one of its children are WHOLE on screen after the
     view is aimed at that branch;
  3. dragging a card away by hand stops at a wall instead of flying off;
  4. a card that an older version left far away is pulled back onto the tree, and
     the server is told, so it does not come back on the next open.

Needs Playwright with Chromium (the same one the other checks use). Without it the
whole file is skipped rather than pretending to pass.
"""

import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from km.repos import Repos
from km.server import Api, make_handler

try:
    from playwright.sync_api import sync_playwright
    HAVE_BROWSER = True
except Exception:                                     # pragma: no cover - env dependent
    HAVE_BROWSER = False

SESSION = "session-layout-probe"
FAR = 4200          # 画布宽度的上限：一排四张卡起步、一屏半封顶，再加父母居中的余量
DRAG_MAX = 1200     # graph.js 里手动摆放的墙


MEASURE = """(targetId) => {
  const layer = document.getElementById('layer');
  const cs = getComputedStyle(layer);
  const m = new DOMMatrix(cs.transform === 'none' ? '' : cs.transform);
  const k = m.a || 1, ox = m.e || 0, oy = m.f || 0;
  const info = el => {
    const r = el.getBoundingClientRect();
    return { id: +el.dataset.id, x: Math.round((r.left - ox) / k), y: Math.round((r.top - oy) / k),
             whole: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
  };
  const cards = [...layer.querySelectorAll('.node')].map(info);
  const xs = cards.map(c => c.x);
  const target = cards.find(c => c.id === targetId);
  const kids = (window.__bots || []).map(id => cards.find(c => c.id === id)).filter(Boolean);
  return { n: cards.length, k: +k.toFixed(3),
           boardW: xs.length ? Math.round(Math.max(...xs) - Math.min(...xs)) : 0,
           target: target || null,
           kidsWhole: kids.filter(c => c.whole).length, kidsTotal: kids.length, cards };
}"""

EXPAND = """() => {
  const seen = new Set(), b = [];
  for (const e of document.querySelectorAll('button[data-fold-child]')) {
    const id = e.dataset.foldChild;
    if (seen.has(id) || e.getAttribute('aria-expanded') !== 'false') continue;
    seen.add(id); b.push(e);
  }
  b.forEach(e => e.click()); return b.length;
}"""


@unittest.skipUnless(HAVE_BROWSER, "需要 Playwright + Chromium，跳过白板几何检查")
class BoardGeometryTests(unittest.TestCase):
    children = 14          # 一层里这么多兄弟：不折行的话就是 14 * 324 = 4536px 一大排

    @classmethod
    def setUpClass(cls):
        cls.home = Path(tempfile.mkdtemp())
        cls.api = Api(Repos(cls.home))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.api))
        cls.api.port = cls.server.server_port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.play = sync_playwright().start()
        try:
            cls.browser = cls.play.chromium.launch()
        except Exception as e:                        # pragma: no cover - env dependent
            cls.play.stop()
            cls.server.shutdown()
            raise unittest.SkipTest(f"Chromium 起不来：{e}")
        # 种一棵"一层很多兄弟"的树：白板要怎么排它，正是这里要量的
        store, _ = cls.api.repos.store_for(SESSION, "布局自检")
        cls.store = store
        cls.root = store.target()
        cls.kids = []
        for i in range(cls.children):
            card = store.create_card(f"探针卡 {i + 1}", f"第 {i + 1} 张", [], cls.root)
            cls.kids.append(card["id"])
        for i, kid in enumerate(cls.kids[:6]):
            for j in range(2):
                store.create_card(f"探针子卡 {i + 1}-{j + 1}", "x", [], kid)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.play.stop()
        cls.server.shutdown()

    def open_board(self):
        page = self.browser.new_page(viewport={"width": 1600, "height": 1000})
        page.goto(f"{self.base}/?s={SESSION}", wait_until="domcontentloaded")
        page.wait_for_selector(".node", timeout=20000)
        page.wait_for_timeout(1500)
        page.evaluate("(ids) => { window.__bots = ids; }", self.kids)
        return page

    def test_a_wide_level_wraps_instead_of_running_off(self):
        page = self.open_board()
        try:
            folded = page.evaluate(MEASURE, self.root)
            self.assertLessEqual(folded["boardW"], FAR,
                                 f"折叠态画布 {folded['boardW']}px：一层兄弟被排成一长排了")
            # 全部展开：一层里的卡片最多，这时候最容易被排成几千像素的一排
            for _ in range(12):
                if not page.evaluate(EXPAND):
                    break
                page.wait_for_timeout(400)
            full = page.evaluate(MEASURE, self.root)
            self.assertGreater(full["n"], self.children, "展开后应该看到更多卡片")
            self.assertLessEqual(full["boardW"], FAR,
                                 f"全部展开后画布 {full['boardW']}px：几千像素外又出现了")
        finally:
            page.close()

    def test_the_active_card_and_its_children_are_whole_on_screen(self):
        page = self.open_board()
        try:
            for _ in range(12):
                if not page.evaluate(EXPAND):
                    break
                page.wait_for_timeout(400)
            # 取景对着活跃分支，不是对着整棵树
            page.evaluate("() => { const t = document.getElementById('target'); if (t) t.click(); }")
            page.wait_for_timeout(1000)
            out = page.evaluate(MEASURE, self.root)
            self.assertTrue(out["target"] and out["target"]["whole"], "活跃那张卡没有整张在画面里")
            self.assertEqual(out["kidsWhole"], out["kidsTotal"],
                             f"{out['kidsTotal'] - out['kidsWhole']} 个子节点在画面外")
        finally:
            page.close()

    def test_a_hand_placed_card_stops_at_the_wall(self):
        page = self.open_board()
        try:
            kid = self.kids[0]
            before = next(c for c in page.evaluate(MEASURE, self.root)["cards"] if c["id"] == kid)
            handle = page.evaluate("""(id) => {
              const el = document.querySelector(`.node[data-id="${id}"]`);
              const h = el.querySelector('[data-drag]');
              const r = h.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }""", kid)
            page.mouse.move(handle["x"], handle["y"])
            page.mouse.down()
            for i in range(1, 21):        # 往右下拖约 3200px：远超那面墙
                page.mouse.move(handle["x"] + i * 160, handle["y"] + i * 40)
                page.wait_for_timeout(25)
            page.mouse.up()
            page.wait_for_timeout(1200)
            after = next(c for c in page.evaluate(MEASURE, self.root)["cards"] if c["id"] == kid)
            moved = ((after["x"] - before["x"]) ** 2 + (after["y"] - before["y"]) ** 2) ** 0.5
            self.assertGreater(moved, 200, "拖不动：卡片没有跟着指针走")
            self.assertLessEqual(moved + 60, DRAG_MAX * 1.35,
                                 f"卡片被拖到了 {moved:.0f}px 外，墙没拦住")
        finally:
            page.close()

    def test_a_card_left_far_away_is_pulled_back(self):
        far_card, store = self.kids[1], self.store
        store.place_card(far_card, 8000, 6000)
        page = self.open_board()
        try:
            out = page.evaluate(MEASURE, self.root)
            card = next(c for c in out["cards"] if c["id"] == far_card)
            self.assertLess(card["x"], FAR, "被摆到 8000px 外的卡片没有被拉回树上")
            self.assertLessEqual(out["boardW"], FAR, "一张远处的卡片把画布撑开了")
        finally:
            page.close()
        self.assertIsNone(store.card(far_card).get("x"),
                          "拉回来之后没有告诉服务端，下次打开它还会飘在那边")


if __name__ == "__main__":
    unittest.main()
