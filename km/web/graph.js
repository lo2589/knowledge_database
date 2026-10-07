// The knowledge graph: the one screen next to the chat.
//
// Everything happens here, in place, with every card and source fully visible:
// the strict tree drawn top-down, editing, checking, relations,
// sub-information, moving by drag, imported sources whose sentences can be
// picked, and a link from every piece of knowledge back to where it was said.
(function () {
  const { mount, escapeHtml: esc } = window.KMRender;
  const $ = id => document.getElementById(id);
  const EMBEDDED = window.parent !== window;

  const REL = {
    belongs_to: "属于", prerequisite: "前提是", example_of: "是…的例子",
    refines: "细化了", contradicts: "与…矛盾", related: "相关", mentions: "正文提到",
  };
  const REL_IN = {
    prerequisite: "是它的前提", example_of: "的例子", refines: "细化了它", contradicts: "与它矛盾", related: "相关", mentions: "正文提到它",
  };
  // Muted on purpose: the tree is the picture, the relation colours only tag it.
  const COLOR = { prerequisite: "#9a7b46", example_of: "#4f7f66", refines: "#6f6796", contradicts: "#a4574d", related: "#8c8a84", mentions: "#b0ada6" };
  const DASH = { related: "2 4", mentions: "6 4" };
  const CHECK = { unchecked: "未核对", ok: "对", fixed: "改正过", doubt: "存疑", wrong: "错" };
  const CHECK_ICON = { unchecked: "·", ok: "✓", fixed: "✎", doubt: "?", wrong: "!" };
  const SECTIONS = [["content", "内容"], ["origin", "原文"], ["check", "核对"]];
  const TOOL_ICON = { rel: "⌁", child: "⌄", tree: "⌄", edit: "✎", target: "⌖", origin: "◉", check: "✓" };
  // The tree keeps the compact proportions it was drawn with — a top-down tree
  // reads as a whole. Only a genuinely narrow column changes anything: a slightly
  // narrower card, so one level still fits across instead of being scaled down.
  const BASE_CARD = EMBEDDED ? 190 : 300;
  let W_OPEN = BASE_CARD, HGAP = EMBEDDED ? 18 : 24, VGAP = EMBEDDED ? 34 : 56;
  let SOURCE_W = EMBEDDED ? 220 : 320;
  const MAX_W = () => Math.max(Math.round(W_OPEN * 2.4), 420);
  const paneWidth = () => $("stage").clientWidth || window.innerWidth || 900;
  function metrics() {
    const w = paneWidth();
    W_OPEN = Math.round(Math.max(140, Math.min(BASE_CARD, w * 0.42)));
    HGAP = EMBEDDED ? 18 : 24;
    VGAP = EMBEDDED ? 34 : 56;
    SOURCE_W = Math.round(Math.max(170, Math.min(EMBEDDED ? 220 : 320, w * 0.3)));
  }
  // A formula must be readable in full, so a card grows to fit its widest display
  // formula up to MAX_W; past that the block scrolls instead of being clipped.
  const fitW = new Map();

  // ---------------------------------------------------------------- state
  const S = {
    data: null,
    view: null,
    editing: null, writing: null, merging: null, hits: new Set(), units: new Map(), linkQ: {},
    closedRelations: new Set(), closedChildren: new Set(), closedTrees: new Set(), selectedRef: null, relAdding: null,
    selected: null, mergeArmed: null, linkFrom: null, originsOpen: new Set(), hitList: [], hitIndex: -1, hitQuery: null,
    outlineClosed: EMBEDDED,
    // The graph opens on the hierarchy map itself — the tree drawn top-down is
    // the product surface. The Outliner is one click away on the mode button.
    mode: "map",
    relationIndexOpen: false,
    quickCardOpen: false,
  };

  // The dsh session this graph belongs to: every request names it, so the
  // server answers from that session's own repository.
  const params = new URLSearchParams(location.search);
  S.session = params.get("s") || "";
  S.sessionTitle = params.get("t") || "";

  // ------------------------------------------------------------ remembering
  // A session's board is remembered per session: which mode, where the canvas
  // was, what was folded, what was open, which card was selected. This page
  // reloads itself when its own files change and the panel is resized all the
  // time, so a reload that throws you back to the top of the tree loses your
  // place every few seconds.
  const stateKey = () => "g-state:" + (S.session || "local");
  let stateTimer;
  const numSet = v => new Set(Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
  function saveState() {
    try {
      localStorage.setItem(stateKey(), JSON.stringify({
        // The version guards against a layout change handing back a view that
        // was remembered for a different geometry.
        v: 3, mode: S.mode, view: S.view, needFit: !!S.needFit, selected: S.selected,
        closedChildren: [...S.closedChildren], closedTrees: [...S.closedTrees],
        closedRelations: [...S.closedRelations], originsOpen: [...S.originsOpen],
        outlineClosed: S.outlineClosed, q: $("search") ? $("search").value : "",
      }));
    } catch (e) { /* a full or blocked store must never break the board */ }
  }
  function saveStateSoon() { clearTimeout(stateTimer); stateTimer = setTimeout(saveState, 200); }
  function restoreState() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(stateKey()) || "null"); } catch (e) { raw = null; }
    S.closedChildren = numSet(raw && raw.closedChildren);
    S.closedTrees = numSet(raw && raw.closedTrees);
    S.closedRelations = numSet(raw && raw.closedRelations);
    S.originsOpen = numSet(raw && raw.originsOpen);
    S.selected = raw && Number.isFinite(raw.selected) ? raw.selected : null;
    if (raw && (raw.mode === "map" || raw.mode === "outline")) S.mode = raw.mode;
    S.outlineClosed = raw && raw.outlineClosed !== undefined ? !!raw.outlineClosed : EMBEDDED;
    if (raw && raw.q && $("search")) $("search").value = raw.q;
    const fresh = raw && raw.v === 3;   // a view from an older framing is not this framing
    S.view = fresh && raw.view && Number.isFinite(raw.view.k) && raw.view.k > 0
      ? { k: raw.view.k, x: raw.view.x || 0, y: raw.view.y || 0 } : null;
    // No remembered place: aim at the active branch rather than the whole map.
    S.needFocus = !S.view;
    S.needFit = false;
  }
  S.view = null;
  S.needFocus = true;
  S.needFit = false;
  restoreState();
  // Every request names this session, so the server answers from that session's
  // own library; the PDF route hands the same URL to a browser to print.
  function apiUrl(path) {
    let url = "/api/" + path;
    if (S.session) url += (url.includes("?") ? "&" : "?") + "s=" + encodeURIComponent(S.session) + "&t=" + encodeURIComponent(S.sessionTitle);
    return url;
  }
  async function api(method, path, body) {
    const r = await fetch(apiUrl(path), { method, headers: body ? { "Content-Type": "application/json" } : {},
                                          body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({ error: "HTTP " + r.status }));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }
  let msgTimer;
  function say(text, ok) {
    const m = $("msg");
    m.textContent = text; m.className = ok ? "ok" : ""; m.hidden = false;
    clearTimeout(msgTimer); msgTimer = setTimeout(() => (m.hidden = true), ok ? 2200 : 6000);
  }
  const fail = e => say("出错了：" + e.message);
  const node = id => S.data.nodes[id];

  // ------------------------------------------------------------- loading
  let retryTimer = null;
  async function reload(focus) {
    clearTimeout(retryTimer);
    try { S.data = await api("GET", "canvas"); }
    catch (e) {
      // The server may be restarting. Keep the last graph in place instead of
      // clearing the whiteboard; on the first load show a visible retry state.
      say("知识图服务正在连接，3 秒后自动重试…", false);
      if (!S.data && !$('layer').querySelector('.node')) {
        let hint = $("stage").querySelector("#loading-hint");
        if (!hint) { hint = document.createElement("div"); hint.id = "loading-hint"; $("stage").appendChild(hint); }
        hint.innerHTML = `<b>知识图正在连接</b><br>数据回来后会自动显示，不会清空当前画面。`;
      }
      retryTimer = setTimeout(() => reload(focus), 3000);
      return;
    }
    $("stage").querySelector("#loading-hint")?.remove();
    if (EMBEDDED && !S.ready) { S.ready = true; window.parent.postMessage({ source: "km-app", type: "ready" }, "*"); }
    await Promise.all(S.data.sources.filter(s => !S.units.has(s.id)).map(async s => {
      S.units.set(s.id, await api("GET", `sources/${s.id}/units`).catch(() => []));
    }));
    // A remembered search is still a search: the hits come back marked, without
    // yanking the canvas to the first one.
    if ($("search").value.trim() && !S.hitList.length) refreshHits();
    render();
    if (focus && node(focus)) { showNew(focus); }
  }
  // Bring one card into sight: open every ancestor that was folded away.
  function reveal(id) {
    for (let p = node(id) && node(id).parent; p != null; p = node(p).parent) {
      S.closedChildren.delete(p);
      S.closedTrees.delete(p);
    }
  }

  // 活跃的那一段占住视野：它按 1:1 显示（缩到能放下它自己为止），别的分支不缩、也不抢
  // 镜头——展开着的它们就落在视野边上，想看就平移过去，而不是把整张图缩成一小团。
  function subtreeBox(id) {
    const box = id => { const el = $("layer").querySelector(`.node[data-id="${id}"]`); return el && {
      x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }; };
    const start = box(id);
    if (!start) return null;
    // 上级那一层也算进来：活跃的卡不能孤零零悬在一片空白里
    const up = node(id).parent;
    const parentBox = up != null ? box(up) : null;
    let out = { x: start.x, y: start.y, right: start.x + start.w, bottom: start.y + start.h };
    if (parentBox) {
      out.x = Math.min(out.x, parentBox.x); out.y = Math.min(out.y, parentBox.y);
      out.right = Math.max(out.right, parentBox.x + parentBox.w);
      out.bottom = Math.max(out.bottom, parentBox.y + parentBox.h);
    }
    const folded = i => S.closedChildren.has(i) || S.closedTrees.has(i);
    const walk = i => {
      if (folded(i)) return;
      node(i).children.forEach(c => {
        const b = box(c);
        if (b) {
          out.x = Math.min(out.x, b.x); out.y = Math.min(out.y, b.y);
          out.right = Math.max(out.right, b.x + b.w); out.bottom = Math.max(out.bottom, b.y + b.h);
        }
        walk(c);
      });
    };
    walk(id);
    return { x: out.x, y: out.y, w: out.right - out.x, h: out.bottom - out.y };
  }

  function focusActive() {
    const id = S.data && S.data.target;
    const spot = id != null ? subtreeBox(id) : null;
    const st = $("stage");
    S.needFit = false;
    S.needFocus = false;
    if (!spot || !st.clientWidth) return fitAll();
    const pad = 26;
    const k = Math.max(MIN_K, Math.min(1, (st.clientWidth - pad * 2) / Math.max(1, spot.w),
                                        (st.clientHeight - pad * 2) / Math.max(1, spot.h)));
    S.view = { k, x: pad - spot.x * k, y: pad - spot.y * k };
    applyView();
  }

  // Jump between the hits, the way a text editor's find does: next and previous,
  // with a counter so you know where you are among them.
  function gotoHit(step) {
    const n = S.hitList.length;
    if (!n) {
      const q = $("search").value.trim();
      return say(q ? `「${q}」没有命中。搜的是：卡片标题、正文、原文、核对依据，以及导入资料里的句子`
                   : "先在顶上那个搜索框里打一个词，再按回车跳下一个");
    }
    S.hitIndex = (S.hitIndex + step + n) % n;
    showHit(S.hitList[S.hitIndex]);
    showHitCount();
  }

  function showHitCount() {
    const box = $("hit-count");
    if (!box) return;
    const n = S.hitList.length;
    box.textContent = n ? `${S.hitIndex + 1} / ${n}` : "";
    // 折叠起来的分支照样算命中：把它们数出来，别让人以为"搜不到"
    const hidden = n ? S.hitList.filter(h => h.kind === "card" && ancestorFolded(h.id)).length : 0;
    box.title = n ? (hidden ? `共 ${n} 处命中，其中 ${hidden} 处在折叠的分支里（回车跳过去会自动展开）`
                            : `共 ${n} 处命中`) : "";
    $("hit-prev").disabled = !n;
    $("hit-next").disabled = !n;
  }

  // 这张卡是不是藏在某个折起来的分支里
  function ancestorFolded(id) {
    for (let p = node(id) && node(id).parent; p != null; p = node(p).parent) {
      if (S.closedChildren.has(p) || S.closedTrees.has(p)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- drawing
  function visible() {
    const out = [], q = [S.data.root];
    while (q.length) {
      const id = q.shift(); out.push(id);
      if (!S.closedTrees.has(id) && !S.closedChildren.has(id)) q.push(...node(id).children);
    }
    return out;
  }
  const width = id => Math.min(MAX_W(), Math.max(W_OPEN, fitW.get(id) || 0));

  // What a card shows on its face: the original sentence it came from, or — once
  // the card carries more than that (edited, or fused with another card) — the
  // body itself, because that is where the merged text lives.
  function faceText(n) {
    // Any card carrying more than one piece of text — edited, or fused with
    // another card — shows the body, because that is where all of it lives.
    if (n.edited || n.origins.length > 1) return n.body;
    return n.origins.length ? n.origins[0].text : n.body;
  }

  function nodeHtml(id) {
    const n = node(id), ch = n.children.length;
    const cls = ["node", n.check, n.root ? "root" : "", id === S.data.target ? "target" : "", id === S.selected ? "selected" : "", id === S.linkFrom ? "linking" : "", S.hits.has(id) ? "hit" : ""].join(" ");
    if (n.root) {
      return `<div class="${cls}" data-id="${id}" style="width:${width(id)}px">
        <div class="root-only" data-drag="${id}"><span class="root-session">${esc(n.title)}</span><span class="root-id">#${id}</span></div>
        <div class="node-tools foot mini-tools root-tools"><button class="icon-btn fold ${S.closedChildren.has(id) ? "active" : ""}" data-fold-child="${id}" aria-expanded="${!S.closedChildren.has(id)}" title="${S.closedChildren.has(id) ? "展开下级（" + ch + "）" : "折叠下级（" + ch + "）"}" aria-label="${S.closedChildren.has(id) ? "展开下级" : "折叠下级"}"${ch ? "" : " disabled"}>${S.closedChildren.has(id) ? "+" : "−"}<sup>${ch || ""}</sup></button></div>
        ${ch ? `<button class="stem${S.closedChildren.has(id) ? " closed" : ""}" data-fold-child="${id}" title="${S.closedChildren.has(id) ? "展开下面 " + ch + " 项" : "折叠下面的 " + ch + " 项"}" aria-label="${S.closedChildren.has(id) ? "展开下级" : "折叠下级"}" aria-expanded="${!S.closedChildren.has(id)}">${S.closedChildren.has(id) ? "+" : "−"}</button>` : ""}
      </div>`;
    }
    let h = `<div class="${cls}" data-id="${id}" style="width:${width(id)}px">
      <div class="card-body" data-drag="${id}" title="点一下设为挂载点 · 点两下改内容">
        <span class="ttl" data-ttl="${id}" title="双击改标题"></span>
        ${S.editing === id ? sectionHtml(id, "content") : `<div class="original-only md" data-original="${id}"></div>`}
        ${S.originsOpen.has(id) ? `<div class="origins-open">${sectionHtml(id, "origin")}</div>` : ""}
      </div>`;
      const relCount = n.out.length + n.in.filter(l => l.relation !== "belongs_to").length + n.mentions_out.length;
      const relClosed = S.closedRelations.has(id), childClosed = S.closedChildren.has(id) || S.closedTrees.has(id);
      h += `<div class="node-tools foot mini-tools">
        <button class="icon-btn ${id === S.data.target ? "active" : ""}" data-target="${id}" title="${id === S.data.target ? "当前挂载点" : "设为挂载点"}" aria-label="${id === S.data.target ? "当前挂载点" : "设为挂载点"}">${TOOL_ICON.target}</button>
        <button class="icon-btn" data-edit="${id}" title="改正文" aria-label="改正文">✎</button>
        ${n.origins.length ? `<button class="icon-btn" data-jumpcard="${id}" title="跳到原文（在左边的对话里定位到这句话）" aria-label="跳到原文">↗</button>` : ""}
        <button class="icon-btn ${S.originsOpen.has(id) ? "active" : ""}" data-origins="${id}" title="${S.originsOpen.has(id) ? "收起原文" : "看原文（" + n.origins.length + " 条）"}" aria-label="看原文">${TOOL_ICON.origin}<sup>${n.origins.length || ""}</sup></button>
        <button class="icon-btn ${relClosed ? "active" : ""}" data-fold-rel="${id}" aria-expanded="${!relClosed}" title="${relClosed ? "展开关系连线" : "折叠关系连线"}" aria-label="${relClosed ? "展开关系连线" : "折叠关系连线"}">${TOOL_ICON.rel}<sup>${relCount || ""}</sup></button>
        <button class="icon-btn ${S.relAdding === id ? "active" : ""}" data-add-rel="${id}" title="新建关系" aria-label="新建关系">＋</button>
        <span class="grow"></span>
        <button class="icon-btn" data-tochat="${id}" title="把这张卡和它的下级写进左边的对话框（写完回车就发）" aria-label="写进对话框">↵</button>
        ${n.root ? "" : `<button class="icon-btn" data-rename="${id}" title="改标题" aria-label="改标题">T</button><button class="icon-btn" data-merge="${id}" title="融合" aria-label="融合">⊕</button>${S.merging && S.merging !== id ? `<button class="icon-btn" data-merge-target="${id}" title="并入这里" aria-label="并入这里">↳</button>` : ""}`}
        <button class="icon-btn fold ${childClosed ? "active" : ""}" data-fold-child="${id}" aria-expanded="${!childClosed}" title="${childClosed ? "展开下级（" + ch + "）" : "折叠下级（" + ch + "）"}" aria-label="${childClosed ? "展开下级" : "折叠下级"}"${ch ? "" : " disabled"}>${childClosed ? "+" : "−"}<sup>${ch || ""}</sup></button>
        ${n.root ? "" : `<button class="icon-btn danger" data-del="${id}" title="删除这张卡（它的下级接到上级下面）" aria-label="删除">×</button>`}
      </div>${S.relAdding === id ? relationComposer(id) : ""}`;
    if (ch) h += `<button class="stem${childClosed ? " closed" : ""}" data-fold-child="${id}" title="${childClosed ? "展开下面 " + ch + " 项" : "折叠下面的 " + ch + " 项"}" aria-label="${childClosed ? "展开下级" : "折叠下级"}" aria-expanded="${!childClosed}">${childClosed ? "+" : "−"}</button>`;
    return h + `</div>`;
  }

  // This card and everything under it, as plain lines: what 「写进对话框」 sends
  // and what Enter on a selected card sends.
  function cardText(id) {
    const lines = [];
    (function walk(cid, depth) {
      const n = node(cid), pad = "  ".repeat(depth);
      const face = (n.root ? n.title : faceText(n)) || "";
      const title = (n.title || "").trim();
      if (!n.root && title && face.indexOf(title) !== 0) lines.push(pad + "【" + title + "】");
      String(face).split("\n").forEach(line => lines.push(line.trim() ? pad + line.trim() : ""));
      n.children.forEach(c => walk(c, depth + 1));
    })(id, 0);
    return lines.join("\n").trim();
  }

  // The chat lives in the parent page (dsh); the graph only hands it the text.
  function sendToChat(id) {
    const text = cardText(id);
    if (!text) return say("这张卡没有内容可发");
    if (!EMBEDDED) {
      try { navigator.clipboard.writeText(text); say("单独打开的白板没有对话框，已复制到剪贴板", true); }
      catch (e) { say("单独打开的白板没有对话框"); }
      return;
    }
    window.parent.postMessage({ source: "km-app", type: "insert", text }, "*");
    say("整棵「" + node(id).title + "」已写进对话框，回车就发", true);
  }

  function sectionHtml(id, s) {
    const n = node(id);
    if (s === "content") {
      if (S.editing === id) return `<div class="editor">
        <textarea data-editbody="${id}">${esc(n.body)}</textarea>
        <div class="pv md" data-pv="${id}"></div>
        <div class="row"><button class="icon-btn" data-save="${id}" title="保存" aria-label="保存">✓</button><button class="icon-btn" data-cancel="${id}" title="取消" aria-label="取消">×</button>
          <span style="font-size:11px;color:var(--muted)">⌘↵ 保存 · Esc 取消 · 原句会一直保留在「原文」里</span></div></div>`;
      return `<div class="md" data-bodymd="${id}"></div>`;
    }
    if (s === "origin") {
      if (!n.origins.length) return `<div style="font-size:12px;color:var(--muted)">你自己写的，没有原文。</div>`;
        return n.origins.map((o, k) => `<div class="origin"><div class="md" data-orig="${id}:${k}"></div>
        <div class="src"><span>— ${esc(o.source_title)}</span><button class="jump icon-btn" data-jump="${id}:${k}" title="跳到原文" aria-label="跳到原文">↗</button></div></div>`).join("")
        + (n.edited ? `<div style="font-size:11px;color:var(--fixed)">内容已改过，上面是原句。</div>` : "");
    }
    if (s === "check") {
      return `<div class="checks">${Object.entries(CHECK).map(([k, v]) => `<button class="ck ${k} ${n.check === k ? "on" : ""}" data-ck="${id}:${k}" title="${v}" aria-label="${v}">${CHECK_ICON[k]}</button>`).join("")}</div>
        <input class="note" data-note="${id}" value="${esc(n.check_note)}" placeholder="依据：对照了哪段代码、哪篇文章（回车保存）">`;
    }
    if (s === "rel") {
      const rows = [];
      const selector = (from, relation, to) => `<select aria-label="修改关系类型" data-rel-edit="${from}|${relation}|${to}">${Object.entries(REL).filter(([k]) => k !== "mentions").map(([k, v]) =>
        `<option value="${k}" ${k === relation ? "selected" : ""}>${v}</option>`).join("")}</select>`;
      n.out.forEach(l => rows.push(`<div class="rel">${selector(id, l.relation, l.id)}<span class="t" data-go="${l.id}">${esc(l.title)}</span>
        ${l.relation === "belongs_to" && l.id === S.data.root ? "" : `<button class="x" data-unlink="${id}|${l.relation}|${l.id}" title="断开关系">×</button>`}</div>`));
      n.in.filter(l => l.relation !== "belongs_to").forEach(l => rows.push(`<div class="rel"><span class="t" data-go="${l.id}">${esc(l.title)}</span>
        ${selector(l.id, l.relation, id)}<button class="x" data-unlink="${l.id}|${l.relation}|${id}" title="断开关系">×</button></div>`));
      n.mentions_out.forEach(l => rows.push(`<div class="rel"><b style="color:${COLOR.mentions}">正文提到</b><span class="t" data-go="${l.id}">${esc(l.title)}</span></div>`));
      const q = S.linkQ[id] || "";
      return (rows.join("") || `<div style="font-size:12px;color:var(--muted)">还没有别的关系。</div>`)
        + `<div class="addrel"><select data-relkind="${id}">${Object.entries(REL).filter(([k]) => k !== "mentions").map(([k, v]) =>
            `<option value="${k}">${k === "belongs_to" ? "属于（挂到它下面）" : v}</option>`).join("")}</select>
          <input data-relq="${id}" value="${esc(q)}" placeholder="搜另一张卡"></div><div class="cands" data-cands="${id}"></div>`;
    }
    if (s === "child") {
      const kids = n.children.map(c => `<div class="rel"><span class="dot ${node(c).check}"></span><span class="t" data-go="${c}">${esc(node(c).title)}</span></div>`).join("");
      const writing = S.writing === id ? `<div class="editor" style="margin-top:5px"><textarea data-newchild="${id}" placeholder="写一条子信息（支持公式），⌘↵ 保存"></textarea>
          <div class="row"><button data-savechild="${id}">挂上去</button><button data-cancelchild="${id}">取消</button></div></div>` : "";
      return (kids || `<div style="font-size:12px;color:var(--muted)">还没有子信息。</div>`) + writing
        + (S.writing === id ? "" : `<div class="row" style="margin-top:5px"><button data-write="${id}">＋ 写一条子信息</button>
            ${id === S.data.target ? "" : `<button data-target="${id}">聊天里选的挂到这里</button>`}</div>`);
    }
    return "";
  }

  function relationComposer(id) {
    const q = S.linkQ[id] || "";
    return `<div class="relation-composer"><select data-relkind="${id}">${Object.entries(REL).filter(([k]) => k !== "mentions").map(([k, v]) => `<option value="${k}">${k === "belongs_to" ? "属于" : v}</option>`).join("")}</select><input data-relq="${id}" value="${esc(q)}" placeholder="输入卡片标题"><div class="cands" data-cands="${id}"></div></div>`;
  }

  // 一份资料里，哪些单位是一张表的三层：整张表(table)、某一行(table_row)、某一格(table_item)。
  // 表按表画，行和格不再各占一行——它们在那张表里点得到。
  function tablePlan(units) {
    const tables = new Map();      // group → 整张表那个单位
    units.forEach(u => { if (u.kind === "table" && u.group != null) tables.set(u.group, u); });
    const inside = new Set();      // 已经画在表里的行/格
    units.forEach(u => {
      if ((u.kind === "table_row" || u.kind === "table_item") && u.group != null && tables.has(u.group)) inside.add(u.id);
    });
    return { tables, inside };
  }

  function sourceHtml(src) {
    const units = S.units.get(src.id);
    let h = `<div class="source" data-src="${src.id}" style="width:${SOURCE_W}px">
      <div class="nh"><span class="ttl">${esc(src.title)}</span>
        <button class="bodytog" data-srcdel="${src.id}" title="删掉这份资料：用它做的卡片一起删">×</button></div>`;
    if (!units) h += `<div class="sent">读取中…</div>`;
    else {
      const plan = tablePlan(units);
      const lines = units.filter(u => u.kind !== "heading" && !u.kind.endsWith("_legacy") && !plan.inside.has(u.id));
      h += lines.map(u => u.kind === "table"
        ? `<div class="sent tbl ${u.cards.length ? "picked" : ""}" data-tbl="${u.id}" data-srcid="${src.id}"
             title="点一下：整张表做成一张卡 · Ctrl 点某一行：只取那一行 · ⌥ 点某一格：只取那一个数据">
             <div class="md" data-tblmd="${u.id}"></div><div class="tbl-hint">整张表 · Ctrl+点一行 · ⌥+点一格</div></div>`
        : `<div class="sent ${u.cards.length ? "picked" : ""}" data-unit="${u.id}" data-srcid="${src.id}" title="点一下：做成卡片，挂到挂载点下">
             <div class="md" data-sent="${u.id}"></div>${u.cards.length ? `<span class="tag">✓ 已成卡</span>` : ""}</div>`).join("");
      h += units.filter(u => u.kind.endsWith("_legacy")).map(u => `<div class="legacy" data-legacy="${u.id}"><b>旧卡所引原文</b><div class="md" data-sent="${u.id}"></div></div>`).join("");
    }
    return h + `</div>`;
  }

  // 把渲染出来的表标上行列，并把已经成卡的行/格标出来：点哪儿取哪层。
  function markTables(src) {
    const units = S.units.get(src.id) || [];
    const plan = tablePlan(units);
    plan.tables.forEach((table, group) => {
      const host = $("layer").querySelector(`[data-tblmd="${table.id}"]`);
      const el = host && host.querySelector("table");
      if (!el) return;
      const rows = [...el.querySelectorAll("tbody tr")];
      const byKey = (kind, row, col) => units.find(u => u.kind === kind && u.group === group
        && u.row === row && (col == null || u.col === col));
      rows.forEach((tr, i) => {
        tr.dataset.row = String(i + 1);
        const rowUnit = byKey("table_row", i + 1);
        if (rowUnit && rowUnit.cards.length) tr.classList.add("picked");
        [...tr.children].forEach((td, c) => {
          td.dataset.col = String(c);
          const item = byKey("table_item", i + 1, c);
          if (item && item.cards.length) td.classList.add("picked");
        });
      });
    });
  }

  function render() {
    const d = S.data, layer = $("layer");
    if (S.mode === "outline") return renderOutliner();
    $("stage").classList.remove("outliner-stage");
    $("stage").style.cssText = "";
    $("layer").style.position = "";
    $("mode-toggle").classList.remove("active"); $("mode-toggle").title = "切换 Outliner"; $("mode-toggle").setAttribute("aria-label", "切换 Outliner");
    metrics();   // card width and gaps follow the pane, before anything is drawn
    const vis = visible();
    const srcs = d.sources;
    layer.innerHTML = `<svg id="edges"></svg>`
      + (srcs.length ? `<div class="lane-h" id="lane-h">导入的资料（点句子 → 挂到挂载点）</div>` : "")
      + srcs.map(sourceHtml).join("") + vis.map(nodeHtml).join("");

    // markdown everywhere it appears
    vis.forEach(id => {
      const n = node(id);
      const ttl = layer.querySelector(`[data-ttl="${id}"]`); if (ttl) mount(ttl, n.title, { inline: true });
      const original = layer.querySelector(`[data-original="${id}"]`);
      if (original) mount(original, faceText(n), { refs: n.refs });
      const b = layer.querySelector(`[data-bodymd="${id}"]`); if (b) mount(b, n.body, { refs: n.refs });
      n.origins.forEach((o, k) => { const el = layer.querySelector(`[data-orig="${id}:${k}"]`); if (el) mount(el, o.text); });
      const pv = layer.querySelector(`[data-pv="${id}"]`); if (pv) mount(pv, n.body);
      const pre = layer.querySelector(`[data-pre="${id}"]`); if (pre) mount(pre, n.body);
    });
    srcs.forEach(s => (S.units.get(s.id) || []).forEach(u => { const el = layer.querySelector(`[data-sent="${u.id}"]`); if (el) mount(el, u.text); }));
    srcs.forEach(s => {
      (S.units.get(s.id) || []).forEach(u => { const el = layer.querySelector(`[data-tblmd="${u.id}"]`); if (el) mount(el, u.text); });
      markTables(s);
    });

    // Measured before layout: a card is as wide as its widest display formula
    // needs, so nothing is ever cut off on the card face. The formula itself is
    // measured (KaTeX's own box), not the overflow of a box that is still narrow,
    // and the pass runs twice because widening can change that measurement.
    const setWidths = () => {
      vis.forEach(id => { const b = layer.querySelector(`.node[data-id="${id}"]`); if (b) b.style.width = width(id) + "px"; });
    };
    // Grow a card by exactly the overflow its formula reports, and look again:
    // KaTeX's own boxes are not reliable until the box is wide enough for them.
    const widen = () => {
      let grew = false;
      vis.forEach(id => {
        const card = layer.querySelector(`.node[data-id="${id}"]`);
        if (!card || !card.querySelector(".math-block")) return;
        card.querySelectorAll(".math-block").forEach(el => {
          const over = el.scrollWidth - el.clientWidth;
          if (over <= 0) return;
          const want = Math.min(MAX_W(), Math.ceil(width(id) + over + 2));
          if (want > (fitW.get(id) || 0)) { fitW.set(id, want); grew = true; }
        });
      });
      if (grew) setWidths();
      return grew;
    };
    fitW.clear();
    for (let pass = 0; pass < 4 && widen(); pass++) { /* converge */ }
    // KaTeX's own fonts arrive after the first paint and change how wide a
    // formula really is, so lay the board out once more when they are in.
    if (document.fonts && !document.fonts.kmHooked) {
      document.fonts.kmHooked = true;
      document.fonts.ready.then(() => { if (S.data) render(); });
    }

    layout(vis, srcs);
    wire(layer);
    wireEdges();
    renderOutline();
    const label = $("target");
    label.innerHTML = `新知识挂到：<b>${esc(node(d.target).title)}</b>`;
    label.title = "点这里：把画面带回这一段（活跃的分支）";
    label.style.cursor = "pointer";
    label.onclick = () => focusActive();
    emptyHint();
    renderLegend();
    // The canvas keeps the view it had. It is only re-fitted when there is no
    // remembered one, when the tree changed shape too much to stay in sight, or
    // when 自适应 was pressed on purpose.
    if (S.needFit) fitAll();
    else if (S.needFocus || !S.view) focusActive();
    else { applyView(); if (!viewShowsSomething()) focusActive(); }
    applyOutline();
    renderRelationIndex();
    fitMathToCards();
    reportMathCheck();
  }

  // Is any card or imported source actually inside the pane right now? After a
  // panel resize or a re-layout, a remembered view can end up looking at nothing.
  function viewShowsSomething() {
    const st = $("stage"), s = st.getBoundingClientRect();
    return [...$("layer").querySelectorAll(".node, .source")].some(el => {
      const r = el.getBoundingClientRect();
      return r.bottom > s.top + 4 && r.top < s.bottom - 4 && r.right > s.left + 4 && r.left < s.right - 4;
    });
  }

  // The constraint: a formula is always shown whole. A card first grows to fit
  // it; what is still too wide for the widest card is scaled down until it fits
  // (never below MIN_MATH_K — past that it scrolls rather than becoming unreadable).
  const MIN_MATH_K = 0.55;
  function fitMathToCards() {
    $("layer").querySelectorAll(".node .math-block").forEach(el => {
      const inner = el.firstElementChild;
      if (!inner) return;
      inner.style.transform = ""; el.style.height = "";
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 0) return;
      const k = Math.max(MIN_MATH_K, el.clientWidth / el.scrollWidth);
      inner.style.transformOrigin = "left top";
      inner.style.transform = `scale(${k})`;
      el.style.height = Math.ceil(inner.offsetHeight * k) + "px";
    });
  }

  function relationDescription(k) {
    return ({belongs_to:"上下级，唯一父级", prerequisite:"理解顺序", example_of:"具体实例", refines:"补充细化", contradicts:"冲突信息", related:"无方向关联", mentions:"正文 [[提及]] 自动维护"})[k] || "";
  }
  function relationLabels(n) {
    const counts = {};
    [...n.out, ...n.in].forEach(l => { counts[l.relation] = (counts[l.relation] || 0) + 1; });
    return Object.entries(counts).map(([k, v]) => `${REL[k] || k} ${v}`).join(" · ") || "无额外关系";
  }
  function renderOutliner() {
    const d = S.data, layer = $("layer"), rows = [];
    $("stage").classList.add("outliner-stage");
    $("stage").style.background = "var(--bg)";
    $("stage").style.overflow = "auto";
    layer.style.position = "relative";
    $("mode-toggle").classList.add("active"); $("mode-toggle").title = "回到脑图"; $("mode-toggle").setAttribute("aria-label", "回到脑图");
    (function walk(id, depth) {
      const n = node(id), folded = S.closedChildren.has(id) || S.closedTrees.has(id);
      const original = faceText(n);
      const editor = S.editing === id && !n.root ? `<div class="outline-editor"><textarea data-editbody="${id}">${esc(n.body)}</textarea><div class="row"><button class="icon-btn" data-save="${id}" title="保存" aria-label="保存">✓</button><button class="icon-btn" data-cancel="${id}" title="取消" aria-label="取消">×</button></div></div>` : "";
      rows.push(`<div class="outline-row ${n.root ? "root-row" : ""} ${id === d.target ? "target-row" : ""}" data-id="${id}" style="--depth:${depth}">
        <button class="outline-fold icon-btn" data-outline-fold="${id}" title="${folded ? "展开下级" : "折叠下级"}" aria-label="${folded ? "展开下级" : "折叠下级"}">${n.children.length ? (folded ? "▸" : "▾") : "·"}</button>
        <button class="outline-target icon-btn ${id === d.target ? "active" : ""}" data-target="${id}" title="${id === d.target ? "当前挂载点" : "设为挂载点"}" aria-label="设为挂载点">⌖</button>
        <div class="outline-copy"><div class="outline-title">${esc(n.root ? n.title : original)}</div><div class="outline-meta">#${id} · ${n.children.length} 个下级 · ${esc(relationLabels(n))}</div>${editor}</div>
        ${n.root ? "" : `<button class="icon-btn" data-edit="${id}" title="改正文" aria-label="改正文">✎</button><button class="icon-btn" data-rename="${id}" title="改标题" aria-label="改标题">T</button><button class="icon-btn danger" data-del="${id}" title="删除" aria-label="删除">×</button>`}
      </div>`);
      if (!folded) n.children.forEach(c => walk(c, depth + 1));
    })(d.root, 0);
    layer.innerHTML = `<div class="outliner-view"><div class="outliner-head"><b>Outliner</b><span>逐条查看、编辑和重排知识</span></div>${rows.join("")}</div>`;
    layer.style.transform = "none";
    wire(layer);
    renderOutline(); renderRelationIndex();
    const label = $("target");
    label.innerHTML = `新知识挂到：<b>${esc(node(d.target).title)}</b>`;
    label.title = "点这里：把画面带回这一段（活跃的分支）";
    label.style.cursor = "pointer";
    label.onclick = () => focusActive();
    emptyHint(); renderLegend(); applyOutline();
  }
  function renderRelationIndex() {
    const box = $("relation-index");
    if (!box) return;
    box.hidden = !S.relationIndexOpen;
    if (!S.relationIndexOpen || !S.data) return;
    const counts = Object.fromEntries(Object.keys(REL).map(k => [k, 0]));
    S.data.refs.forEach(r => { counts[r.relation] = (counts[r.relation] || 0) + 1; });
    box.innerHTML = `<div class="relation-head"><b>关系</b><button class="icon-btn" data-relation-close title="关闭关系索引" aria-label="关闭关系索引">×</button></div>
      <div class="relation-help">层级关系自动排树；其他关系点线即可编辑或删除。</div>
      ${Object.entries(REL).map(([k, v]) => `<div class="relation-item"><i style="background:${k === "belongs_to" ? "#bdb9b0" : COLOR[k]}"></i><span><b>${v}</b><small>${relationDescription(k)}</small></span><em>${counts[k] || 0}</em></div>`).join("")}`;
    box.querySelector("[data-relation-close]").onclick = () => { S.relationIndexOpen = false; renderRelationIndex(); };
  }

  function applyOutline() {
    const main = $("main"), toggle = $("outline-toggle");
    if (!main || !toggle) return;
    main.classList.toggle("outline-closed", S.outlineClosed);
    toggle.title = S.outlineClosed ? "展开目录" : "收起目录";
    toggle.setAttribute("aria-label", toggle.title);
  }

  function wireEdges() {
    const svg = $("edges");
    svg.onclick = e => {
      const el = e.target.closest?.("[data-ref]");
      if (!el) return;
      e.stopPropagation();
      S.selectedRef = +el.dataset.ref;
      renderEdgePanel();
    };
    renderEdgePanel();
  }

  function renderEdgePanel() {
    const panel = $("edge-panel");
    const ref = S.selectedRef == null ? null : S.data?.refs[S.selectedRef];
    if (!panel || !ref) { if (panel) panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = `<span class="edge-dot" style="background:${COLOR[ref.relation]}"></span>
      <span class="edge-title">#${ref.from} → #${ref.to}</span>
      <select aria-label="关系类型" data-edge-kind="${S.selectedRef}">${Object.entries(REL).filter(([k]) => k !== "mentions").map(([k, v]) => `<option value="${k}" ${k === ref.relation ? "selected" : ""}>${v}</option>`).join("")}</select>
      <button class="icon-btn" data-edge-unlink="${S.selectedRef}" title="删除关系" aria-label="删除关系">×</button>
      <button class="icon-btn" data-edge-close title="关闭关系工具">⌕</button>`;
    panel.querySelector("[data-edge-kind]").onchange = e => {
      const relation = e.target.value;
      act(() => api("PATCH", "links", { from: ref.from, relation: ref.relation, to: ref.to, new_relation: relation }), "关系已更新", ref.from);
    };
    panel.querySelector("[data-edge-unlink]").onclick = () => {
      act(() => api("DELETE", "links", { from: ref.from, relation: ref.relation, to: ref.to }), "关系已删除", ref.from);
      S.selectedRef = null;
    };
    panel.querySelector("[data-edge-close]").onclick = () => { S.selectedRef = null; renderEdgePanel(); };
  }

  // Tidy top-down tree, the way the whole thing was designed: each subtree as
  // wide as it needs, parents centred over their children, each level below the
  // tallest box of the level above. Siblings stay side by side — a tree that has
  // been broken into rows reads as two pictures, not one.
  let pos = {};
  function layout(vis, srcs) {
    const layer = $("layer"), box = id => layer.querySelector(`.node[data-id="${id}"]`);
    // Only what is on screen takes part in the layout: a folded subtree must not
    // keep reserving the room its children had, or the cards left beside it end
    // up far apart and every edge stretches across the gap.
    const folded = id => S.closedChildren.has(id) || S.closedTrees.has(id);
    const shown = id => (folded(id) ? [] : node(id).children);
    const sub = new Map();
    (function measure(id) {
      const c = shown(id); c.forEach(measure);
      const cw = c.reduce((a, x) => a + sub.get(x), 0) + Math.max(0, c.length - 1) * HGAP;
      sub.set(id, Math.max(width(id), cw));
    })(S.data.root);
    const lvH = [];
    vis.forEach(id => { const l = node(id).level; lvH[l] = Math.max(lvH[l] || 0, box(id).offsetHeight); });
    const lvY = [0];
    for (let l = 1; l < lvH.length; l++) lvY[l] = lvY[l - 1] + lvH[l - 1] + VGAP;
    pos = {};
    (function place(id, x0) {
      const c = shown(id), y = lvY[node(id).level];
      if (!c.length) { pos[id] = { x: x0 + (sub.get(id) - width(id)) / 2, y }; return; }
      const cw = c.reduce((a, x) => a + sub.get(x), 0) + (c.length - 1) * HGAP;
      let x = x0 + (sub.get(id) - cw) / 2;
      c.forEach(k => { place(k, x); x += sub.get(k) + HGAP; });
      const f = pos[c[0]], l = pos[c[c.length - 1]];
      pos[id] = { x: (f.x + width(c[0]) / 2 + l.x + width(c[c.length - 1]) / 2) / 2 - width(id) / 2, y };
    })(S.data.root, 0);
    // A card dropped by hand keeps where it was put; the rest stay a strict tree.
    vis.forEach(id => { const n = node(id); if (n.x != null && n.y != null) pos[id] = { x: n.x, y: n.y }; });
    vis.forEach(id => { const b = box(id); b.style.left = pos[id].x + "px"; b.style.top = pos[id].y + "px"; });

    // imported sources: a column to the left of the tree
    let sy = 26;
    const sourceX = -(SOURCE_W + 50);
    const lh = $("lane-h"); if (lh) { lh.style.left = sourceX + "px"; lh.style.top = "0px"; }
    srcs.forEach(s => {
      const el = layer.querySelector(`.source[data-src="${s.id}"]`);
      el.style.left = sourceX + "px"; el.style.top = sy + "px"; sy += el.offsetHeight + 14;
    });

    // edges
    const rect = id => ({ x: pos[id].x, y: pos[id].y, w: width(id), h: box(id).offsetHeight });
    const xs = vis.map(id => pos[id].x + width(id)), ys = vis.map(id => pos[id].y + box(id).offsetHeight);
    const svg = $("edges");
    svg.setAttribute("width", Math.max(...xs) + 80); svg.setAttribute("height", Math.max(...ys, sy) + 80);
    let html = `<defs>${Object.entries({ tree: "#bdb9b0", ...COLOR }).map(([k, c]) =>
      `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("")}</defs>`;
    vis.forEach(id => {
      const p = node(id).parent; if (p == null || !pos[p]) return;
      const a = rect(p), b = rect(id), x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
      html += `<path class="tree" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}" marker-end="url(#m-tree)"/>`;
    });
    const isVis = new Set(vis);
    S.data.refs.filter(r => isVis.has(r.from) && isVis.has(r.to) && !S.closedRelations.has(r.from) && !S.closedRelations.has(r.to)).forEach((r, k) => {
      const a = rect(r.from), b = rect(r.to), ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const side = bc.x >= ac.x ? 1 : -1, same = Math.abs(a.y - b.y) < 10;
      const p1 = same ? { x: ac.x, y: a.y + a.h } : { x: side > 0 ? a.x + a.w : a.x, y: ac.y };
      const p2 = same ? { x: bc.x, y: b.y + b.h + 4 } : { x: side > 0 ? b.x - 4 : b.x + b.w + 4, y: bc.y };
      const bend = same ? 46 + 12 * (k % 4) : 0;
      const c1 = same ? { x: p1.x, y: p1.y + bend } : { x: p1.x + side * 60, y: p1.y };
      const c2 = same ? { x: p2.x, y: p2.y + bend } : { x: p2.x - side * 60, y: p2.y };
      const lx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, ly = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
      html += `<path class="rel-hit" data-ref="${k}" d="M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}"/>
        <path class="rel" data-ref="${k}" d="M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}" stroke="${COLOR[r.relation]}"
        stroke-dasharray="${DASH[r.relation] || ""}" marker-end="url(#m-${r.relation})"/>`;
    });
    svg.innerHTML = html;
  }

  // What is in the library, always on screen: counts, the whole tree as a
  // table of contents, and what came in last. Click anything to go there.
  function renderOutline() {
    const d = S.data, all = Object.values(d.nodes).filter(n => !n.root);
    const count = k => all.filter(n => n.check === k).length;
    const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? "刚刚" : s < 3600 ? `${s / 60 | 0}分钟前` : s < 86400 ? `${s / 3600 | 0}小时前` : `${s / 86400 | 0}天前`; };
    let h = `<h3>库里有什么</h3><div class="stat"><b>${all.length}</b> 张卡 · <b>${d.refs.length}</b> 条关系 · 带原文 <b>${all.filter(n => n.origins.length).length}</b><br>
      对 ${count("ok")} · 改正过 ${count("fixed")} · 存疑 ${count("doubt")} · 错 ${count("wrong")} · 未核对 ${count("unchecked")}</div>`;
    const recent = [...all].sort((a, b) => b.created - a.created).slice(0, 5);
    if (recent.length) h += `<div class="sub">最近入库</div>` + recent.map(n =>
      `<div class="oi" data-oi="${n.id}"><span class="dot ${n.check}"></span><span class="t md" data-ot="${n.id}"></span><span class="when">${ago(n.created)}</span></div>`).join("");
    h += `<div class="sub">目录</div>`;
    (function walk(id, depth) {
      const n = d.nodes[id];
      h += `<div class="oi ${id === d.target ? "tgt" : ""}" data-oi="${id}" style="padding-left:${4 + depth * 12}px" title="${esc(n.title)}">
        <span class="dot ${n.check}"></span><span class="t md" data-ot="${id}"></span>${n.children.length ? `<span class="n">${n.children.length}</span>` : ""}</div>`;
      n.children.forEach(c => walk(c, depth + 1));
    })(d.root, 0);
    if (d.sources.length) h += `<div class="sub">导入的资料</div>` + d.sources.map(s => `<div class="oi" data-os="${s.id}"><span class="t">📄 ${esc(s.title)}</span></div>`).join("");
    const box = $("outline");
    box.innerHTML = h;
    box.querySelectorAll("[data-ot]").forEach(el => mount(el, d.nodes[el.dataset.ot].title, { inline: true }));
    box.querySelectorAll("[data-oi]").forEach(el => el.onclick = () => { const id = +el.dataset.oi; reveal(id); render(); center(id); flash(id); });
    box.querySelectorAll("[data-os]").forEach(el => el.onclick = async () => {
      const id = +el.dataset.os;
      if (!S.units.has(id)) S.units.set(id, await api("GET", `sources/${id}/units`).catch(() => []));
      render(); const b = $("layer").querySelector(`.source[data-src="${id}"]`); if (b) centerEl(b);
    });
  }

  // An empty repository says what to do instead of showing a blank canvas.
  function emptyHint() {
    const n = Object.keys(S.data.nodes).length - 1;
    let hint = $("empty-hint");
    if (n > 0 || S.data.sources.length) { if (hint) hint.remove(); return; }
    if (!hint) { hint = document.createElement("div"); hint.id = "empty-hint"; $("stage").appendChild(hint); }
    if (S.mode === "outline") {
      hint.className = "outline-empty";
      hint.style.cssText = "position:static;width:min(1000px,calc(100% - 32px));max-width:min(1000px,calc(100% - 32px));margin:0 auto 18px;padding:10px 14px;background:transparent;border:0;border-top:1px solid var(--line);border-radius:0;box-shadow:none;color:var(--muted);text-align:left;font-size:12px;line-height:1.6";
    }
    hint.innerHTML = S.session
      ? `<b>这个会话的知识库还是空的</b><br>在左边的用户消息或回答里点任意一条，它就会出现在这里，挂在「${esc(node(S.data.target).title)}」下面。`
      : `<b>知识库还是空的</b><br>在上面「导入」里填路径或粘贴文字，或在 dsh 里打开一个会话。`;
  }

  function renderLegend() {
    $("legend").innerHTML = `<span title="上下级"><i style="background:#bdb9b0"></i></span>` + Object.keys(COLOR).map(r =>
      `<span title="${REL[r]}"><i style="background:${COLOR[r]}"></i></span>`).join("")
      + `<span style="margin-left:auto" class="legend-hint" title="⌖ 挂载点　⌁ 关系连线　⌄ 下级　拖拽画布">⌖　⌁　⌄</span>`;
  }

  // ------------------------------------------------------------- actions
  async function act(fn, ok, focus) {
    try { await fn(); if (ok) say(ok, true); await reload(focus); return true; }
    catch (e) { fail(e); return false; }
  }

  function wire(layer) {
    const on = (sel, ev, fn) => layer.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));
    on("[data-edit]", "click", (el, e) => { e.stopPropagation(); editCard(+el.dataset.edit); });
    on("[data-editbody]", "input", el => mount(layer.querySelector(`[data-pv="${el.dataset.editbody}"]`), el.value));
    on("[data-editbody]", "keydown", (el, e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBody(+el.dataset.editbody, el.value); }
      if (e.key === "Escape") { S.editing = null; render(); }
    });
    on("[data-save]", "click", el => saveBody(+el.dataset.save, layer.querySelector(`[data-editbody="${el.dataset.save}"]`).value));
    on("[data-cancel]", "click", () => { S.editing = null; render(); });
    on("[data-fold-rel]", "click", el => { const id = +el.dataset.foldRel; S.closedRelations.has(id) ? S.closedRelations.delete(id) : S.closedRelations.add(id); saveStateSoon(); render(); });
    const toggleFold = id => {
      S.closedChildren.has(id) ? S.closedChildren.delete(id) : S.closedChildren.add(id);
      saveStateSoon();
      render();
    };
    on("[data-fold-child]", "click", el => toggleFold(+el.dataset.foldChild));
    on("[data-outline-fold]", "click", el => toggleFold(+el.dataset.outlineFold));
    on("[data-tochat]", "click", (el, e) => { e.stopPropagation(); sendToChat(+el.dataset.tochat); });
    on("[data-origins]", "click", el => { const id = +el.dataset.origins; S.originsOpen.has(id) ? S.originsOpen.delete(id) : S.originsOpen.add(id); saveStateSoon(); render(); });
    on("[data-add-rel]", "click", el => { const id = +el.dataset.addRel; S.relAdding = S.relAdding === id ? null : id; render(); if (S.relAdding === id) layer.querySelector(`[data-relq="${id}"]`)?.focus({ preventScroll: true }); });
    on("[data-tree-toggle]", "click", el => { const id = +el.dataset.treeToggle; S.closedTrees.has(id) ? S.closedTrees.delete(id) : S.closedTrees.add(id); saveStateSoon(); render(); });
    on("[data-ttl]", "dblclick", el => renameInline(el, +el.dataset.ttl));
    on("[data-ck]", "click", el => {
      const [id, k] = el.dataset.ck.split(":");
      act(() => api("POST", `cards/${id}/check`, { check: k, note: layer.querySelector(`[data-note="${id}"]`).value }), "核对结果存好了");
    });
    on("[data-note]", "keydown", (el, e) => {
      if (e.key !== "Enter") return;
      const id = +el.dataset.note;
      act(() => api("POST", `cards/${id}/check`, { check: node(id).check, note: el.value }), "依据存好了");
    });
    on("[data-jump]", "click", el => { const [id, k] = el.dataset.jump.split(":"); jump(node(+id).origins[+k]); });
    on("[data-jumpcard]", "click", (el, e) => { e.stopPropagation(); const n = node(+el.dataset.jumpcard); if (n.origins.length) jump(n.origins[0]); });
    on("[data-go]", "click", el => { const id = +el.dataset.go; reveal(id); render(); center(id); flash(id); });
    on("[data-unlink]", "click", el => {
      const [from, relation, to] = el.dataset.unlink.split("|");
      act(() => api("DELETE", "links", { from: +from, relation, to: +to }), "断开了", +from);
    });
    on("[data-rel-edit]", "change", el => {
      const [from, relation, to] = el.dataset.relEdit.split("|");
      act(() => api("PATCH", "links", { from: +from, relation, to: +to, new_relation: el.value }), "关系改好了", +from);
    });
    on("[data-relq]", "input", el => { S.linkQ[el.dataset.relq] = el.value; candidates(+el.dataset.relq, el.value); });
    on("[data-relq]", "keydown", (el, e) => {
      if (e.key !== "Enter") return;
      const first = layer.querySelector(`[data-cands="${el.dataset.relq}"] .cand`); if (first) first.click();
    });
    on("[data-relq]", "focus", el => candidates(+el.dataset.relq, el.value));
    on("[data-target]", "click", (el, e) => { e.stopPropagation(); setTarget(+el.dataset.target); });
    on("[data-rename]", "click", el => renameInline(layer.querySelector(`[data-ttl="${el.dataset.rename}"]`), +el.dataset.rename));
    on("[data-merge]", "click", el => { const id = +el.dataset.merge; S.merging = S.merging === id ? null : id; render();
      if (S.merging) say("选择要保留的卡片，点击「并入这里」"); });
    on("[data-merge-target]", "click", el => { const source = S.merging, target = +el.dataset.mergeTarget;
      S.merging = null; act(() => api("POST", "cards/merge", { source, target }), "两张卡已经融合，原文和关系一并保留", target); });
    on("[data-del]", "click", (el, e) => {
      e.stopPropagation(); const id = +el.dataset.del;
      const title = node(id).title;
      act(() => api("DELETE", `cards/${id}`), `「${title}」删掉了，它的下级接到了它的上级下面`).then(ok => {
        // The chat keeps its sentence state separately. Tell the host to
        // re-read the source-to-card links so a deleted sentence becomes
        // pickable again immediately.
        if (ok && EMBEDDED) window.parent.postMessage({ source: "km-app", type: "picked-changed" }, "*");
      });
    });
    on("[data-write]", "click", el => { S.writing = +el.dataset.write; render(); keepInView(S.writing); $("layer").querySelector(`[data-newchild="${el.dataset.write}"]`)?.focus({ preventScroll: true }); });
    on("[data-cancelchild]", "click", () => { S.writing = null; render(); });
    on("[data-savechild]", "click", el => saveChild(+el.dataset.savechild));
    on("[data-newchild]", "keydown", (el, e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveChild(+el.dataset.newchild); }
      if (e.key === "Escape") { S.writing = null; render(); }
    });
    // One click: this card becomes where new picks go and the selected card
    // (Delete removes it). Two clicks: the editor opens right there. The single
    // click patches the canvas in place instead of redrawing it, because a
    // redraw between the two clicks would swallow the double-click.
    on("[data-drag]", "click", (el, e) => {
      if (e.target.closest("button, [contenteditable=true]") || dragMoved) return;
      const id = +el.dataset.drag;
      if (e.ctrlKey || e.metaKey) { if (marqueeMoved) return; e.preventDefault(); return void ctrlLink(id); }
      if (S.linkFrom != null) { S.linkFrom = null; render(); }
      if (S.relAdding != null && S.relAdding !== id) return void linkTo(S.relAdding, id);
      S.selected = id;
      layer.querySelectorAll(".node.selected").forEach(n => n.classList.remove("selected"));
      const card = el.closest(".node");
      if (card) card.classList.add("selected");
      saveStateSoon();
      setTargetQuiet(id);
    });
    on("[data-drag]", "dblclick", (el, e) => {
      if (e.target.closest("button, input, textarea, [contenteditable=true], [data-ttl]")) return;
      const id = +el.dataset.drag;
      if (!node(id) || node(id).root) return;   // the root keeps no body of its own
      e.preventDefault();
      editCard(id);
    });
    on("[data-drag]", "pointerdown", (el, e) => startDrag(el, e));
    on(".outline-copy", "dblclick", (el, e) => { const row = el.closest(".outline-row"); if (row && !row.classList.contains("root-row")) { e.preventDefault(); editCard(+row.dataset.id); } });
    // imported sources
    on("[data-srcdel]", "click", (el, e) => {
      e.stopPropagation(); const id = +el.dataset.srcdel;
      act(async () => {
        const out = await api("DELETE", `sources/${id}`);
        S.units.delete(id);
        say(out.cards ? `资料和用它做的 ${out.cards} 张卡都删了` : "资料删了，没有卡片用它", true);
      }, null);
    });
    // 一张表三层：直接点它 = 整张表；Ctrl（Mac 上是 Ctrl=右键，或 ⌘）点某一行 = 那一行；
    // ⌥ 点某一格 = 那一个数据。
    const tablePick = (host, e, asRow) => {
      e.stopPropagation();
      e.preventDefault();
      const units = S.units.get(+host.dataset.srcid) || [];
      const table = units.find(u => u.id === +host.dataset.tbl);
      if (!table) return;
      const cell = e.target.closest("td"), row = e.target.closest("tbody tr");
      const wanted = [];
      if (cell && e.altKey && !asRow) {
        const n = Number(cell.closest("tr").dataset.row), c = Number(cell.dataset.col);
        wanted.push(units.find(u => u.kind === "table_item" && u.group === table.group && u.row === n && u.col === c));
      }
      if (row && (asRow || e.ctrlKey || e.metaKey)) {
        const n = Number(row.dataset.row);
        wanted.push(units.find(u => u.kind === "table_row" && u.group === table.group && u.row === n));
      }
      wanted.push(table);
      const unit = wanted.find(Boolean);
      if (unit) pickUnit(unit, +host.dataset.srcid);
    };
    layer.querySelectorAll("[data-tbl]").forEach(host => {
      host.addEventListener("click", e => tablePick(host, e, false));
      // Mac 上 Ctrl+点就是右键：那一行照样是「单独取这一行」，不给浏览器菜单。
      host.addEventListener("contextmenu", e => tablePick(host, e, true));
    });
    on("[data-unit]", "click", el => {
      const unit = S.units.get(+el.dataset.srcid).find(x => x.id === +el.dataset.unit);
      if (unit) pickUnit(unit, +el.dataset.srcid);
    });
  }

  // A unit of an imported document becomes a card under the mount point. Sentences,
  // whole tables, single rows and single cells all go through here.
  async function pickUnit(unit, sid) {
    S.lastNew = null;
    const ok = await act(async () => {
      const c = await api("POST", "cards", { title: "", body: unit.text, units: [unit.id], parent: S.data.target });
      S.units.set(sid, await api("GET", `sources/${sid}/units`).catch(() => []));
      S.lastNew = c.id;
    }, unit.kind === "table" ? "整张表做成了一张卡" : unit.kind === "table_row" ? "这一行做成了一张卡"
       : unit.kind === "table_item" ? "这一个数据做成了一张卡" : "挂上了", null);
    if (ok && S.lastNew) { render(); showNew(S.lastNew); }
  }

  // One end is the card whose ＋ was pressed; the other end is the card clicked
  // next. The relation kind is the one chosen in that composer.
  function linkTo(from, to) {
    const pick = $("layer").querySelector(`[data-relkind="${from}"]`);
    const relation = pick ? pick.value : "related";
    S.relAdding = null;
    S.linkQ[from] = "";
    act(() => api("POST", "links", { from, relation, to }), relation === "belongs_to" ? "挂过去了" : "连上了", from);
  }

  // Delete removes whatever is selected: a relation line (clicked) or a card
  // (clicked). Typing in a field is never interpreted as a delete.
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && S.data && S.selected != null && node(S.selected)) {
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
      e.preventDefault();
      return void sendToChat(S.selected);
    }
    if (e.key === "Escape" && S.linkFrom != null) { S.linkFrom = null; render(); return; }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    if (!S.data) return;
    if (S.selectedRef != null && S.data.refs[S.selectedRef]) {
      const r = S.data.refs[S.selectedRef];
      S.selectedRef = null;
      act(() => api("DELETE", "links", { from: r.from, relation: r.relation, to: r.to }), "关系删掉了");
      return;
    }
    if (S.selected != null && node(S.selected)) {
      const id = S.selected;
      S.selected = null;
      act(() => api("DELETE", `cards/${id}`), "删掉了，它的下级接到了它的上级下面");
    }
  });

  // Editing a card in place, from the ✎ button or from a double-click on it.
  function editCard(id) {
    S.editing = id;
    S.selected = id;
    render();
    keepInView(id);
    $("layer").querySelector(`[data-editbody="${id}"]`)?.focus({ preventScroll: true });
  }

  // Ctrl (or ⌘) on one card, then Ctrl on another: the second hangs under the
  // first, and its old parent lets it go — one gesture to re-file a whole branch.
  async function ctrlLink(id) {
    if (S.linkFrom == null) {
      S.linkFrom = id;
      render();
      return say("再按住 Ctrl 点另一张卡，那张就挂到「" + node(id).title + "」下面（原来的上级断开）", true);
    }
    if (S.linkFrom === id) { S.linkFrom = null; render(); return say("取消了", true); }
    const parent = S.linkFrom;
    S.linkFrom = null;
    await act(() => api("POST", `cards/${id}/move`, { parent, before: null }),
      "「" + node(id).title + "」挂到「" + node(parent).title + "」下面了，原来的上级已断开", id);
  }

  // Move the mount point without rebuilding the canvas (see the click handler).
  async function setTargetQuiet(id) {
    if (!S.data || S.data.target === id) return;
    const from = S.data.target;
    try {
      await api("POST", "target", { id });
      S.data.target = id;
      render();
      keepInView(id);
      const layer = $("layer");
      const was = layer.querySelector(`.node[data-id="${from}"]`);
      const now = layer.querySelector(`.node[data-id="${id}"]`);
      if (was) was.classList.remove("target");
      if (now) now.classList.add("target");
      for (const [el, isTarget] of [[was, false], [now, true]]) {
        const btn = el && el.querySelector("[data-target]");
        if (!btn) continue;
        btn.classList.toggle("active", isTarget);
        btn.title = isTarget ? "当前挂载点" : "设为挂载点";
        btn.setAttribute("aria-label", btn.title);
      }
      $("target").innerHTML = `新知识挂到：<b>${esc(node(id).title)}</b>`;
      say("聊天里点的句子现在挂到「" + node(id).title + "」下", true);
    } catch (e) { fail(e); }
  }

  function saveBody(id, body) {
    S.editing = null;
    act(() => api("PATCH", `cards/${id}`, { body }), "改好了，原句还在「原文」里", id);
  }
  function saveChild(id) {
    const ta = $("layer").querySelector(`[data-newchild="${id}"]`);
    if (!ta || !ta.value.trim()) return say("先写点内容");
    const body = ta.value;
    S.writing = null;
    S.lastNew = null;
    act(async () => { S.lastNew = (await api("POST", "cards", { title: "", body, units: [], parent: id })).id; }, "子信息挂上了")
      .then(ok => { if (ok && S.lastNew) { showNew(S.lastNew); } });
  }
  function renameInline(el, id) {
    el.contentEditable = "true"; el.textContent = node(id).title; el.focus();
    document.getSelection().selectAllChildren(el);
    const done = keep => {
      el.contentEditable = "false"; el.onblur = el.onkeydown = null;
      const t = el.textContent.trim();
      if (keep && t && t !== node(id).title) act(() => api("PATCH", `cards/${id}`, { title: t }), "标题改好了", id);
      else render();
    };
    el.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(true); } if (e.key === "Escape") done(false); };
    el.onblur = () => done(true);
  }
  async function setTarget(id) {
    if (S.data.target === id) return;
    try {
      await api("POST", "target", { id });
      S.data.target = id;
      render();
      keepInView(id);
      say("聊天里点的句子现在挂到「" + node(id).title + "」下", true);
    } catch (e) { fail(e); }
  }
  async function candidates(id, q) {
    const box = $("layer").querySelector(`[data-cands="${id}"]`);
    if (!box) return;
    const list = (await api("GET", "cards?q=" + encodeURIComponent(q || "")).catch(() => [])).filter(c => c.id !== id).slice(0, 6);
    box.innerHTML = list.map(c => `<button class="cand" data-pick="${c.id}">${esc(c.title)}</button>`).join("") || `<div class="cand empty">没有匹配的卡</div>`;
    box.querySelectorAll("[data-pick]").forEach(el => el.onclick = () => {
      const relation = $("layer").querySelector(`[data-relkind="${id}"]`).value;
      S.linkQ[id] = "";
      act(() => api("POST", "links", { from: id, relation, to: +el.dataset.pick }), relation === "belongs_to" ? "挂过去了" : "连上了", id);
    });
  }

  // Every piece of knowledge links back to where it was said: a sentence picked
  // in a chat goes back to that sentence (in dsh, or in the Codex page beside
  // this board), an imported document to its line.
  function jump(o) {
    if (!o) return;
    const agent = o.agent || (o.dsh_message ? "dsh" : "");
    if (agent && o.message) {
      if (!EMBEDDED) return say("这句原文在左边的对话里，在这个白板嵌在那个对话里时点它会直接跳过去。");
      window.parent.postMessage({ source: "km-app", type: "goto", agent, session: o.session || o.dsh_session,
                                  message: o.message || o.dsh_message, turn: o.turn != null ? o.turn : o.dsh_turn,
                                  index: o.index, text: o.text }, "*");
      say("正在左边定位到这句原文…", true);
      return;
    }
    (async () => {
      if (!S.units.has(o.source)) S.units.set(o.source, await api("GET", `sources/${o.source}/units`).catch(() => []));
      render();
      const el = $("layer").querySelector(`[data-unit="${o.unit}"], [data-legacy="${o.unit}"]`);
      if (!el) return say("原文那份资料已经删掉了");
      centerEl(el); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    })();
  }

  // --------------------------------------------------------- drag to re-file
  let drag = null, dragMoved = false;
  function startDrag(handle, e) {
    if (e.button !== 0 || e.target.closest("button, input, [contenteditable=true]")) return;
    const id = +handle.dataset.drag, el = handle.closest(".node");
    const sx = e.clientX, sy = e.clientY;
    dragMoved = false;
    const move = ev => {
      if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!drag) { drag = { id, el, from: { x: el.offsetLeft, y: el.offsetTop } }; el.classList.add("dragging"); dragMoved = true; }
      // Near the edge of the canvas, the canvas scrolls: the card you want to
      // drop onto may be off screen.
      const r0 = $("stage").getBoundingClientRect(), edge = 40, speed = 14;
      const dx = ev.clientX < r0.left + edge ? speed : ev.clientX > r0.right - edge ? -speed : 0;
      const dy = ev.clientY < r0.top + edge ? speed : ev.clientY > r0.bottom - edge ? -speed : 0;
      if (dx || dy) { S.view.x += dx; S.view.y += dy; applyView(); }
      // The card follows the pointer: every node can be put anywhere.
      const k = S.view.k || 1;
      drag.at = { x: drag.from.x + (ev.clientX - sx) / k, y: drag.from.y + (ev.clientY - sy) / k };
      el.style.left = drag.at.x + "px"; el.style.top = drag.at.y + "px";
      el.style.pointerEvents = "none";
      document.querySelectorAll(".node.drop-in, .node.drop-before, .node.drop-after").forEach(x => x.classList.remove("drop-in", "drop-before", "drop-after"));
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".node");
      el.style.pointerEvents = "";
      if (!over || +over.dataset.id === id) { drag.to = null; return; }
      const r = over.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width;
      const oid = +over.dataset.id, isRoot = node(oid).root;
      drag.to = { id: oid, where: isRoot || (fx > 0.25 && fx < 0.75) ? "in" : fx <= 0.25 ? "before" : "after" };
      over.classList.add("drop-" + drag.to.where);
    };
    const up = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      if (!drag) return;
      const { to, at, el } = drag; el.classList.remove("dragging");
      document.querySelectorAll(".node.drop-in, .node.drop-before, .node.drop-after").forEach(x => x.classList.remove("drop-in", "drop-before", "drop-after"));
      drag = null;
      setTimeout(() => (dragMoved = false), 0);
      if (to && to.where === "in") {
        // Dropped onto another card: one drop, and the two are one. The body and
        // the origins of both survive — nothing is thrown away.
        S.mergeArmed = null;
        act(() => api("POST", "cards/merge", { source: id, target: to.id }),
            "「" + node(id).title + "」并进了「" + node(to.id).title + "」，两份正文和原文都在", to.id);
        return;
      }
      if (to) {
        const p = node(to.id).parent, sib = node(p).children.filter(c => c !== id), k = sib.indexOf(to.id);
        const body = { parent: p, before: to.where === "before" ? to.id : (sib[k + 1] ?? null) };
        act(() => api("POST", `cards/${id}/move`, body), "顺序调好了", id);
        return;
      }
      if (at) act(() => api("POST", `cards/${id}/place`, { x: Math.round(at.x), y: Math.round(at.y) }), null, id);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // --------------------------------------------------------------- view
  function applyView() {
    if (!S.view) S.view = { k: 1, x: 0, y: 0 };
    $("layer").style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
    S.view.vw = $("stage").clientWidth;
    saveStateSoon();
  }
  // Show the whole visible graph: scale it until every card and imported source
  // is inside the pane. The pane is a narrow column, so a tree with several
  // siblings can never be shown whole at a readable size — fitting therefore
  // stops at MIN_K, and below that the view keeps a legible scale on the mount
  // point while you pan (drag) or zoom (wheel) from there.
  const MIN_K = 0.7;
  function fitAll() {
    const st = $("stage"), layer = $("layer");
    const els = [...layer.querySelectorAll(".node, .source")];
    if (!els.length || !st.clientWidth || !st.clientHeight) { S.view = { k: 1, x: 20, y: 20 }; return applyView(); }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    els.forEach(el => {
      minX = Math.min(minX, el.offsetLeft);
      minY = Math.min(minY, el.offsetTop);
      maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth);
      maxY = Math.max(maxY, el.offsetTop + el.offsetHeight);
    });
    const pad = 24, bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    S.needFit = false;
    const k = Math.min(1, (st.clientWidth - pad * 2) / bw, (st.clientHeight - pad * 2) / bh);
    if (k < MIN_K) {
      const id = S.data && S.data.target;
      const spot = id != null && pos[id] ? { x: pos[id].x + width(id) / 2, y: pos[id].y } : { x: minX + bw / 2, y: minY };
      S.view = { k: MIN_K, x: st.clientWidth / 2 - spot.x * MIN_K, y: 56 - spot.y * MIN_K };
      return applyView();
    }
    S.view = { k, x: st.clientWidth / 2 - (minX + bw / 2) * k, y: st.clientHeight / 2 - (minY + bh / 2) * k };
    applyView();
  }
  // 自适应: put a card that was dragged somewhere by hand back on the tree, then
  // show the whole of it. Placement is only where a card sits, never its content.
  async function autoLayout() {
    const moved = Object.values(S.data.nodes).filter(n => n.x != null || n.y != null);
    for (const n of moved) { try { await api("POST", `cards/${n.id}/place`, { x: null, y: null }); } catch (e) { fail(e); return; } }
    S.needFit = true;
    await reload();
    say(moved.length ? `重排好了，${moved.length} 张手动摆过的卡回到树上` : "排版自适应完成", true);
  }
  // A card you just acted on must stay on screen — but only just: the view moves
  // by the smallest step that brings it inside, never re-centering the picture or
  // throwing it somewhere else.
  function keepInView(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`), st = $("stage");
    if (!el || !S.view) return;
    const s = st.getBoundingClientRect(), k = S.view.k || 1, pad = 12;
    const left = el.offsetLeft * k + S.view.x, right = left + el.offsetWidth * k;
    const top = el.offsetTop * k + S.view.y, bottom = top + el.offsetHeight * k;
    let moved = false;
    if (left < pad) { S.view.x += pad - left; moved = true; }
    else if (right > st.clientWidth - pad) { S.view.x -= right - (st.clientWidth - pad); moved = true; }
    if (top < pad) { S.view.y += pad - top; moved = true; }
    else if (bottom > st.clientHeight - pad) { S.view.y -= bottom - (st.clientHeight - pad); moved = true; }
    if (moved) applyView();
  }

  // Going to a card never re-scales the picture: if the card is already in sight
  // nothing moves at all (the flash says where it is), and only a card that is
  // actually off screen is brought in.
  function center(id) { centerEl($("layer").querySelector(`.node[data-id="${id}"]`)); }
  // 刚入图的那张卡：在眼前就只闪一下，画面一动不动；真在屏幕外才挪最小的那一步
  // 把它带进来，绝不为了它把镜头甩到远处。
  function showNew(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`);
    if (!el) return;
    keepInView(id);
    flash(id);
  }
  function centerEl(el) {
    if (!el) return;
    const st = $("stage"), s = st.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top >= s.top + 8 && r.bottom <= s.bottom - 8 && r.left >= s.left + 8 && r.right <= s.right - 8) return;
    if (!S.view) S.view = { k: 1, x: 0, y: 0 };
    const k = S.view.k;
    S.view.x = st.clientWidth / 2 - (el.offsetLeft + Math.min(el.offsetWidth, st.clientWidth - 40) / 2) * k;
    S.view.y = 48 - el.offsetTop * k;
    applyView();
  }
  function flash(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`);
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }
  (function wireStage() {
    const st = $("stage");
    const ON_TOP = "#quick-card, #export-panel, #edge-panel, #relation-index";
    st.addEventListener("pointerdown", e => {
      // A press that lands on one of the floating panels is a press on that
      // panel: capturing the pointer here would swallow its own buttons' clicks.
      if (e.target.closest(ON_TOP)) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl on a card is 「挂到它下面」, never a box. Everywhere else —
        // background or the imported document's sentences — it draws a box.
        if (e.target.closest(".node")) return;
        e.preventDefault();
        startMarquee(e);
        return;
      }
      if (e.target.closest(".node, .source")) return;
      const sx = e.clientX, sy = e.clientY, vx = S.view.x, vy = S.view.y;
      st.classList.add("panning"); st.setPointerCapture(e.pointerId);
      st.onpointermove = ev => { S.view.x = vx + ev.clientX - sx; S.view.y = vy + ev.clientY - sy; applyView(); };
      st.onpointerup = () => { st.onpointermove = st.onpointerup = null; st.classList.remove("panning"); };
    });
    st.addEventListener("wheel", e => {
      if (e.target.closest("textarea, .cands")) return;
      e.preventDefault();
      const r = st.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)) {
        S.view.x -= e.deltaX; S.view.y -= e.deltaY; return applyView();  // trackpad two-finger scroll pans
      }
      const k = Math.max(1, Math.min(2.5, S.view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      S.view.x = mx - (mx - S.view.x) * k / S.view.k; S.view.y = my - (my - S.view.y) * k / S.view.k; S.view.k = k;
      applyView();
    }, { passive: false });
  })();
  // The pane is resized whenever the shared column's grip moves, so the layout
  // follows the width it actually has.
  let paneT;
  const paneResized = () => { clearTimeout(paneT); paneT = setTimeout(() => { if (S.data) render(); }, 140); };
  window.addEventListener("resize", paneResized);
  if (window.ResizeObserver) new ResizeObserver(paneResized).observe($("stage"));

  // ------------------------------------------------------------- top bar
  // Always keep information at a readable size.
  $("fit").onclick = () => autoLayout();
  $("mode-toggle").onclick = () => {
    S.mode = S.mode === "map" ? "outline" : "map";
    $("mode-toggle").classList.toggle("active", S.mode === "outline");
    $("mode-toggle").title = S.mode === "outline" ? "回到脑图" : "切换 Outliner";
    saveStateSoon();
    render();
  };
  $("relation-toggle").onclick = () => { S.relationIndexOpen = !S.relationIndexOpen; $("relation-toggle").classList.toggle("active", S.relationIndexOpen); renderRelationIndex(); };
  $("new-card").onclick = () => {
    S.quickCardOpen = !S.quickCardOpen;
    $("quick-card").hidden = !S.quickCardOpen;
    $("new-card").classList.toggle("active", S.quickCardOpen);
    if (S.quickCardOpen) $("quick-body").focus();
  };
  $("quick-cancel").onclick = () => { S.quickCardOpen = false; $("quick-card").hidden = true; $("new-card").classList.remove("active"); };
  // A card written here goes either under the mount point or under the card you
  // have selected — the second one is how you write a sub-item of a card
  // without moving the mount point first.
  async function saveQuick(parent) {
    const title = $("quick-title").value.trim(), body = $("quick-body").value.trim();
    if (!body) return say("先写正文");
    const ok = await act(async () => {
      const c = await api("POST", "cards", { title, body, units: [], parent });
      S.lastNew = c.id;
    }, "新卡已挂到「" + node(parent).title + "」下面", null);
    if (ok) { $("quick-title").value = ""; $("quick-body").value = ""; $("quick-cancel").click(); if (S.lastNew) { render(); showNew(S.lastNew); } }
  }
  $("quick-save").onclick = () => saveQuick(S.data.target);
  $("quick-save-child").onclick = () => {
    if (S.selected == null || !node(S.selected)) return say("先点一下要当作上级的那张卡，再按这个按钮");
    if (node(S.selected).root) return say("根节点已经在最上面了，用「挂到当前节点」就行");
    saveQuick(S.selected);
  };
  $("quick-body").onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("quick-save").click(); } };
  // ---------------------------------------------------------------- 图片
  // 一张图可以粘进卡片、拖到画布上，或者用路径导入：图片存在服务端（按内容命名，
  // 同一张图只存一份），卡片正文里留下一行 ![](/images/xxx.png)，渲染、导出、打印
  // 都跟着走。
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
  const imageFiles = list => [...(list || [])].filter(f => f && (/^image\//.test(f.type || "") || IMAGE_EXT.test(f.name || "")));

  async function uploadImage(file) {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(new Error("读不出这个文件"));
      fr.readAsDataURL(file);
    });
    return api("POST", "images", { data_b64: dataUrl, name: file.name || "image" });
  }
  function insertAtCaret(el, text) {
    if (document.activeElement !== el && el.selectionStart === 0) {
      el.value = String(el.value || "").replace(/\s*$/, "") + text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const start = el.selectionStart == null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd == null ? start : el.selectionEnd;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const imageLine = (text, markdown) => (String(text || "").trim() ? "\n\n" : "") + markdown + "\n";

  async function imageIntoTextarea(ta, file) {
    const up = await uploadImage(file);
    insertAtCaret(ta, imageLine(ta.value, up.markdown));
    say("图片插进来了，保存就生效", true);
  }
  async function imageIntoCard(id, file) {
    const up = await uploadImage(file);
    const n = node(id);
    await act(() => api("PATCH", `cards/${id}`, { body: String(n.body || "").trimEnd() + "\n\n" + up.markdown }),
      "图片放进「" + n.title + "」了", id);
  }
  async function imageAsNewCard(file) {
    const up = await uploadImage(file);
    S.lastNew = null;
    const ok = await act(async () => {
      S.lastNew = (await api("POST", "cards", { title: "", body: up.markdown, units: [], parent: S.data.target })).id;
    }, "图片做成了一张新卡，挂在「" + node(S.data.target).title + "」下", null);
    if (ok && S.lastNew) { showNew(S.lastNew); }
  }
  // 同一个手势在哪儿都能用：编辑框里插到光标处，卡片上追加到这张卡，空白处开新卡。
  async function handleImages(files, target) {
    if (!files.length || !S.data) return;
    const ta = target && target.tagName === "TEXTAREA" ? target : null;
    if (ta) return imageIntoTextarea(ta, files[0]);
    const card = target && target.closest ? target.closest(".node[data-id]") : null;
    if (card && !node(+card.dataset.id).root) return imageIntoCard(+card.dataset.id, files[0]);
    return imageAsNewCard(files[0]);
  }
  document.addEventListener("paste", e => {
    const files = imageFiles(e.clipboardData && e.clipboardData.files);
    if (!files.length || !S.data) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|select)$/i.test(t.tagName || ""))) return;
    e.preventDefault();
    handleImages(files, t).catch(fail);
  });
  ["dragover", "drop"].forEach(ev => document.addEventListener(ev, e => {
    const files = imageFiles(e.dataTransfer && e.dataTransfer.files);
    if (!files.length || !S.data) return;
    e.preventDefault();
    if (ev === "dragover") return;
    handleImages(files, e.target).catch(fail);
  }));

  // ------------------------------------------------------------ exporting
  // Four shapes of the same library. The text is always shown here first: a
  // panel inside a frame must never answer an export with a silent download.
  const EXPORT_FMT = { markdown: "Markdown 大纲", mermaid: "Mermaid 图", "mermaid-full": "Mermaid 图（含正文）", json: "JSON 数据" };
  S.exporting = null;
  function exportPanel(open) {
    const box = $("export-panel");
    if (!box) return;
    box.hidden = !open;
    $("export").classList.toggle("active", !!open);
    if (!open) return;
    if (!S.exporting) pickExport("markdown");
  }
  async function pickExport(fmt) {
    const box = $("export-panel");
    const note = $("export-note"), out = $("export-text");
    box.hidden = false;
    $("export").classList.add("active");
    note.textContent = "正在生成…";
    try {
      const d = await api("GET", "export?fmt=" + encodeURIComponent(fmt));
      S.exporting = { fmt, filename: d.filename, mime: d.mime, text: d.text };
      out.value = d.text;
      out.scrollTop = 0;
      const lines = d.text.split("\n").length, kb = (d.text.length / 1024).toFixed(1);
      note.textContent = `${EXPORT_FMT[fmt] || fmt} · ${d.filename} · ${lines} 行 / ${kb} KB`;
      $("export-download").disabled = false;
      $("export-copy").disabled = false;
    } catch (e) {
      S.exporting = null;
      note.textContent = "";
      out.value = "";
      $("export-download").disabled = true;
      $("export-copy").disabled = true;
      fail(e);
    }
  }
  function download() {
    if (!S.exporting) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([S.exporting.text], { type: S.exporting.mime || "text/plain" }));
    a.download = S.exporting.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    say("已导出 " + S.exporting.filename + "（含正文的图或大纲也可以直接复制上面的文字）", true);
  }
  async function copyExport() {
    if (!S.exporting) return;
    const text = S.exporting.text;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch (e) {
      const el = $("export-text");
      el.focus(); el.select();
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    }
    say(ok ? "全部内容已复制到剪贴板" : "复制不了，请在框里手动选中（⌘A ⌘C）", ok);
  }
  $("export").onclick = () => exportPanel($("export-panel").hidden);
  $("export-close").onclick = () => exportPanel(false);
  $("export-panel").querySelectorAll("[data-ex]").forEach(el => el.onclick = () => el.dataset.ex === "pdf" ? exportPdf() : pickExport(el.dataset.ex));
  $("export-download").onclick = download;
  $("export-copy").onclick = copyExport;
  // Printing is the no-dependency way to a PDF: the print page is laid out for
  // paper, and the system dialog saves it as a file.
  function openPrintPage() {
    const url = "/print?s=" + encodeURIComponent(S.session) + "&t=" + encodeURIComponent(S.sessionTitle) + "&auto=1";
    const w = window.open(url, "_blank");
    if (!w) return say("浏览器拦住了新标签页，放行后再点一次（也要打开 /print）");
    say("打印页面开在新标签里：在打印对话框把「目标」选成「另存为 PDF」", true);
  }
  $("export-print").onclick = openPrintPage;
  // PDF: the print page, rendered by a browser on this machine (the server does
  // it), handed over as a file. Nothing to preview — it either downloads or the
  // print page opens instead.
  async function exportPdf() {
    const note = $("export-note");
    note.textContent = "正在生成 PDF（浏览器排版，几秒钟）…";
    let blob, name;
    try {
      const r = await fetch(apiUrl("pdf"), { cache: "no-store" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: "HTTP " + r.status }));
        note.textContent = "";
        say(e.error + "——已改为打开打印页面");
        return openPrintPage();
      }
      blob = await r.blob();
      name = (/filename\*?=(?:UTF-8'')?"?([^";]+)"?/.exec(r.headers.get("content-disposition") || "") || [, "knowledge_tree.pdf"])[1];
      name = decodeURIComponent(name);
    } catch (e) { note.textContent = ""; return fail(e); }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    note.textContent = `PDF · ${name} · ${(blob.size / 1024).toFixed(0)} KB`;
    say("PDF 已导出：" + name, true);
  }

  let searchT;
  // Searching the library means searching everything you kept, not only the two
  // fields a card draws: what you wrote, the sentence it came from, the note you
  // left while checking it, and the sentences of an imported document that are
  // still waiting in the lane. Case, full-width and extra spaces never matter —
  // NFKC folds ｆｕｌｌ－ｗｉｄｔｈ into plain letters and lowercase folds the rest.
  const norm = text => String(text == null ? "" : text).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  function cardHay(n) {
    return norm([n.title, n.body, n.check_note, ...(n.origins || []).map(o => o.text)].join("\n"));
  }
  // What matches right now, in reading order: cards down the tree, then the
  // sentences of the imported documents on the left.
  function refreshHits() {
    const q = norm($("search").value);
    S.hitQuery = q;
    const terms = q.split(" ").filter(Boolean);
    const hits = [];
    if (terms.length) {
      (function walk(id) {
        const n = node(id);
        const hay = cardHay(n);
        if (terms.every(t => hay.includes(t))) hits.push({ kind: "card", id });
        n.children.forEach(walk);
      })(S.data.root);
      S.data.sources.forEach(s => (S.units.get(s.id) || []).forEach(u => {
        if (u.kind === "heading" || u.kind.endsWith("_legacy")) return;
        if (terms.every(t => norm(u.text).includes(t))) hits.push({ kind: "unit", sid: s.id, uid: u.id, text: u.text });
      }));
    }
    S.hitList = hits;
    S.hits = new Set(hits.filter(h => h.kind === "card").map(h => h.id));
    S.hitIndex = hits.length ? 0 : -1;
    showHitCount();
  }
  // One hit on screen: a card comes to the middle of the board, a sentence of an
  // imported document comes to the middle of the lane — and flashes either way.
  function showHit(hit) {
    if (!hit) return;
    if (hit.kind === "card") {
      reveal(hit.id);
      render();
      center(hit.id);
      flash(hit.id);
      return;
    }
    render();
    const el = $("layer").querySelector(`[data-unit="${hit.uid}"], [data-legacy="${hit.uid}"]`);
    if (!el) return say("这段资料已经删掉了");
    centerEl(el);
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }
  function runSearch() {
    refreshHits();
    if (S.hitIndex >= 0) showHit(S.hitList[0]);
    else render();
  }
  $("search").oninput = () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 200); saveStateSoon(); };
  // Typing is debounced; jumping must not be. Anything that jumps first makes the
  // list match what is in the box right now, then moves — otherwise Enter right
  // after typing reads the previous, empty result and claims there is nothing.
  function ensureHits() {
    clearTimeout(searchT);
    if (norm($("search").value) === S.hitQuery) return false;
    runSearch();
    return true;
  }
  function stepHits(step) {
    const fresh = ensureHits();
    if (!S.hitList.length) {
      const q = $("search").value.trim();
      return say(q ? `「${q}」没有命中。搜的是：卡片标题、正文、原文、核对依据，以及导入资料里的句子`
                   : "先在顶上那个搜索框里打一个词，再按回车跳下一个");
    }
    if (!fresh) gotoHit(step);
  }
  $("search").onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); return void stepHits(e.shiftKey ? -1 : 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); return void stepHits(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); return void stepHits(-1); }
    if (e.key === "Escape") { $("search").value = ""; runSearch(); $("search").blur(); }
  };
  $("hit-next").onclick = () => stepHits(1);
  $("hit-prev").onclick = () => stepHits(-1);
  showHitCount();
  $("import").onkeydown = async e => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim(); if (!v) return;
    const looksPath = /^(~|\/|[A-Za-z]:\\)/.test(v) && !v.includes("\n");
    // 一个图片路径就是一张图卡，不走「资料」那条路
    if (looksPath && IMAGE_EXT.test(v)) {
      e.target.value = "";
      try {
        const up = await api("POST", "images", { path: v });
        S.lastNew = null;
        const ok = await act(async () => {
          S.lastNew = (await api("POST", "cards", { title: "", body: up.markdown, units: [], parent: S.data.target })).id;
        }, "图片做成了一张新卡", null);
        if (ok && S.lastNew) { showNew(S.lastNew); }
      } catch (err) { fail(err); }
      return;
    }
    try {
      const r = await api("POST", "sources", looksPath ? { path: v } : { text: v });
      e.target.value = "";
      for (const s of r.sources) S.units.set(s.id, await api("GET", `sources/${s.id}/units`));
      say(`导入了 ${r.sources.length} 份资料，${r.sources.reduce((a, s) => a + s.units, 0)} 句，点句子就挂到挂载点` + (r.skipped.length ? `；没导的：${r.skipped.join("；")}` : ""), true);
      await reload();
      // What was just imported must be on screen, not somewhere off to the left.
      const box = r.sources.length ? $("layer").querySelector(`.source[data-src="${r.sources[0].id}"]`) : null;
      if (box) { centerEl(box); box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
    } catch (err) { fail(err); }
  };

  // The dsh plugin tells us when a picked sentence has become a card.
  window.addEventListener("message", e => {
    const d = e.data;
    if (!d || d.source !== "km-host") return;
    if (d.type === "refresh") reload(d.card);
    if (d.type === "session" && d.id !== S.session) {
      saveState();                         // the session we are leaving keeps its place
      S.session = d.id || ""; S.sessionTitle = d.title || "";
      S.units.clear(); S.view = null; S.needFit = true;
      S.hits = new Set(); S.hitList = []; S.hitIndex = -1; S.hitQuery = null;
      restoreState();                      // and the one we open gets its own back
      reload();
    }
    if (d.type === "focus" && d.card && S.data && node(d.card)) { reveal(d.card); render(); showNew(d.card); }
  });
  // Clicking [[a link]] inside a card goes to that card.
  document.addEventListener("click", e => {
    const a = e.target.closest("a.wikilink"); if (!a) return;
    e.preventDefault();
    const t = a.dataset.target, hit = Object.values(S.data.nodes).find(n => n.title === t || "#" + n.id === t);
    if (hit) { reveal(hit.id); render(); center(hit.id); flash(hit.id); } else say("还没有「" + t + "」这张卡");
  });

  // Ctrl-drag on the empty canvas draws a box. What is inside it is handled by
  // what it is: cards are folded into one card (every body, origin, child and
  // relation survives), the sentences of an imported document each become a card
  // under the mount point — one gesture instead of twenty clicks.
  let marqueeMoved = false;
  function startMarquee(down) {
    const st = $("stage");
    const box = document.createElement("div");
    box.className = "marquee";
    st.appendChild(box);
    const r0 = st.getBoundingClientRect();
    const x0 = down.clientX, y0 = down.clientY;
    let moved = false;
    const draw = (ev) => {
      const left = Math.min(x0, ev.clientX) - r0.left, top = Math.min(y0, ev.clientY) - r0.top;
      box.style.left = left + "px"; box.style.top = top + "px";
      box.style.width = Math.abs(ev.clientX - x0) + "px";
      box.style.height = Math.abs(ev.clientY - y0) + "px";
    };
    draw(down);
    say("框里的一切会合成一张卡", true);
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) moved = true;
      draw(ev);
    };
    const up = (ev) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      marqueeMoved = moved;
      if (moved) setTimeout(() => { marqueeMoved = false; }, 0);
      const r = { left: Math.min(x0, ev.clientX), right: Math.max(x0, ev.clientX),
                  top: Math.min(y0, ev.clientY), bottom: Math.max(y0, ev.clientY) };
      box.remove();
      if (!moved) return;
      // A box that started on a sentence is a box, not a click on it.
      const swallow = ev2 => { ev2.stopPropagation(); ev2.preventDefault(); };
      document.addEventListener("click", swallow, true);
      setTimeout(() => document.removeEventListener("click", swallow, true), 300);
      const hits = el => {
        const b = el.getBoundingClientRect();
        return b.right >= r.left && b.left <= r.right && b.bottom >= r.top && b.top <= r.bottom;
      };
      // The root is never part of a merge: it is everything, not a card in it.
      const inside = visible().filter(id => !node(id).root)
        .filter(id => { const el = $("layer").querySelector(`.node[data-id="${id}"]`); return el && hits(el); });
      const units = [...$("layer").querySelectorAll(".source .sent:not(.picked)")].filter(hits)
        .map(el => ({ uid: +el.dataset.unit, sid: +el.dataset.srcid }));
      if (!inside.length && !units.length) return say("框里没有卡片，也没有资料句子");
      blockFromBox(units, inside);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  async function mergeBlock(ids, quiet) {
    const [keep, ...absorb] = ids;
    try {
      if (!quiet) say(`正在把 ${ids.length} 张卡合成一张…`, true);
      for (const id of absorb) await api("POST", "cards/merge", { source: id, target: keep });
      S.selected = keep;
      await reload(quiet ? null : keep);
      if (!quiet) say(`${ids.length} 张卡并成了「${node(keep).title}」，正文、原文、下级和关系都在里面`, true);
      center(keep);
      flash(keep);
      return keep;
    } catch (e) { fail(e); return null; }
  }

  // A box is one card. What it holds becomes that card: the sentences of an
  // imported document become its text (each keeping its own origin), and any
  // card in the same box is merged into it. A box of nothing but cards merges
  // them the way it always did.
  async function blockFromBox(units, cards) {
    const texts = [], uids = [];
    for (const { uid, sid } of units) {
      const u = (S.units.get(sid) || []).find(x => x.id === uid);
      if (u) { texts.push(u.text); uids.push(uid); }
    }
    try {
      let keep = null;
      if (uids.length) {
        say(`正在把框里的 ${uids.length} 句合成一张卡…`, true);
        keep = (await api("POST", "cards", { title: "", body: texts.join("\n\n"), units: uids, parent: S.data.target })).id;
        for (const sid of new Set(units.map(u => u.sid))) {
          S.units.set(sid, await api("GET", `sources/${sid}/units`).catch(() => []));
        }
        for (const cid of cards) await api("POST", "cards/merge", { source: cid, target: keep });
        await reload(keep);
        say(`框里的 ${uids.length} 句合成了一张卡` + (cards.length ? `，另外 ${cards.length} 张卡也并了进去` : ""), true);
      } else {
        if (cards.length < 2) return say("框里只有一张卡，至少框两张才能合成一张");
        keep = await mergeBlock(cards, true);
        if (keep == null) return;
        say(`${cards.length} 张卡合成了一张`, true);
      }
      S.selected = keep;
      center(keep);
      flash(keep);
    } catch (e) { fail(e); }
  }

  // The panel keeps itself current: when the page's own files change, this page
  // reloads instead of running yesterday's drawing code in an open panel.
  let pageVersion = null;
  async function watchVersion() {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      const v = (await r.json()).v;
      if (pageVersion === null) pageVersion = v;
      else if (v !== pageVersion) location.reload();
    } catch (e) { /* the server may be restarting; try again next tick */ }
  }
  watchVersion();
  setInterval(watchVersion, 3000);

  // The formula constraint, checked on every layout: every .math-block must be
  // either fully visible or scaled to fit. What is neither is reported to the
  // server (data/repos/selfcheck.json) so a cut formula can never pass silently.
  async function reportMathCheck() {
    const bad = [];
    document.querySelectorAll(".node .math-block").forEach(el => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const scaled = el.firstElementChild && el.firstElementChild.style.transform;
      if (!scaled) {
        const card = el.closest(".node");
        bad.push({ card: card ? card.dataset.id : "?", need: el.scrollWidth, got: el.clientWidth });
      }
    });
    try {
      await fetch("/api/selfcheck?d=" + encodeURIComponent(JSON.stringify({ at: new Date().toISOString(), clipped: bad, checked: document.querySelectorAll(".node .math-block").length })), { cache: "no-store" });
    } catch (e) { /* the server may be restarting */ }
  }

  // The graph belongs to one session: without one there is no library to open,
  // and no default library exists to fall back to.
  if (S.session) reload();
  else {
    $("stage").classList.add("outliner-stage");
    const hint = document.createElement("div");
    hint.id = "loading-hint";
    hint.innerHTML = "<b>这个白板只属于会话</b><br>在 dsh 里打开一个会话，它就是那个会话自己的知识库。";
    $("stage").appendChild(hint);
  }

  $("outline-toggle").onclick = () => {
    S.outlineClosed = !S.outlineClosed;
    saveStateSoon();
    applyOutline();
  };
})();
