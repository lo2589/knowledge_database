// known_manage front end: split & sift → card → link.
(function () {
  const { mount, escapeHtml: esc } = window.KMRender;
  const $ = id => document.getElementById(id);

  // How each relation reads from this card's side (out) and the other side (in).
  const REL = {
    belongs_to:   { out: "属于",       in: "下属" },
    prerequisite: { out: "前提是",     in: "是它们的前提" },
    example_of:   { out: "是…的例子",  in: "例子" },
    refines:      { out: "细化了",     in: "被细化为" },
    contradicts:  { out: "与…矛盾",    in: "与…矛盾" },
    related:      { out: "相关",       in: "相关" },
  };
  const REL_COLOR = { belongs_to: "#2f5bd3", prerequisite: "#b7791f", example_of: "#1f7a4a",
                      refines: "#7c3aed", contradicts: "#c0392b", related: "#8a877f" };

  const S = {
    view: "sift", sources: [], sid: null, units: [], cur: 0, editing: null, checked: new Set(),
    cards: [], cardId: null, relation: "belongs_to",
  };
  try { Object.assign(S, JSON.parse(localStorage.getItem("km-ui") || "{}"), { checked: new Set(), editing: null }); } catch (e) {}
  const remember = () => { try { localStorage.setItem("km-ui", JSON.stringify({ view: S.view, sid: S.sid, cardId: S.cardId, relation: S.relation })); } catch (e) {} };

  async function api(method, path, body) {
    const res = await fetch("/api/" + path, {
      method, headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function toast(msg) {
    let t = $("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t);
      Object.assign(t.style, { position: "fixed", bottom: "18px", left: "50%", transform: "translateX(-50%)", background: "var(--ink)",
        color: "var(--bg)", padding: "7px 14px", borderRadius: "8px", fontSize: "13px", zIndex: 50, transition: "opacity .3s" }); }
    t.textContent = msg; t.style.opacity = 1;
    clearTimeout(t._h); t._h = setTimeout(() => (t.style.opacity = 0), 2200);
  }
  const fail = e => toast("出错了：" + e.message);
  const ago = ms => { const d = (Date.now() - ms) / 1000; return d < 60 ? "刚刚" : d < 3600 ? `${d / 60 | 0} 分钟前` : d < 86400 ? `${d / 3600 | 0} 小时前` : new Date(ms).toLocaleDateString(); };

  // ---------------------------------------------------------------- views
  function show(view) {
    S.view = view; remember();
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + view));
    document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
    if (view === "cards") loadCards();
    if (view === "graph") drawGraph();
  }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => show(b.dataset.view));

  async function refreshStats() {
    const m = await api("GET", "meta");
    $("stats").textContent = `${m.stats.sources} 份资料 · ${m.stats.units} 句 · ${m.stats.cards} 张卡`;
  }

  // ---------------------------------------------------------- ① sources
  async function loadSources() {
    S.sources = await api("GET", "sources");
    if (!S.sources.find(s => s.id === S.sid)) S.sid = S.sources[0] ? S.sources[0].id : null;
    renderSources();
    await loadUnits();
  }
  function renderSources() {
    const box = $("sources");
    if (!S.sources.length) { box.innerHTML = `<div class="empty">还没有资料<br>点右上角「导入」</div>`; return; }
    box.innerHTML = S.sources.map(s => `<div class="src ${s.id === S.sid ? "on" : ""}" data-id="${s.id}">
        <button class="x" data-del="${s.id}" title="删除这份资料（卡片保留）">删除</button>
        <div class="t">${esc(s.title)}</div>
        <div class="c"><span>留 <b>${s.counts.kept}</b></span><span>扔 ${s.counts.dropped}</span><span>未看 ${s.counts.new}</span></div></div>`).join("");
    box.querySelectorAll(".src").forEach(el => el.onclick = e => {
      if (e.target.dataset.del) return;
      S.sid = +el.dataset.id; S.cur = 0; remember(); renderSources(); loadUnits();
    });
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
      const s = S.sources.find(x => x.id === +b.dataset.del);
      if (!confirm(`删除「${s.title}」和它拆出的句子？已经做成的卡片会保留。`)) return;
      await api("DELETE", "sources/" + s.id).catch(fail);
      loadSources(); refreshStats();
    });
  }
  async function refreshSourceCounts() {
    S.sources = await api("GET", "sources");
    renderSources();
  }

  // ------------------------------------------------------------ ① units
  async function loadUnits() {
    S.units = S.sid ? await api("GET", `sources/${S.sid}/units`) : [];
    S.cur = Math.min(S.cur, Math.max(0, S.units.length - 1));
    S.checked = new Set();
    renderUnits();
    renderKept();
  }
  const hideDropped = () => $("hide-dropped") && $("hide-dropped").checked;

  function renderUnits() {
    const box = $("units");
    if (!S.sid) { box.innerHTML = `<div class="empty">导入一份资料，它会被拆成一句一句，你来挑。</div>`; $("sift-bar").innerHTML = ""; return; }
    box.innerHTML = "";
    S.units.forEach((u, i) => box.appendChild(unitRow(u, i)));
    renderBar();
  }
  function renderBar() {
    const done = S.units.filter(u => u.status !== "new" || u.kind === "question").length;
    const kept = S.units.filter(u => u.status === "kept").length;
    const was = hideDropped();
    $("sift-bar").innerHTML = `<span>已过 <b>${done}</b> / ${S.units.length}</span>
      <span class="bar"><i style="width:${S.units.length ? 100 * done / S.units.length : 0}%"></i></span>
      <span>留了 <b>${kept}</b> 句</span><span class="grow"></span>
      <label><input type="checkbox" id="hide-dropped" ${was ? "checked" : ""}> 隐藏扔掉的</label>`;
    $("hide-dropped").onchange = () => document.querySelectorAll(".unit.dropped").forEach(el => el.hidden = hideDropped());
  }
  function unitRow(u, i) {
    const el = document.createElement("div");
    el.className = "unit";
    el.dataset.i = i;
    el.onclick = e => {
      if (e.target.closest("textarea, button, a")) return;
      if (i !== S.cur) select(i, false);
    };
    fillRow(el, u, i);
    return el;
  }
  function fillRow(el, u, i) {
    el.className = `unit ${u.kind} ${u.status} ${i === S.cur ? "cur" : ""}`;
    el.hidden = u.status === "dropped" && hideDropped();
    if (S.editing === u.id) {
      el.innerHTML = `<div class="md"><textarea>${esc(u.text)}</textarea>
        <div class="row gap"><button class="btn small primary" data-a="save">保存 ⌘↵</button><button class="btn small" data-a="cancel">取消 Esc</button></div></div>`;
      const ta = el.querySelector("textarea");
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
      ta.onkeydown = e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(u, ta.value); }
        if (e.key === "Escape") { S.editing = null; fillRow(el, u, i); }
      };
      el.querySelector("[data-a=save]").onclick = () => saveEdit(u, ta.value);
      el.querySelector("[data-a=cancel]").onclick = () => { S.editing = null; fillRow(el, u, i); };
      return;
    }
    el.innerHTML = `<div class="md"></div>${u.cards.length ? `<span class="tag">已成卡</span>` : u.status === "kept" ? `<span class="tag">留</span>` : ""}`;
    mount(el.querySelector(".md"), u.text);
  }
  function rowEl(i) { return $("units").querySelector(`.unit[data-i="${i}"]`); }
  function select(i, scroll = true) {
    if (!S.units.length) return;
    const prev = S.cur;
    S.cur = Math.max(0, Math.min(S.units.length - 1, i));
    // skip hidden (dropped) rows when moving with keys
    if (hideDropped() && S.units[S.cur].status === "dropped" && scroll) {
      const dir = i >= prev ? 1 : -1;
      let j = S.cur;
      while (j >= 0 && j < S.units.length && S.units[j].status === "dropped") j += dir;
      if (j >= 0 && j < S.units.length) S.cur = j; else S.cur = prev;
    }
    rowEl(prev)?.classList.remove("cur");
    const el = rowEl(S.cur);
    el?.classList.add("cur");
    if (scroll) el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  // Keys arrive faster than the server answers. The row and the cursor change
  // at once, so the next key acts on the next sentence; the writes go out one
  // at a time in order, and a failed one reloads the true state.
  let writes = Promise.resolve();
  function setStatus(status) {
    const i = S.cur, u = S.units[i];
    if (!u || u.kind === "question" && status === "dropped") return;
    const next = u.status === status ? "new" : status;
    u.status = next;
    fillRow(rowEl(i), u, i);
    renderBar(); renderKept();
    if (next !== "new") select(i + 1);
    writes = writes
      .then(() => api("PATCH", "units/" + u.id, { status: next }))
      .then(fresh => { Object.assign(u, fresh); refreshSourceCounts(); })
      .catch(e => { fail(e); loadUnits(); });
  }
  async function saveEdit(u, text) {
    try {
      Object.assign(u, await api("PATCH", "units/" + u.id, { text }));
      S.editing = null;
      const i = S.units.indexOf(u);
      fillRow(rowEl(i), u, i); renderKept();
    } catch (e) { fail(e); }
  }
  async function mergeWithPrevious() {
    if (S.cur === 0) return;
    await writes;
    const a = S.units[S.cur - 1], b = S.units[S.cur];
    if (a.kind === "question" || b.kind === "question") return toast("你问的话不和回答合并");
    try {
      const merged = await api("POST", "units/merge", { keep: a.id, absorb: b.id });
      S.cur -= 1;
      await loadUnits();
      select(S.cur);
      toast("已合并：" + merged.text.slice(0, 30));
    } catch (e) { fail(e); }
  }

  // kept panel: what you kept from this source, ready to become cards
  function renderKept() {
    const kept = S.units.filter(u => u.status === "kept");
    const box = $("kept");
    if (!kept.length) { box.innerHTML = `<div class="hint">按 <kbd>Y</kbd> 留下的句子会出现在这里。</div>`; return; }
    box.innerHTML = kept.map(u => `<div class="kept-item ${u.cards.length ? "carded" : ""}">
        <input type="checkbox" data-id="${u.id}" ${S.checked.has(u.id) ? "checked" : ""} ${u.cards.length ? "title='已经做过卡片了，还可以再用'" : ""}>
        <div class="md" data-id="${u.id}"></div></div>`).join("");
    box.querySelectorAll(".md").forEach(el => mount(el, S.units.find(u => u.id === +el.dataset.id).text));
    box.querySelectorAll("input").forEach(cb => cb.onchange = () => cb.checked ? S.checked.add(+cb.dataset.id) : S.checked.delete(+cb.dataset.id));
  }
  $("btn-card-merge").onclick = () => {
    const picked = S.units.filter(u => S.checked.has(u.id));
    if (!picked.length) return toast("先勾选要合成一张卡的句子");
    openEditor({ body: picked.map(u => u.text).join("\n\n"), units: picked.map(u => u.id) });
  };
  $("btn-card-each").onclick = async () => {
    const todo = S.units.filter(u => u.status === "kept" && !u.cards.length);
    if (!todo.length) return toast("没有还没做成卡的句子");
    if (!confirm(`把 ${todo.length} 句各做成一张卡？标题自动取第一句，之后可以改。`)) return;
    try {
      await writes;
      for (const u of todo) await api("POST", "cards", { title: "", body: u.text, units: [u.id] });
      toast(`做好了 ${todo.length} 张卡，去「卡片与链接」把它们连起来`);
      await loadUnits(); refreshStats();
    } catch (e) { fail(e); }
  };

  // ------------------------------------------------------- card editor
  let editorCtx = null;
  function openEditor(ctx) {
    editorCtx = ctx;
    $("card-ed-h").textContent = ctx.cardId ? "改卡片" : "新卡片";
    $("card-ed-title").value = ctx.title || "";
    $("card-ed-body").value = ctx.body || "";
    $("card-ed-err").textContent = "";
    preview();
    $("m-card").classList.add("on");
    setTimeout(() => $(ctx.cardId ? "card-ed-body" : "card-ed-title").focus(), 0);
  }
  let pvTimer;
  function preview() { clearTimeout(pvTimer); pvTimer = setTimeout(() => mount($("card-ed-preview"), $("card-ed-body").value), 120); }
  $("card-ed-body").oninput = preview;
  async function saveCard() {
    const title = $("card-ed-title").value, body = $("card-ed-body").value;
    try {
      await writes;
      const card = editorCtx.cardId
        ? await api("PATCH", "cards/" + editorCtx.cardId, { title, body })
        : await api("POST", "cards", { title, body, units: editorCtx.units || [] });
      $("m-card").classList.remove("on");
      refreshStats();
      if (!editorCtx.cardId) {
        S.checked = new Set();
        if (S.sid) await loadUnits();
        S.cardId = card.id;
        show("cards");
        toast("存好了。现在想想：它跟哪张卡有关？");
        setTimeout(() => $("link-q")?.focus(), 300);
      } else { S.cardId = card.id; loadCards(); }
    } catch (e) { $("card-ed-err").textContent = e.message; }
  }
  $("card-ed-save").onclick = saveCard;
  $("m-card").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCard(); } });

  // --------------------------------------------------------- ② cards
  let qTimer;
  $("card-q").oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadCards, 150); };
  async function loadCards() {
    S.cards = await api("GET", "cards?q=" + encodeURIComponent($("card-q").value));
    if (!S.cardId && S.cards.length) S.cardId = S.cards[0].id;
    renderCardList();
    await renderCard();
  }
  function renderCardList() {
    const box = $("card-list");
    if (!S.cards.length) { box.innerHTML = `<div class="empty">${$("card-q").value ? "没搜到" : "还没有卡片<br>先去 ① 留几句，做成卡"}</div>`; return; }
    box.innerHTML = S.cards.map(c => `<div class="card-item ${c.id === S.cardId ? "on" : ""}" data-id="${c.id}">
        <div class="t">${esc(c.title)}</div><div class="p md"></div>
        <div class="d">${c.degree ? `${c.degree} 条关系` : "<span style='color:var(--drop)'>还没连</span>"} · ${ago(c.updated)}</div></div>`).join("");
    box.querySelectorAll(".card-item").forEach((el, k) => {
      // Rendered, not stripped: a preview full of raw $\theta$ is unreadable.
      mount(el.querySelector(".p"), S.cards[k].body);
      el.onclick = () => { S.cardId = +el.dataset.id; remember(); renderCardList(); renderCard(); };
    });
  }
  async function renderCard() {
    const box = $("card-detail"), side = $("card-links");
    if (!S.cardId) { box.innerHTML = `<div class="empty">选一张卡</div>`; side.innerHTML = ""; return; }
    let c;
    try { c = await api("GET", "cards/" + S.cardId); }
    catch (e) { S.cardId = null; box.innerHTML = `<div class="empty">这张卡不在了</div>`; side.innerHTML = ""; return; }
    box.innerHTML = `<div class="card-view">
        <h1 class="md" id="cv-title"></h1>
        <div class="meta"><span>改于 ${ago(c.updated)}</span>
          <button class="btn small" id="cv-edit">编辑</button><button class="btn small ghost" id="cv-del">删除</button></div>
        <div class="md body" id="cv-body"></div>
        ${c.origins.length ? `<div class="origins"><h4>来自原文（点击回到原处）</h4>${c.origins.map(o =>
          `<div class="origin" data-src="${o.source}" data-unit="${o.unit}"><div class="md"></div><div class="s">— ${esc(o.source_title)}</div></div>`).join("")}</div>` : ""}
      </div>`;
    mount($("cv-title"), c.title, { inline: true });
    mount($("cv-body"), c.body);
    box.querySelectorAll(".origin").forEach((el, k) => {
      mount(el.querySelector(".md"), c.origins[k].text);
      el.onclick = () => jumpToUnit(+el.dataset.src, +el.dataset.unit);
    });
    $("cv-edit").onclick = () => openEditor({ cardId: c.id, title: c.title, body: c.body });
    $("cv-del").onclick = async () => {
      if (!confirm(`删除卡片「${c.title}」？它的关系也会一起删掉，原文句子不受影响。`)) return;
      await api("DELETE", "cards/" + c.id).catch(fail);
      S.cardId = null; loadCards(); refreshStats();
    };
    renderLinks(c);
  }
  function renderLinks(c) {
    const side = $("card-links");
    const groups = [];
    for (const r of Object.keys(REL)) {
      const outs = c.out.filter(l => l.relation === r), ins = c.in.filter(l => l.relation === r);
      if (outs.length) groups.push({ label: "这张卡 " + REL[r].out, items: outs, r, dir: "out" });
      if (ins.length) groups.push({ label: REL[r].in, items: ins, r, dir: "in" });
    }
    side.innerHTML = `<h3>关系</h3>
      ${groups.length ? groups.map(g => `<div class="rel-group"><h4 style="color:${REL_COLOR[g.r]}">${g.label}</h4>
        ${g.items.map(l => `<div class="link"><span class="t" data-go="${l.id}">${esc(l.title)}</span>
          <button data-un="${g.dir === "out" ? c.id : l.id}|${g.r}|${g.dir === "out" ? l.id : c.id}" title="断开">断开</button></div>`).join("")}</div>`).join("")
        : `<div class="hint" style="margin-bottom:12px">还没有关系。一张孤零零的卡很快会忘，把它挂到你已有的知识上。</div>`}
      <div class="add-link">
        <div class="sentence">这张卡</div>
        <select id="link-rel">${Object.entries(REL).map(([k, v]) => `<option value="${k}" ${k === S.relation ? "selected" : ""}>${v.out}</option>`).join("")}</select>
        <input id="link-q" placeholder="搜另一张卡，回车选第一个">
        <div id="link-cands"></div>
      </div>`;
    side.querySelectorAll("[data-go]").forEach(el => el.onclick = () => { S.cardId = +el.dataset.go; remember(); renderCardList(); renderCard(); });
    side.querySelectorAll("[data-un]").forEach(b => b.onclick = async () => {
      const [from, relation, to] = b.dataset.un.split("|");
      await api("DELETE", "links", { from: +from, relation, to: +to }).catch(fail);
      renderCard(); renderCardList();
    });
    $("link-rel").onchange = () => { S.relation = $("link-rel").value; remember(); };
    const cands = async () => {
      const q = $("link-q").value.trim();
      const list = (await api("GET", "cards?q=" + encodeURIComponent(q))).filter(x => x.id !== c.id).slice(0, 8);
      $("link-cands").innerHTML = list.length ? list.map((x, k) => `<div class="cand ${k === 0 && q ? "on" : ""}" data-id="${x.id}">${esc(x.title)}</div>`).join("")
        : `<div class="hint">${q ? "没有匹配的卡" : "还没有别的卡"}</div>`;
      $("link-cands").querySelectorAll(".cand").forEach(el => el.onclick = () => addLink(c.id, +el.dataset.id));
    };
    let t;
    $("link-q").oninput = () => { clearTimeout(t); t = setTimeout(cands, 120); };
    $("link-q").onkeydown = e => {
      if (e.key === "Enter") { const first = $("link-cands").querySelector(".cand"); if (first) addLink(c.id, +first.dataset.id); }
    };
    cands();
  }
  async function addLink(from, to) {
    try {
      await api("POST", "links", { from, relation: $("link-rel").value, to });
      await renderCard(); renderCardList();
      toast("连上了");
    } catch (e) { fail(e); }
  }
  async function jumpToUnit(sid, unitId) {
    S.sid = sid; remember();
    show("sift");
    await loadSources();
    const i = S.units.findIndex(u => u.id === unitId);
    if (i >= 0) select(i);
  }

  // --------------------------------------------------------- ③ graph
  let sim = null;
  async function drawGraph() {
    const g = await api("GET", "graph");
    const svg = $("graph");
    const W = svg.clientWidth || 800, H = svg.clientHeight || 600;
    $("graph-legend").innerHTML = Object.entries(REL).map(([k, v]) => `<span><i style="background:${REL_COLOR[k]}"></i>${v.out}</span>`).join("")
      + `<span>· 拖动节点，滚轮缩放，点节点打开卡片</span>`;
    if (!g.nodes.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">还没有卡片</text>`; return; }
    const prev = new Map((sim ? sim.nodes : []).map(n => [n.id, n]));
    const nodes = g.nodes.map((n, k) => {
      const p = prev.get(n.id);
      const a = 2 * Math.PI * k / g.nodes.length;
      return { ...n, x: p ? p.x : W / 2 + Math.cos(a) * 150, y: p ? p.y : H / 2 + Math.sin(a) * 150, vx: 0, vy: 0 };
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    const edges = g.edges.filter(e => byId.has(e.from) && byId.has(e.to)).map(e => ({ ...e, s: byId.get(e.from), t: byId.get(e.to) }));
    const deg = new Map(); edges.forEach(e => { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); });
    let view = { x: 0, y: 0, k: 1 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `<defs>${Object.entries(REL_COLOR).map(([k, c]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="17" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("")}</defs>
      <g id="vp">${edges.map((e, k) => `<line data-e="${k}" stroke="${REL_COLOR[e.relation]}" marker-end="url(#ar-${e.relation})"/>`).join("")}
      ${nodes.map((n, k) => `<g data-n="${k}"><circle r="${6 + Math.min(8, (deg.get(n.id) || 0) * 1.5)}"/><text text-anchor="middle" dy="${22 + Math.min(8, (deg.get(n.id) || 0) * 1.5)}">${esc(n.title.length > 24 ? n.title.slice(0, 23) + "…" : n.title)}</text></g>`).join("")}</g>`;
    const vp = svg.querySelector("#vp");
    const lines = [...svg.querySelectorAll("line")], gs = [...svg.querySelectorAll("g[data-n]")];
    let drag = null, alpha = 1;
    function tick() {
      if (alpha > 0.02 || drag) {
        alpha *= 0.985;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
          const f = 2200 / d2, d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
        for (const e of edges) {
          const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y, d = Math.hypot(dx, dy) || 1, f = (d - 160) * 0.02;
          e.s.vx += dx / d * f; e.s.vy += dy / d * f; e.t.vx -= dx / d * f; e.t.vy -= dy / d * f;
        }
        for (const n of nodes) {
          n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
          if (n === drag) { n.vx = n.vy = 0; continue; }
          n.x += Math.max(-30, Math.min(30, n.vx * alpha)); n.y += Math.max(-30, Math.min(30, n.vy * alpha));
          n.vx *= 0.6; n.vy *= 0.6;
        }
      }
      edges.forEach((e, k) => { const l = lines[k]; l.setAttribute("x1", e.s.x); l.setAttribute("y1", e.s.y); l.setAttribute("x2", e.t.x); l.setAttribute("y2", e.t.y); });
      nodes.forEach((n, k) => gs[k].setAttribute("transform", `translate(${n.x},${n.y})`));
      if (S.view === "graph") requestAnimationFrame(tick);
    }
    const pt = e => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width / view.k - view.x, y: (e.clientY - r.top) * H / r.height / view.k - view.y }; };
    let moved = false, pan = null;
    gs.forEach((el, k) => el.onpointerdown = e => { e.stopPropagation(); drag = nodes[k]; moved = false; alpha = Math.max(alpha, 0.3); svg.setPointerCapture(e.pointerId); });
    svg.onpointerdown = e => { pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; svg.setPointerCapture(e.pointerId); };
    svg.onpointermove = e => {
      if (drag) { const p = pt(e); drag.x = p.x; drag.y = p.y; moved = true; }
      else if (pan) { const r = svg.getBoundingClientRect(); view.x = pan.vx + (e.clientX - pan.x) * W / r.width / view.k; view.y = pan.vy + (e.clientY - pan.y) * H / r.height / view.k; apply(); }
    };
    svg.onpointerup = () => {
      if (drag && !moved) { S.cardId = drag.id; remember(); show("cards"); }
      drag = null; pan = null;
    };
    svg.onwheel = e => { e.preventDefault(); view.k = Math.max(0.3, Math.min(3, view.k * (e.deltaY < 0 ? 1.1 : 0.9))); apply(); };
    const apply = () => vp.setAttribute("transform", `scale(${view.k}) translate(${view.x},${view.y})`);
    sim = { nodes };
    tick();
  }

  // --------------------------------------------------------- import
  let impMode = "paste", impFiles = [], impSession = null;
  $("btn-import").onclick = () => { $("m-import").classList.add("on"); $("imp-err").textContent = ""; setTimeout(() => $("imp-text").focus(), 0); };
  document.querySelectorAll(".tabs2 button").forEach(b => b.onclick = () => {
    impMode = b.dataset.imp;
    document.querySelectorAll(".tabs2 button").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".imp").forEach(x => x.hidden = x.dataset.imp !== impMode);
    if (impMode === "claude") loadSessions();
  });
  async function loadSessions() {
    $("sessions").innerHTML = `<div class="hint">读取中…</div>`;
    try {
      const list = await api("GET", "claude-sessions");
      $("sessions").innerHTML = list.length ? list.map(s => `<div class="session" data-path="${esc(s.path)}">
          <div class="t">${esc(s.title)}</div><div class="s">${esc(s.project)} · ${ago(s.mtime)}${s.first && s.first !== s.title ? " · " + esc(s.first.slice(0, 50)) : ""}</div></div>`).join("")
        : `<div class="hint">~/.claude/projects 下没有会话记录</div>`;
      $("sessions").querySelectorAll(".session").forEach(el => el.onclick = () => {
        impSession = el.dataset.path;
        $("sessions").querySelectorAll(".session").forEach(x => x.classList.toggle("on", x === el));
      });
    } catch (e) { $("sessions").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  const drop = $("drop");
  $("imp-file").onchange = () => setFiles([...$("imp-file").files]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); setFiles([...e.dataTransfer.files]); };
  function setFiles(files) { impFiles = files; $("imp-files").textContent = files.map(f => f.name).join("、"); }
  const b64 = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result.split(",", 2)[1] || ""); r.onerror = no; r.readAsDataURL(file); });
  $("imp-go").onclick = async () => {
    $("imp-err").textContent = "";
    $("imp-go").disabled = true; $("imp-go").textContent = "导入中…";
    try {
      let made = [];
      if (impMode === "paste") made = await api("POST", "sources", { text: $("imp-text").value, title: $("imp-title").value });
      else if (impMode === "file") {
        if (!impFiles.length) throw new Error("先选文件");
        for (const f of impFiles) made = made.concat(await api("POST", "sources", { filename: f.name, file_b64: await b64(f) }));
      } else {
        if (!impSession) throw new Error("先选一个会话");
        made = await api("POST", "sources", { claude_session: impSession });
      }
      $("m-import").classList.remove("on");
      $("imp-text").value = ""; $("imp-title").value = ""; impFiles = []; $("imp-files").textContent = "";
      S.sid = made[0].id; S.cur = 0; remember();
      show("sift");
      await loadSources(); refreshStats();
      toast(`拆成了 ${made.reduce((a, m) => a + m.units, 0)} 句，用 J/K 往下看，Y 留下`);
    } catch (e) { $("imp-err").textContent = e.message; }
    finally { $("imp-go").disabled = false; $("imp-go").textContent = "导入并拆分"; }
  };
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest(".modal").classList.remove("on"));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("mousedown", e => { if (e.target === m) m.classList.remove("on"); }));

  // --------------------------------------------------------- keyboard
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { document.querySelectorAll(".modal.on").forEach(m => m.classList.remove("on")); }
    if (document.querySelector(".modal.on") || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (S.view !== "sift" || !S.units.length) return;
    const k = e.key.toLowerCase();
    const u = S.units[S.cur];
    if (k === "j" || k === "arrowdown") { e.preventDefault(); select(S.cur + 1); }
    else if (k === "k" || k === "arrowup") { e.preventDefault(); select(S.cur - 1); }
    else if (k === "y" || k === " ") { e.preventDefault(); setStatus("kept"); }
    else if (k === "x") setStatus("dropped");
    else if (k === "e") { e.preventDefault(); S.editing = u.id; fillRow(rowEl(S.cur), u, S.cur); }
    else if (k === "m") mergeWithPrevious();
    else if (k === "c") openEditor({ body: u.text, units: [u.id] });
  });

  // dark-mode code theme
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const hl = () => { $("hl-dark").disabled = !mq.matches; $("hl-light").disabled = mq.matches; };
  mq.addEventListener("change", hl); hl();

  // --------------------------------------------------------- start
  refreshStats().catch(fail);
  loadSources().then(() => show(S.view || "sift")).catch(fail);
})();
