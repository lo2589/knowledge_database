// The knowledge graph: the one screen next to the chat.
//
// Everything happens here, in place, with nothing hidden behind a tab or a
// dialog: the strict tree drawn top-down, every card foldable (its children,
// its body, and each section inside the body), editing, checking, relations,
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
  const COLOR = { prerequisite: "#b7791f", example_of: "#1f7a4a", refines: "#7c3aed", contradicts: "#c0392b", related: "#8a877f", mentions: "#9ca3af" };
  const DASH = { related: "2 4", mentions: "6 4" };
  const CHECK = { unchecked: "未核对", ok: "对", fixed: "改正过", doubt: "存疑", wrong: "错" };
  const SECTIONS = [["content", "内容"], ["origin", "原文"], ["check", "核对"], ["rel", "关系"], ["child", "子信息"]];
  const W = 270, W_OPEN = 420, HGAP = 26, VGAP = 64;

  // ---------------------------------------------------------------- state
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const S = {
    data: null,
    folded: new Set(load("g-folded", [])),      // cards whose children you folded away (everything else is open)
    body: new Set(load("g-body", [])),          // cards whose body is shown
    closed: new Set(load("g-closed", [])),      // "id:section" folded inside an open body
    srcOpen: new Set(load("g-src", [])),        // imported sources unfolded
    rel: new Set(load("g-rel", ["prerequisite", "example_of", "refines", "contradicts", "related", "mentions"])),
    view: load("g-view", null),
    editing: null, writing: null, armed: null, hits: new Set(), units: new Map(), linkQ: {},
  };
  const persist = () => {
    save("g-folded", [...S.folded]); save("g-body", [...S.body]); save("g-closed", [...S.closed]);
    save("g-src", [...S.srcOpen]); save("g-rel", [...S.rel]);
  };

  async function api(method, path, body) {
    const r = await fetch("/api/" + path, { method, headers: body ? { "Content-Type": "application/json" } : {},
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
  async function reload(focus) {
    try { S.data = await api("GET", "canvas"); }
    catch (e) { return say("知识图打不开：" + e.message); }
    for (const id of [...S.folded, ...S.body]) if (!S.data.nodes[id]) { S.folded.delete(id); S.body.delete(id); }
    if (focus && node(focus)) reveal(focus);
    await renderRepos();
    render();
    if (focus && node(focus)) { center(focus); flash(focus); }
  }
  function reveal(id) {
    for (let p = node(id).parent; p != null; p = node(p).parent) S.folded.delete(p);
    persist();
  }

  async function renderRepos() {
    const r = await api("GET", "repos").catch(() => null);
    if (!r) return;
    $("repo").innerHTML = r.repos.map(x => `<option value="${esc(x.path)}" ${x.current ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  }

  // ------------------------------------------------------------- drawing
  function visible() {
    const out = [], q = [S.data.root];
    while (q.length) { const id = q.shift(); out.push(id); if (!S.folded.has(id)) q.push(...node(id).children); }
    return out;
  }
  const width = id => S.body.has(id) ? W_OPEN : W;
  const secOpen = (id, s) => !S.closed.has(id + ":" + s);

  function nodeHtml(id) {
    const n = node(id), ch = n.children.length, open = !S.folded.has(id), body = S.body.has(id);
    const cls = ["node", n.check, n.root ? "root" : "", id === S.data.target ? "target" : "", S.hits.has(id) ? "hit" : ""].join(" ");
    let h = `<div class="${cls}" data-id="${id}" style="width:${width(id)}px">
      <div class="nh" data-drag="${id}">
        <button class="tog ${ch ? "" : "leaf"}" data-tog="${id}" title="${open ? "收起下一级" : "展开下一级"}">${open ? "−" : "+"}<small>${ch}</small></button>
        <span class="dot ${n.check}" title="${CHECK[n.check]}"></span>
        <span class="ttl md" data-ttl="${id}" title="双击改标题"></span>
        ${id === S.data.target ? `<span class="badge-t" title="聊天里点选的句子挂到这里">挂载点</span>` : ""}
        <button class="bodytog" data-body="${id}" title="${body ? "收起内容" : "展开内容"}">${body ? "▴" : "▾"}</button>
      </div>
      ${!body && !n.root ? `<div class="pre md" data-pre="${id}"></div>` : ""}
      <div class="meta"><span>#${id} · 第${n.level}层 · 第${n.order}个</span>${n.origins.length ? `<span>原文 ${n.origins.length}</span>` : ""}${n.edited ? `<span class="edited">已改</span>` : ""}</div>`;
    if (body) {
      for (const [s, label] of SECTIONS) {
        const count = s === "origin" ? n.origins.length : s === "rel" ? n.out.filter(l => l.relation !== "belongs_to").length + n.in.filter(l => l.relation !== "belongs_to").length + n.mentions_out.length
          : s === "child" ? ch : null;
        const act = s === "content" && S.editing !== id ? `<button class="act" data-edit="${id}">✎ 改</button>` : "";
        h += `<div class="sec"><div class="sh" data-sec="${id}:${s}"><span class="arrow">${secOpen(id, s) ? "▾" : "▸"}</span>${label}${count != null ? ` (${count})` : ""}${act}</div>`;
        if (secOpen(id, s)) h += `<div class="sb">${sectionHtml(id, s)}</div>`;
        h += `</div>`;
      }
      h += `<div class="foot">
        ${id === S.data.target ? `<span class="hint" style="font-size:11.5px;color:var(--accent)">聊天里点的句子会挂到这张卡下</span>` : `<button data-target="${id}">新知识挂到这里</button>`}
        <span class="grow"></span>
        ${n.root ? "" : `<button class="danger ${S.armed === id ? "armed" : ""}" data-del="${id}">${S.armed === id ? "再点一次确认删除" : "删除"}</button>`}
      </div>`;
    }
    return h + `</div>`;
  }

  function sectionHtml(id, s) {
    const n = node(id);
    if (s === "content") {
      if (S.editing === id) return `<div class="editor">
        <textarea data-editbody="${id}">${esc(n.body)}</textarea>
        <div class="pv md" data-pv="${id}"></div>
        <div class="row"><button data-save="${id}">保存</button><button data-cancel="${id}">取消</button>
          <span style="font-size:11px;color:var(--muted)">⌘↵ 保存 · Esc 取消 · 原句会一直保留在「原文」里</span></div></div>`;
      return `<div class="md" data-bodymd="${id}"></div>`;
    }
    if (s === "origin") {
      if (!n.origins.length) return `<div style="font-size:12px;color:var(--muted)">你自己写的，没有原文。</div>`;
      return n.origins.map((o, k) => `<div class="origin"><div class="md" data-orig="${id}:${k}"></div>
        <div class="src"><span>— ${esc(o.source_title)}</span><button class="jump" data-jump="${id}:${k}">↗ 跳到原文</button></div></div>`).join("")
        + (n.edited ? `<div style="font-size:11px;color:var(--fixed)">内容已改过，上面是原句。</div>` : "");
    }
    if (s === "check") {
      return `<div class="checks">${Object.entries(CHECK).map(([k, v]) => `<button class="ck ${k} ${n.check === k ? "on" : ""}" data-ck="${id}:${k}">${v}</button>`).join("")}</div>
        <input class="note" data-note="${id}" value="${esc(n.check_note)}" placeholder="依据：对照了哪段代码、哪篇文章（回车保存）">`;
    }
    if (s === "rel") {
      const rows = [];
      n.out.filter(l => l.relation !== "belongs_to").forEach(l => rows.push(`<div class="rel"><b style="color:${COLOR[l.relation]}">${REL[l.relation]}</b>
        <span class="t" data-go="${l.id}">${esc(l.title)}</span><button class="x" data-unlink="${id}|${l.relation}|${l.id}" title="断开">×</button></div>`));
      n.in.filter(l => l.relation !== "belongs_to").forEach(l => rows.push(`<div class="rel"><span class="t" data-go="${l.id}">${esc(l.title)}</span>
        <b style="color:${COLOR[l.relation]}">${REL_IN[l.relation]}</b><button class="x" data-unlink="${l.id}|${l.relation}|${id}" title="断开">×</button></div>`));
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

  function sourceHtml(src) {
    const open = S.srcOpen.has(src.id), units = S.units.get(src.id);
    let h = `<div class="source" data-src="${src.id}" style="width:320px">
      <div class="nh"><button class="tog" data-srctog="${src.id}">${open ? "−" : "+"}</button><span class="ttl">${esc(src.title)}</span>
        <button class="bodytog" data-srcdel="${src.id}" title="删掉这份资料（已做成的卡片保留）">×</button></div>`;
    if (open) {
      if (!units) h += `<div class="sent">读取中…</div>`;
      else h += units.filter(u => u.kind !== "heading").map(u => `<div class="sent ${u.cards.length ? "picked" : ""}" data-unit="${u.id}" data-srcid="${src.id}" title="点一下：做成卡片，挂到挂载点下">
          <div class="md" data-sent="${u.id}"></div>${u.cards.length ? `<span class="tag">✓ 已成卡</span>` : ""}</div>`).join("");
    }
    return h + `</div>`;
  }

  function render() {
    const d = S.data, layer = $("layer");
    const vis = visible();
    const srcs = d.sources;
    layer.innerHTML = `<svg id="edges"></svg>`
      + (srcs.length ? `<div class="lane-h" id="lane-h">导入的资料（点句子 → 挂到挂载点）</div>` : "")
      + srcs.map(sourceHtml).join("") + vis.map(nodeHtml).join("");

    // markdown everywhere it appears
    vis.forEach(id => {
      const n = node(id);
      mount(layer.querySelector(`[data-ttl="${id}"]`), n.title, { inline: true });
      const b = layer.querySelector(`[data-bodymd="${id}"]`); if (b) mount(b, n.body, { refs: n.refs });
      n.origins.forEach((o, k) => { const el = layer.querySelector(`[data-orig="${id}:${k}"]`); if (el) mount(el, o.text); });
      const pv = layer.querySelector(`[data-pv="${id}"]`); if (pv) mount(pv, n.body);
      const pre = layer.querySelector(`[data-pre="${id}"]`); if (pre) mount(pre, n.body);
    });
    srcs.forEach(s => (S.units.get(s.id) || []).forEach(u => { const el = layer.querySelector(`[data-sent="${u.id}"]`); if (el) mount(el, u.text); }));

    layout(vis, srcs);
    wire(layer);
    renderOutline();
    $("target").innerHTML = `新知识挂到：<b>${esc(node(d.target).title)}</b>`;
    renderLegend();
    applyView();
  }

  // Tidy top-down tree: each subtree as wide as it needs, parents centred
  // over children, each level below the tallest box of the level above.
  let pos = {};
  function layout(vis, srcs) {
    const layer = $("layer"), box = id => layer.querySelector(`.node[data-id="${id}"]`);
    const shown = id => S.folded.has(id) ? [] : node(id).children;
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
    vis.forEach(id => { const b = box(id); b.style.left = pos[id].x + "px"; b.style.top = pos[id].y + "px"; });

    // imported sources: a column to the left of the tree
    let sy = 26;
    const lh = $("lane-h"); if (lh) { lh.style.left = "-370px"; lh.style.top = "0px"; }
    srcs.forEach(s => {
      const el = layer.querySelector(`.source[data-src="${s.id}"]`);
      el.style.left = "-370px"; el.style.top = sy + "px"; sy += el.offsetHeight + 14;
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
    S.data.refs.filter(r => S.rel.has(r.relation) && isVis.has(r.from) && isVis.has(r.to)).forEach((r, k) => {
      const a = rect(r.from), b = rect(r.to), ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const side = bc.x >= ac.x ? 1 : -1, same = Math.abs(a.y - b.y) < 10;
      const p1 = same ? { x: ac.x, y: a.y + a.h } : { x: side > 0 ? a.x + a.w : a.x, y: ac.y };
      const p2 = same ? { x: bc.x, y: b.y + b.h + 4 } : { x: side > 0 ? b.x - 4 : b.x + b.w + 4, y: bc.y };
      const bend = same ? 46 + 12 * (k % 4) : 0;
      const c1 = same ? { x: p1.x, y: p1.y + bend } : { x: p1.x + side * 60, y: p1.y };
      const c2 = same ? { x: p2.x, y: p2.y + bend } : { x: p2.x - side * 60, y: p2.y };
      const lx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, ly = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
      html += `<path class="rel" d="M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}" stroke="${COLOR[r.relation]}"
        stroke-dasharray="${DASH[r.relation] || ""}" marker-end="url(#m-${r.relation})"/><text x="${lx}" y="${ly}" fill="${COLOR[r.relation]}">${REL[r.relation]}</text>`;
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
      const id = +el.dataset.os; S.srcOpen.add(id); persist();
      if (!S.units.has(id)) S.units.set(id, await api("GET", `sources/${id}/units`).catch(() => []));
      render(); const b = $("layer").querySelector(`.source[data-src="${id}"]`); if (b) centerEl(b);
    });
  }

  function renderLegend() {
    const count = r => S.data.refs.filter(x => x.relation === r).length;
    $("legend").innerHTML = `<span><i style="background:#bdb9b0"></i> 层级（属于）</span>` + Object.keys(COLOR).map(r =>
      `<label><input type="checkbox" data-legend="${r}" ${S.rel.has(r) ? "checked" : ""}><i style="background:${COLOR[r]}"></i>${REL[r]} ${count(r)}</label>`).join("")
      + `<span style="margin-left:auto">点卡片头 = 设为挂载点 · 拖卡片头到另一张卡 = 挂到它下面（拖到左右边 = 排在它前后）· 双击标题改名 · 拖空白处平移 · 滚轮缩放</span>`;
    $("legend").querySelectorAll("[data-legend]").forEach(cb => cb.onchange = () => {
      cb.checked ? S.rel.add(cb.dataset.legend) : S.rel.delete(cb.dataset.legend); persist(); render();
    });
  }

  // ------------------------------------------------------------- actions
  const toggle = (set, v) => { set.has(v) ? set.delete(v) : set.add(v); persist(); };
  async function act(fn, ok, focus) {
    try { await fn(); if (ok) say(ok, true); await reload(focus); } catch (e) { fail(e); }
  }

  function wire(layer) {
    const on = (sel, ev, fn) => layer.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));
    on("[data-tog]", "click", (el, e) => { e.stopPropagation(); toggle(S.folded, +el.dataset.tog); render(); keepInView(+el.dataset.tog); });
    on("[data-body]", "click", (el, e) => { e.stopPropagation(); toggle(S.body, +el.dataset.body); render(); keepInView(+el.dataset.body); });
    on("[data-sec]", "click", (el, e) => { if (e.target.closest("[data-edit]")) return; toggle(S.closed, el.dataset.sec); render(); keepInView(+el.dataset.sec.split(":")[0]); });
    on("[data-edit]", "click", (el, e) => { e.stopPropagation(); S.editing = +el.dataset.edit; S.closed.delete(el.dataset.edit + ":content"); render(); keepInView(S.editing); $("layer").querySelector(`[data-editbody="${el.dataset.edit}"]`)?.focus({ preventScroll: true }); });
    on("[data-editbody]", "input", el => mount(layer.querySelector(`[data-pv="${el.dataset.editbody}"]`), el.value));
    on("[data-editbody]", "keydown", (el, e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBody(+el.dataset.editbody, el.value); }
      if (e.key === "Escape") { S.editing = null; render(); }
    });
    on("[data-save]", "click", el => saveBody(+el.dataset.save, layer.querySelector(`[data-editbody="${el.dataset.save}"]`).value));
    on("[data-cancel]", "click", () => { S.editing = null; render(); });
    on("[data-ttl]", "dblclick", el => { clearTimeout(clickTimer); renameInline(el, +el.dataset.ttl); });
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
    on("[data-go]", "click", el => { const id = +el.dataset.go; reveal(id); render(); center(id); flash(id); });
    on("[data-unlink]", "click", el => {
      const [from, relation, to] = el.dataset.unlink.split("|");
      act(() => api("DELETE", "links", { from: +from, relation, to: +to }), "断开了", +from);
    });
    on("[data-relq]", "input", el => { S.linkQ[el.dataset.relq] = el.value; candidates(+el.dataset.relq, el.value); });
    on("[data-relq]", "keydown", (el, e) => {
      if (e.key !== "Enter") return;
      const first = layer.querySelector(`[data-cands="${el.dataset.relq}"] .cand`); if (first) first.click();
    });
    on("[data-relq]", "focus", el => candidates(+el.dataset.relq, el.value));
    on("[data-target]", "click", (el, e) => { e.stopPropagation(); setTarget(+el.dataset.target); });
    on("[data-del]", "click", (el, e) => {
      e.stopPropagation(); const id = +el.dataset.del;
      if (S.armed !== id) { S.armed = id; render(); setTimeout(() => { if (S.armed === id) { S.armed = null; render(); } }, 3500); return; }
      S.armed = null; act(() => api("DELETE", `cards/${id}`), "删掉了，它的下级接到了它的上级下面");
    });
    on("[data-write]", "click", el => { S.writing = +el.dataset.write; render(); keepInView(S.writing); $("layer").querySelector(`[data-newchild="${el.dataset.write}"]`)?.focus({ preventScroll: true }); });
    on("[data-cancelchild]", "click", () => { S.writing = null; render(); });
    on("[data-savechild]", "click", el => saveChild(+el.dataset.savechild));
    on("[data-newchild]", "keydown", (el, e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveChild(+el.dataset.newchild); }
      if (e.key === "Escape") { S.writing = null; render(); }
    });
    // Header click = this card becomes where new picks go. It waits out the
    // double-click window: setting the target redraws the canvas, and a redraw
    // between the two clicks would swallow the double-click that renames.
    on(".nh[data-drag]", "click", (el, e) => {
      if (e.target.closest("button, [contenteditable=true]") || dragMoved) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => setTarget(+el.dataset.drag), 260);
    });
    on("[data-drag]", "pointerdown", (el, e) => startDrag(el, e));
    // imported sources
    on("[data-srctog]", "click", async (el, e) => {
      e.stopPropagation(); const id = +el.dataset.srctog;
      toggle(S.srcOpen, id);
      if (S.srcOpen.has(id) && !S.units.has(id)) S.units.set(id, await api("GET", `sources/${id}/units`).catch(() => []));
      render();
    });
    on("[data-srcdel]", "click", (el, e) => {
      e.stopPropagation(); const id = +el.dataset.srcdel;
      if (!confirmInline(el)) return;
      act(() => api("DELETE", `sources/${id}`), "资料删掉了，卡片还在");
    });
    on("[data-unit]", "click", el => {
      const uid = +el.dataset.unit, sid = +el.dataset.srcid, u = S.units.get(sid).find(x => x.id === uid);
      act(async () => {
        const c = await api("POST", "cards", { title: "", body: u.text, units: [uid], parent: S.data.target });
        S.units.set(sid, await api("GET", `sources/${sid}/units`));
        S.lastNew = c.id;
      }, "挂上了", null).then(() => { if (S.lastNew) { reveal(S.lastNew); render(); center(S.lastNew); flash(S.lastNew); } });
    });
  }

  function confirmInline(el) {
    if (el.dataset.armed) return true;
    el.dataset.armed = "1"; el.textContent = "确认？"; el.classList.add("danger", "armed");
    setTimeout(() => { delete el.dataset.armed; el.textContent = "×"; el.classList.remove("armed"); }, 3000);
    return false;
  }

  function saveBody(id, body) {
    S.editing = null;
    act(() => api("PATCH", `cards/${id}`, { body }), "改好了，原句还在「原文」里", id);
  }
  function saveChild(id) {
    const ta = $("layer").querySelector(`[data-newchild="${id}"]`);
    if (!ta || !ta.value.trim()) return say("先写点内容");
    const body = ta.value;
    S.writing = null; S.folded.delete(id); persist();
    act(async () => { S.lastNew = (await api("POST", "cards", { title: "", body, units: [], parent: id })).id; }, "子信息挂上了")
      .then(() => { if (S.lastNew) { center(S.lastNew); flash(S.lastNew); } });
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
    try { await api("POST", "target", { id }); S.data.target = id; render(); say("聊天里点的句子现在挂到「" + node(id).title + "」下", true); }
    catch (e) { fail(e); }
  }
  async function candidates(id, q) {
    const box = $("layer").querySelector(`[data-cands="${id}"]`);
    if (!box) return;
    const list = (await api("GET", "cards?q=" + encodeURIComponent(q || "")).catch(() => [])).filter(c => c.id !== id).slice(0, 6);
    box.innerHTML = list.map(c => `<div class="cand" data-pick="${c.id}">${esc(c.title)}</div>`).join("") || `<div class="cand">没有匹配的卡</div>`;
    box.querySelectorAll("[data-pick]").forEach(el => el.onclick = () => {
      const relation = $("layer").querySelector(`[data-relkind="${id}"]`).value;
      S.linkQ[id] = "";
      act(() => api("POST", "links", { from: id, relation, to: +el.dataset.pick }), relation === "belongs_to" ? "挂过去了" : "连上了", id);
    });
  }

  // Every piece of knowledge links back to where it was said.
  function jump(o) {
    if (o.dsh_message) {
      if (EMBEDDED) window.parent.postMessage({ source: "km-app", type: "goto", session: o.dsh_session, message: o.dsh_message, index: o.index }, "*");
      else say("这句原文在 dsh 的会话里，在 dsh 中打开时点它会直接跳过去。");
      return;
    }
    S.srcOpen.add(o.source); persist();
    (async () => {
      if (!S.units.has(o.source)) S.units.set(o.source, await api("GET", `sources/${o.source}/units`).catch(() => []));
      render();
      const el = $("layer").querySelector(`[data-unit="${o.unit}"]`);
      if (!el) return say("原文那份资料已经删掉了");
      centerEl(el); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    })();
  }

  // --------------------------------------------------------- drag to re-file
  let drag = null, dragMoved = false, clickTimer = null;
  function startDrag(handle, e) {
    if (e.button !== 0 || e.target.closest("button, input, [contenteditable=true]")) return;
    const id = +handle.dataset.drag, el = handle.closest(".node");
    const sx = e.clientX, sy = e.clientY;
    dragMoved = false;
    const move = ev => {
      if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!drag) { if (node(id).root) return; drag = { id, el }; el.classList.add("dragging"); dragMoved = true; }
      // Near the edge of the canvas, the canvas scrolls: the card you want to
      // drop onto may be off screen.
      const r0 = $("stage").getBoundingClientRect(), edge = 40, speed = 14;
      const dx = ev.clientX < r0.left + edge ? speed : ev.clientX > r0.right - edge ? -speed : 0;
      const dy = ev.clientY < r0.top + edge ? speed : ev.clientY > r0.bottom - edge ? -speed : 0;
      if (dx || dy) { S.view.x += dx; S.view.y += dy; applyView(); }
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
      const { to } = drag; drag.el.classList.remove("dragging");
      document.querySelectorAll(".node.drop-in, .node.drop-before, .node.drop-after").forEach(x => x.classList.remove("drop-in", "drop-before", "drop-after"));
      drag = null;
      setTimeout(() => (dragMoved = false), 0);
      if (!to) return;
      let body;
      if (to.where === "in") { body = { parent: to.id, before: null }; S.folded.delete(to.id); persist(); }
      else {
        const p = node(to.id).parent, sib = node(p).children.filter(c => c !== id), k = sib.indexOf(to.id);
        body = { parent: p, before: to.where === "before" ? to.id : (sib[k + 1] ?? null) };
      }
      act(() => api("POST", `cards/${id}/move`, body), to.where === "in" ? "挂到「" + node(to.id).title + "」下面了" : "顺序调好了", id);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // --------------------------------------------------------------- view
  function applyView() {
    if (!S.view) return home();
    $("layer").style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
    save("g-view", S.view);
  }
  function fit() {
    const svg = $("edges"), st = $("stage");
    if (!svg) return;
    const hasSrc = S.data.sources.length > 0, left = hasSrc ? -380 : 0;
    const w = +svg.getAttribute("width") - left, h = +svg.getAttribute("height");
    const k = Math.max(0.25, Math.min(1, (st.clientWidth - 40) / w, (st.clientHeight - 40) / h));
    S.view = { k, x: (st.clientWidth - w * k) / 2 - left * k, y: 20 };
    applyView();
  }
  // Readable size, the target card in the middle (fit stays one click away).
  function home() {
    const st = $("stage"), id = S.data.target, el = $("layer").querySelector(`.node[data-id="${id}"]`);
    S.view = { k: 0.95, x: 20, y: 20 };
    if (el) { S.view.x = st.clientWidth / 2 - (el.offsetLeft + el.offsetWidth / 2) * 0.95; S.view.y = Math.max(20, 60 - el.offsetTop * 0.95); }
    applyView();
  }
  // A card you just acted on must stay on screen: opening its body makes it
  // wider and re-lays the tree, which can slide it out of view.
  function keepInView(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`), st = $("stage");
    if (!el) return;
    const r = el.getBoundingClientRect(), s = st.getBoundingClientRect();
    const outX = r.left < s.left + 8 || r.left > s.right - 120;
    const outY = r.top < s.top + 8 || r.top > s.bottom - 60;
    if (outX || outY) {
      const k = S.view.k;
      if (outX) S.view.x = s.width / 2 - (el.offsetLeft + Math.min(el.offsetWidth, s.width - 40) / 2) * k;
      if (outY) S.view.y = 40 - el.offsetTop * k;
      applyView();
    }
  }
  function center(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`); if (el) centerEl(el);
  }
  function centerEl(el) {
    const st = $("stage"), k = S.view.k;
    const x = el.offsetLeft + (el.offsetParent === $("layer") ? 0 : 0), y = el.offsetTop;
    S.view.x = st.clientWidth / 2 - (x + el.offsetWidth / 2) * k;
    S.view.y = Math.min(40, st.clientHeight / 3 - y * k);
    applyView();
  }
  function flash(id) {
    const el = $("layer").querySelector(`.node[data-id="${id}"]`);
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  }
  (function wireStage() {
    const st = $("stage");
    st.addEventListener("pointerdown", e => {
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
      const k = Math.max(0.2, Math.min(2.5, S.view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      S.view.x = mx - (mx - S.view.x) * k / S.view.k; S.view.y = my - (my - S.view.y) * k / S.view.k; S.view.k = k;
      applyView();
    }, { passive: false });
  })();

  // ------------------------------------------------------------- top bar
  // Keep the zoom: shrinking to fit makes text unreadable; 「适配」 is one click away.
  $("expand").onclick = () => { S.folded.clear(); persist(); render(); };
  $("collapse").onclick = () => { S.folded = new Set(S.data.nodes[S.data.root].children); S.body.clear(); persist(); render(); home(); };
  $("fit").onclick = fit;
  $("export").onclick = async () => {
    const d = await api("GET", "structure").catch(fail); if (!d) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    a.download = "knowledge_tree.json"; a.click();
  };
  let searchT;
  $("search").oninput = () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      const q = $("search").value.trim().toLowerCase();
      S.hits = new Set(q ? Object.values(S.data.nodes).filter(n => (n.title + "\n" + n.body).toLowerCase().includes(q)).map(n => n.id) : []);
      S.hits.forEach(reveal);
      render();
      if (S.hits.size) center([...S.hits][0]);
    }, 200);
  };
  $("repo").onchange = () => switchRepo(api("POST", "repos/open", { path: $("repo").value }));
  // One box: a name makes a new repository, a path to a .db opens an existing one.
  $("repo-new").onkeydown = e => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    const v = e.target.value.trim();
    const call = /[\\/]|\.db$/.test(v) ? api("POST", "repos/open", { path: v }) : api("POST", "repos", { name: v });
    switchRepo(call).then(() => (e.target.value = ""));
  };
  async function switchRepo(call) {
    try { await call; S.folded = new Set(); S.body.clear(); S.units.clear(); S.view = null; persist(); await reload(); say("仓库换好了", true); }
    catch (e) { fail(e); }
  }
  $("import").onkeydown = async e => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim(); if (!v) return;
    const looksPath = /^(~|\/|[A-Za-z]:\\)/.test(v) && !v.includes("\n");
    try {
      const r = await api("POST", "sources", looksPath ? { path: v } : { text: v });
      e.target.value = "";
      r.sources.forEach(s => S.srcOpen.add(s.id)); persist();
      for (const s of r.sources) S.units.set(s.id, await api("GET", `sources/${s.id}/units`));
      say(`导入了 ${r.sources.length} 份资料，${r.sources.reduce((a, s) => a + s.units, 0)} 句，点句子就挂到挂载点` + (r.skipped.length ? `；没导的：${r.skipped.join("；")}` : ""), true);
      await reload();
      // What was just imported must be on screen, not somewhere off to the left.
      const box = $("layer").querySelector(`.source[data-src="${r.sources[0].id}"]`);
      if (box) { centerEl(box); box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
    } catch (err) { fail(err); }
  };

  // The dsh plugin tells us when a picked sentence has become a card.
  window.addEventListener("message", e => {
    const d = e.data;
    if (!d || d.source !== "km-host") return;
    if (d.type === "refresh") reload(d.card);
    if (d.type === "focus" && d.card && S.data && node(d.card)) { reveal(d.card); render(); center(d.card); flash(d.card); }
  });
  // Clicking [[a link]] inside a card goes to that card.
  document.addEventListener("click", e => {
    const a = e.target.closest("a.wikilink"); if (!a) return;
    e.preventDefault();
    const t = a.dataset.target, hit = Object.values(S.data.nodes).find(n => n.title === t || "#" + n.id === t);
    if (hit) { reveal(hit.id); render(); center(hit.id); flash(hit.id); } else say("还没有「" + t + "」这张卡");
  });

  // open sources' sentences need loading before the first draw
  (async () => {
    for (const id of S.srcOpen) S.units.set(id, await api("GET", `sources/${id}/units`).catch(() => []));
    reload();
  })();
})();
