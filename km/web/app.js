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
    if (view === "map") drawMap().then(() => { if (!localStorage.getItem("km-map-view")) fitMap(); });
    if (view === "board") drawBoard();
  }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => show(b.dataset.view));

  async function refreshStats() {
    const m = await api("GET", "meta");
    $("stats").textContent = `${m.stats.sources} 份资料 · ${m.stats.units} 句 · ${m.stats.cards} 张卡`;
    if (m.repo) $("repo-name").textContent = m.repo;
  }

  // ------------------------------------------------------- repositories
  // Each repository is its own FastNode file. Switching reloads everything.
  async function openRepoMenu() {
    const menu = $("repo-menu");
    if (!menu.hidden) { menu.hidden = true; return; }
    const r = await api("GET", "repos").catch(fail);
    if (!r) return;
    menu.innerHTML = `<div class="rm-h">知识仓库 <span class="hint">新仓库放在 ${esc(r.home)}</span></div>`
      + r.repos.map(x => `<div class="rm-item ${x.current ? "on" : ""}" data-path="${esc(x.path)}" title="${esc(x.path)}">
          <span>${x.current ? "● " : ""}${esc(x.name)}</span><span class="hint">${(x.size / 1024 | 0)} KB${x.inside_home ? "" : " · 外部"}</span></div>`).join("")
      + `<div class="rm-sep"></div>
         <div class="rm-row"><input id="rm-new" placeholder="新仓库名，回车建好并切过去"></div>
         <div class="rm-row"><input id="rm-open" placeholder="打开已有仓库：.db 文件路径，回车"></div>`;
    menu.hidden = false;
    menu.querySelectorAll(".rm-item").forEach(el => el.onclick = () => switchRepo(api("POST", "repos/open", { path: el.dataset.path })));
    $("rm-new").onkeydown = e => { if (e.key === "Enter") switchRepo(api("POST", "repos", { name: e.target.value })); };
    $("rm-open").onkeydown = e => { if (e.key === "Enter") switchRepo(api("POST", "repos/open", { path: e.target.value })); };
  }
  async function switchRepo(call) {
    try {
      const r = await call;
      $("repo-menu").hidden = true;
      S.sid = null; S.cardId = null; S.units = []; tree = [];
      await refreshStats(); await loadSources(); show(S.view);
      toast("已切到仓库「" + r.repos.find(x => x.current).name + "」");
    } catch (e) { fail(e); }
  }
  $("repo-btn").onclick = openRepoMenu;
  document.addEventListener("mousedown", e => { if (!e.target.closest("#repo")) $("repo-menu").hidden = true; });

  // ------------------------------------------------- embedding (dsh sidebar)
  // ?mode=side switches to the narrow layout; ?source=ID opens that source;
  // ?cwd=PATH pre-fills folder import with the conversation's workspace.
  const params = new URLSearchParams(location.search);
  if (params.get("mode") === "side") document.body.classList.add("side");
  if (params.get("cwd")) $("imp-folder").value = params.get("cwd");
  if (params.get("source")) { S.sid = +params.get("source"); S.cur = 0; S.view = "sift"; }
  // The host page (dsh) tells us when it just put something in: show it.
  window.addEventListener("message", async e => {
    const d = e.data;
    if (!d || d.source !== "km-host") return;
    if (d.type === "open-source" && d.id) {
      S.sid = +d.id; S.cur = 0; remember();
      show("sift"); await loadSources(); refreshStats();
      toast(d.note || "已入库");
    }
    if (d.type === "cwd" && d.cwd) $("imp-folder").value = d.cwd;
    // The sidebar was widened or narrowed: switch between the full and narrow layouts.
    if (d.type === "layout") { document.body.classList.toggle("side", !d.wide); if (S.view === "map") drawMap(); }
  });
  $("kept-head").onclick = () => document.body.classList.contains("side") && $("kept-panel").classList.toggle("open");

  // ---------------------------------------------------------- ① sources
  async function loadSources() {
    S.sources = await api("GET", "sources");
    if (!S.sources.find(s => s.id === S.sid)) S.sid = S.sources[0] ? S.sources[0].id : null;
    renderSources();
    await loadUnits();
  }
  function renderSources() {
    const pick = $("source-pick");
    pick.innerHTML = S.sources.length ? S.sources.map(s => `<option value="${s.id}" ${s.id === S.sid ? "selected" : ""}>${esc(s.title)}（留 ${s.counts.kept}）</option>`).join("")
      : `<option>还没有资料，点「导入」</option>`;
    pick.onchange = () => { S.sid = +pick.value; S.cur = 0; remember(); renderSources(); loadUnits(); };
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
  attachWikiComplete($("card-ed-body"), preview);
  async function saveCard() {
    const title = $("card-ed-title").value, body = $("card-ed-body").value;
    try {
      await writes;
      const card = editorCtx.cardId
        ? await api("PATCH", "cards/" + editorCtx.cardId, { title, body })
        : await api("POST", "cards", { title, body, units: editorCtx.units || [], parent: editorCtx.parent ?? null });
      $("m-card").classList.remove("on");
      refreshStats();
      if (!editorCtx.cardId) {
        S.checked = new Set();
        if (S.sid) await loadUnits();
        S.cardId = card.id; S.editingCard = false;
        show("cards");
        toast("存好了。它该挂在哪张卡下面？跟谁有关？");
        setTimeout(() => $("link-q")?.focus(), 300);
      } else { S.cardId = card.id; if (S.view === "cards") loadCards(); else show("cards"); }
    } catch (e) { $("card-ed-err").textContent = e.message; }
  }
  $("card-ed-save").onclick = saveCard;
  $("m-card").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCard(); } });

  // --------------------------------------------------------- ② cards
  // Left: your hierarchy (drag to re-file). Middle: the card, edited in place.
  // Right: did it check out, and how it relates to other cards.
  const CHECK = { unchecked: "未核对", ok: "对", fixed: "改正过", doubt: "存疑", wrong: "错" };
  let tree = [], collapsed = new Set(JSON.parse(localStorage.getItem("km-collapsed") || "[]"));
  let qTimer;
  $("card-q").oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadCards, 150); };

  async function loadCards() {
    const q = $("card-q").value.trim();
    if (q) {
      S.cards = await api("GET", "cards?q=" + encodeURIComponent(q));
      renderSearch();
    } else {
      tree = await api("GET", "tree");
      renderTree();
    }
    if (!S.cardId) S.cardId = q ? (S.cards[0] || {}).id : (tree[0] || {}).id;
    await renderCard();
  }
  function renderSearch() {
    const box = $("card-list");
    box.innerHTML = S.cards.length ? S.cards.map(c => `<div class="card-item ${c.id === S.cardId ? "on" : ""}" data-id="${c.id}">
        <div class="t md"></div><div class="p md"></div></div>`).join("") : `<div class="empty">没搜到</div>`;
    box.querySelectorAll(".card-item").forEach((el, k) => {
      mount(el.querySelector(".t"), S.cards[k].title, { inline: true });
      mount(el.querySelector(".p"), S.cards[k].body);
      el.onclick = () => openCard(+el.dataset.id);
    });
  }
  function renderTree() {
    const box = $("card-list");
    if (!tree.length) { box.innerHTML = `<div class="empty">还没有卡片<br>先去 ① 留几句，做成卡</div>`; return; }
    const row = (n, depth) => `<div class="tnode" data-id="${n.id}">
        <div class="trow ${n.id === S.cardId ? "on" : ""}" draggable="true" data-id="${n.id}" style="padding-left:${6 + depth * 16}px">
          <span class="tw">${n.children.length ? (collapsed.has(n.id) ? "▸" : "▾") : ""}</span>
          <span class="dot ${n.check}" title="${CHECK[n.check]}"></span>
          <span class="tt md" data-title="${n.id}"></span>
          ${n.children.length ? `<span class="tc">${n.children.length}</span>` : ""}
        </div>
        ${n.children.length && !collapsed.has(n.id) ? n.children.map(c => row(c, depth + 1)).join("") : ""}</div>`;
    box.innerHTML = tree.map(n => row(n, 0)).join("") + `<div class="troot" id="troot">拖到这里 → 放到最顶层</div>`;
    const titles = new Map(); (function walk(ns) { ns.forEach(n => { titles.set(n.id, n.title); walk(n.children); }); })(tree);
    box.querySelectorAll("[data-title]").forEach(el => mount(el, titles.get(+el.dataset.title), { inline: true }));
    box.querySelectorAll(".trow").forEach(el => {
      const id = +el.dataset.id;
      el.onclick = e => {
        if (e.target.classList.contains("tw") && e.target.textContent) {
          collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
          localStorage.setItem("km-collapsed", JSON.stringify([...collapsed]));
          return renderTree();
        }
        openCard(id);
      };
      el.ondragstart = e => { e.dataTransfer.setData("text/km-card", String(id)); e.dataTransfer.effectAllowed = "move"; };
      el.ondragover = e => {
        e.preventDefault();
        const r = el.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
        el.dataset.drop = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
      };
      el.ondragleave = () => delete el.dataset.drop;
      el.ondrop = async e => {
        e.preventDefault();
        const where = el.dataset.drop; delete el.dataset.drop;
        const moving = +e.dataTransfer.getData("text/km-card");
        if (!moving || moving === id) return;
        const { parent, siblings } = locate(id);
        let body;
        if (where === "inside") { body = { parent: id, before: null }; collapsed.delete(id); }
        else if (where === "before") body = { parent, before: id };
        else { const k = siblings.findIndex(s => s.id === id); const next = siblings.slice(k + 1).find(s => s.id !== moving); body = { parent, before: next ? next.id : null }; }
        try { tree = await api("POST", `cards/${moving}/move`, body); renderTree(); if (S.cardId === moving || S.cardId === id) renderCard(); }
        catch (err) { fail(err); }
      };
    });
    const root = $("troot");
    root.ondragover = e => { e.preventDefault(); root.classList.add("over"); };
    root.ondragleave = () => root.classList.remove("over");
    root.ondrop = async e => {
      e.preventDefault(); root.classList.remove("over");
      const moving = +e.dataTransfer.getData("text/km-card");
      if (moving) { tree = await api("POST", `cards/${moving}/move`, { parent: null, before: null }).catch(fail); renderTree(); renderCard(); }
    };
  }
  // Where a card sits in the tree: its parent id and its sibling list.
  function locate(id, nodes = tree, parent = null) {
    for (const n of nodes) {
      if (n.id === id) return { parent, siblings: nodes };
      const hit = locate(id, n.children, n.id);
      if (hit) return hit;
    }
    return null;
  }
  function ancestors(id) {
    const path = [];
    let hit = locate(id);
    while (hit && hit.parent != null) {
      const p = hit.parent;
      const node = (function find(ns) { for (const n of ns) { if (n.id === p) return n; const f = find(n.children); if (f) return f; } return null; })(tree);
      path.unshift(node);
      hit = locate(p);
    }
    return path;
  }
  function openCard(id) {
    S.cardId = id; S.editingCard = false; remember();
    if (S.view !== "cards") return show("cards");
    $("card-q").value ? renderSearch() : renderTree();
    renderCard();
  }

  async function renderCard() {
    const box = $("card-detail"), side = $("card-links");
    if (!S.cardId) { box.innerHTML = `<div class="empty">选一张卡</div>`; side.innerHTML = ""; return; }
    let c;
    try { c = await api("GET", "cards/" + S.cardId); }
    catch (e) { S.cardId = null; box.innerHTML = `<div class="empty">这张卡不在了</div>`; side.innerHTML = ""; return; }
    if (!tree.length) tree = await api("GET", "tree");
    S.card = c;
    if (S.editingCard) return renderCardEditor(c);
    const path = ancestors(c.id);
    const kids = (locate(c.id) ? (function find(ns) { for (const n of ns) { if (n.id === c.id) return n.children; const f = find(n.children); if (f) return f; } return []; })(tree) : []);
    box.innerHTML = `<div class="card-view">
        <div class="crumbs">${path.length ? path.map(p => `<a href="#" data-go="${p.id}" class="md" data-crumb="${p.id}"></a>`).join(" › ") + " ›" : "<span class='hint'>最顶层</span>"}</div>
        <h1 class="md" id="cv-title"></h1>
        <div class="meta"><span class="badge ${c.check}">${CHECK[c.check]}</span><span>改于 ${ago(c.updated)}</span>
          <button class="btn small" id="cv-edit">编辑 <kbd>E</kbd></button><button class="btn small ghost" id="cv-del">删除</button></div>
        <div class="md body" id="cv-body"></div>
        ${kids.length ? `<div class="kids"><h4>下一级</h4>${kids.map(k => `<div class="kid-item" data-go="${k.id}"><span class="dot ${k.check}"></span><span class="md" data-kid="${k.id}"></span></div>`).join("")}</div>` : ""}
        ${c.mentions_in.length ? `<div class="kids"><h4>哪些卡在正文里提到了它</h4>${c.mentions_in.map(k => `<div class="kid-item" data-go="${k.id}">${esc(k.title)}</div>`).join("")}</div>` : ""}
        ${c.origins.length ? `<div class="origins"><h4>来自原文（点击回到原处）</h4>${c.origins.map(o =>
          `<div class="origin" data-src="${o.source}" data-unit="${o.unit}"><div class="md"></div><div class="s">— ${esc(o.source_title)}</div></div>`).join("")}</div>` : ""}
      </div>`;
    path.forEach(p => mount(box.querySelector(`[data-crumb="${p.id}"]`), p.title, { inline: true }));
    kids.forEach(k => mount(box.querySelector(`[data-kid="${k.id}"]`), k.title, { inline: true }));
    mount($("cv-title"), c.title, { inline: true });
    mount($("cv-body"), c.body, { refs: c.refs });
    box.querySelectorAll("[data-go]").forEach(el => el.onclick = e => { e.preventDefault(); openCard(+el.dataset.go); });
    box.querySelectorAll(".origin").forEach((el, k) => {
      mount(el.querySelector(".md"), c.origins[k].text);
      el.onclick = () => jumpToUnit(+el.dataset.src, +el.dataset.unit);
    });
    $("cv-edit").onclick = () => { S.editingCard = true; renderCard(); };
    $("cv-del").onclick = async () => {
      const n = kids.length;
      if (!confirm(`删除卡片「${c.title}」？${n ? `它下面的 ${n} 张卡会升到最顶层。` : ""}它的关系也会一起删掉，原文句子不受影响。`)) return;
      await api("DELETE", "cards/" + c.id).catch(fail);
      S.cardId = null; loadCards(); refreshStats();
    };
    renderSide(c);
  }

  // In-place editor: Markdown on the left, live render on the right.
  function renderCardEditor(c) {
    const box = $("card-detail");
    box.innerHTML = `<div class="card-view editing">
        <input id="ce-title" class="ce-title" value="${esc(c.title)}" placeholder="标题">
        <div class="editor"><textarea id="ce-body" placeholder="支持 Markdown、公式，[[另一张卡的标题]] 引用别的卡">${esc(c.body)}</textarea>
          <div class="md preview" id="ce-preview"></div></div>
        <div class="row gap"><button class="btn primary" id="ce-save">保存 <kbd>⌘↵</kbd></button>
          <button class="btn" id="ce-cancel">取消 <kbd>Esc</kbd></button><span class="err" id="ce-err"></span></div>
      </div>`;
    const ta = $("ce-body");
    let t;
    const pv = () => { clearTimeout(t); t = setTimeout(() => mount($("ce-preview"), ta.value), 100); };
    ta.addEventListener("input", pv); pv();
    attachWikiComplete(ta, pv);
    const save = async () => {
      try {
        await api("PATCH", "cards/" + c.id, { title: $("ce-title").value, body: ta.value });
        S.editingCard = false; loadCards();
      } catch (e) { $("ce-err").textContent = e.message; }
    };
    const cancel = () => { S.editingCard = false; renderCard(); };
    $("ce-save").onclick = save; $("ce-cancel").onclick = cancel;
    box.querySelector(".editing").addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      if (e.key === "Escape" && !document.querySelector(".wl-pop")) { e.preventDefault(); cancel(); }
    });
    setTimeout(() => ta.focus(), 0);
  }

  function renderSide(c) {
    const side = $("card-links");
    const groups = [];
    for (const r of Object.keys(REL)) {
      const outs = c.out.filter(l => l.relation === r), ins = c.in.filter(l => l.relation === r);
      if (outs.length) groups.push({ label: r === "belongs_to" ? "上一级" : "这张卡 " + REL[r].out, items: outs, r, dir: "out" });
      if (ins.length) groups.push({ label: r === "belongs_to" ? "下一级" : REL[r].in, items: ins, r, dir: "in" });
    }
    if (c.mentions_out.length) groups.push({ label: "正文里提到", items: c.mentions_out.map(m => ({ ...m, relation: "mentions" })), r: "mentions", dir: "body" });
    side.innerHTML = `<h3>核对 <span class="hint">LLM 说的，查过了吗</span></h3>
      <div class="checks">${Object.entries(CHECK).map(([k, v]) => `<button class="ck ${k} ${c.check === k ? "on" : ""}" data-ck="${k}">${v}</button>`).join("")}</div>
      <textarea id="ck-note" class="ck-note" placeholder="依据：对照了哪段代码、哪篇文章、跑了什么实验">${esc(c.check_note)}</textarea>
      <h3 style="margin-top:16px">关系</h3>
      ${groups.length ? groups.map(g => `<div class="rel-group"><h4 style="color:${REL_COLOR[g.r] || "var(--muted)"}">${g.label}</h4>
        ${g.items.map(l => `<div class="link"><span class="t" data-go="${l.id}">${esc(l.title)}</span>
          ${g.dir === "body" ? `<span class="hint">在正文里改</span>` : `<select class="rel-change" data-from="${g.dir === "out" ? c.id : l.id}" data-to="${g.dir === "out" ? l.id : c.id}" data-rel="${g.r}" title="改关系">
            ${Object.entries(REL).map(([k, v]) => `<option value="${k}" ${k === g.r ? "selected" : ""}>${k === "belongs_to" ? "属于（上一级）" : v.out}</option>`).join("")}</select>
          <button data-un="${g.dir === "out" ? c.id : l.id}|${g.r}|${g.dir === "out" ? l.id : c.id}" title="断开">断开</button>`}</div>`).join("")}</div>`).join("")
        : `<div class="hint" style="margin-bottom:12px">还没有关系。孤零零的一张卡很快会忘，把它挂到你已有的知识上。</div>`}
      <div class="add-link">
        <div class="sentence">这张卡</div>
        <select id="link-rel">${Object.entries(REL).map(([k, v]) => `<option value="${k}" ${k === S.relation ? "selected" : ""}>${k === "belongs_to" ? "属于（挂到它下面）" : v.out}</option>`).join("")}</select>
        <input id="link-q" placeholder="搜另一张卡，回车选第一个">
        <div id="link-cands"></div>
      </div>`;
    side.querySelectorAll("[data-ck]").forEach(b => b.onclick = async () => {
      await api("POST", `cards/${c.id}/check`, { check: b.dataset.ck, note: $("ck-note").value }).catch(fail);
      loadCards();
    });
    $("ck-note").onchange = () => api("POST", `cards/${c.id}/check`, { check: c.check, note: $("ck-note").value }).then(() => toast("依据存好了")).catch(fail);
    side.querySelectorAll("[data-go]").forEach(el => el.onclick = () => openCard(+el.dataset.go));
    side.querySelectorAll("[data-un]").forEach(b => b.onclick = async () => {
      const [from, relation, to] = b.dataset.un.split("|");
      await api("DELETE", "links", { from: +from, relation, to: +to }).catch(fail);
      loadCards();
    });
    side.querySelectorAll(".rel-change").forEach(sel => sel.onchange = async () => {
      await api("PATCH", "links", { from: +sel.dataset.from, relation: sel.dataset.rel, to: +sel.dataset.to, new_relation: sel.value }).catch(fail);
      loadCards();
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
    $("link-q").onkeydown = e => { if (e.key === "Enter") { const first = $("link-cands").querySelector(".cand"); if (first) addLink(c.id, +first.dataset.id); } };
    cands();
  }
  async function addLink(from, to) {
    try {
      await api("POST", "links", { from, relation: $("link-rel").value, to });
      await loadCards();
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

  // [[ typed in an editor pops up matching card titles.
  function attachWikiComplete(ta, after) {
    let pop = null, items = [], sel = 0;
    const close = () => { pop?.remove(); pop = null; };
    const pick = title => {
      const pos = ta.selectionStart, before = ta.value.slice(0, pos), start = before.lastIndexOf("[[");
      ta.value = ta.value.slice(0, start) + "[[" + title + "]]" + ta.value.slice(pos);
      const caret = start + title.length + 4;
      ta.setSelectionRange(caret, caret); close(); ta.focus(); after && after();
    };
    ta.addEventListener("input", async () => {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = before.match(/\[\[([^\[\]\n|]*)$/);
      if (!m) return close();
      const q = m[1];
      items = (await api("GET", "cards?q=" + encodeURIComponent(q))).filter(x => !S.card || x.id !== S.card.id).slice(0, 8);
      if (q && !items.some(x => x.title === q)) items.push({ title: q, create: true });
      if (!items.length) return close();
      sel = 0;
      if (!pop) { pop = document.createElement("div"); pop.className = "wl-pop"; ta.parentElement.appendChild(pop); }
      pop.innerHTML = items.map((x, k) => `<div class="wl ${k === sel ? "on" : ""}" data-k="${k}">${x.create ? `引用一张还没有的卡：<b>${esc(x.title)}</b>` : esc(x.title)}</div>`).join("");
      pop.querySelectorAll(".wl").forEach(el => el.onmousedown = e => { e.preventDefault(); pick(items[+el.dataset.k].title); });
    });
    ta.addEventListener("keydown", e => {
      if (!pop) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        pop.querySelectorAll(".wl").forEach((el, k) => el.classList.toggle("on", k === sel));
      } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[sel].title); }
      else if (e.key === "Escape") { e.stopPropagation(); close(); }
    });
    ta.addEventListener("blur", () => setTimeout(close, 150));
  }

  // Clicking [[a link]] anywhere opens that card, or offers to create it.
  document.addEventListener("click", async e => {
    const a = e.target.closest("a.wikilink");
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.target;
    let id = /^#\d+$/.test(target) ? +target.slice(1) : null;
    if (!id) { const hit = (await api("GET", "cards?q=" + encodeURIComponent(target))).find(x => x.title === target); id = hit && hit.id; }
    if (id) return openCard(id);
    if (confirm(`还没有「${target}」这张卡，现在建？`)) openEditor({ title: target, body: "" });
  });

  // --------------------------------------------------------- ③ hierarchy map
  // The strict tree drawn top-down, mermaid style. Each card folds its
  // children (+/−) and, separately, its content (formulas render inside the
  // box). Tree edges are grey; every other relation is drawn too, each kind in
  // its own colour and toggleable from the legend.
  const MAP_W = 230, MAP_W_OPEN = 380, MAP_HGAP = 28, MAP_VGAP = 70;
  const loadSet = (k, dflt) => { try { const v = JSON.parse(localStorage.getItem(k)); return new Set(Array.isArray(v) ? v : dflt); } catch (e) { return new Set(dflt); } };
  const saveSet = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch (e) {} };
  let mapOpen = loadSet("km-map-open", []), mapBody = loadSet("km-map-body", []);
  let mapRel = loadSet("km-map-rel", [...Object.keys(REL).filter(r => r !== "belongs_to"), "mentions"]);
  let mapView = (() => { try { return JSON.parse(localStorage.getItem("km-map-view")) || { x: 40, y: 30, k: 1 }; } catch (e) { return { x: 40, y: 30, k: 1 }; } })();
  let mapData = null, mapSel = null;
  const REL_NAME = { ...Object.fromEntries(Object.entries(REL).map(([k, v]) => [k, k === "belongs_to" ? "属于" : v.out])), mentions: "正文提到" };
  const REL_DASH = { related: "2 4", mentions: "6 4", contradicts: "" };

  async function drawMap() {
    const err = $("map-error");
    try { mapData = await api("GET", "structure"); err.hidden = true; }
    catch (e) { err.hidden = false; err.textContent = "拒绝渲染（层级结构不合格）：\n" + e.message; return; }
    const { nodes, structure: { root, entries }, refs } = mapData;
    if (!mapOpen.size) mapOpen.add(root);
    if (!mapSel || !nodes[mapSel]) mapSel = root;
    const kids = id => Object.keys(entries).filter(k => entries[k].parent === id).sort((a, b) => entries[a].order - entries[b].order);

    // what is visible: root, then children of open nodes
    const visible = [], q = [root];
    while (q.length) { const id = q.shift(); visible.push(id); if (mapOpen.has(id)) q.push(...kids(id)); }

    // 1. render boxes (unpositioned) so their real heights can be measured
    const layer = $("map-layer");
    layer.innerHTML = `<svg id="map-edges"></svg>` + visible.map(id => {
      const n = nodes[id], ch = kids(id).length, open = mapOpen.has(id), body = mapBody.has(id);
      return `<div class="mnode ${n.check} ${id === mapSel ? "sel" : ""} ${body ? "wide" : ""} ${n.node_type === "root" ? "root" : ""}" data-id="${id}">
        <div class="mh">
          ${ch ? `<button class="mt" data-tog="${id}" title="${open ? "收起下一级" : "展开下一级"}">${open ? "−" : "+"}<span>${ch}</span></button>` : `<span class="mt leaf"></span>`}
          <span class="dot ${n.check}"></span>
          <span class="mtitle md" data-t="${id}"></span>
          <button class="mb" data-body="${id}" title="${body ? "收起内容" : "展开内容"}">${body ? "▴" : "▾"}</button>
        </div>
        ${body ? `<div class="mbody md" data-b="${id}"></div>` : ""}
        <div class="mid">${id} · L${entries[id].level} · #${entries[id].order}</div>
      </div>`;
    }).join("");
    visible.forEach(id => {
      mount(layer.querySelector(`[data-t="${id}"]`), nodes[id].name, { inline: true });
      const b = layer.querySelector(`[data-b="${id}"]`);
      if (b) mount(b, nodes[id].definition);
    });
    const box = id => layer.querySelector(`.mnode[data-id="${id}"]`);
    const width = id => mapBody.has(id) ? MAP_W_OPEN : MAP_W;
    visible.forEach(id => { box(id).style.width = width(id) + "px"; });

    // 2. tidy top-down layout: each subtree gets the width it needs, a parent
    //    sits centred over its children, each level starts below the tallest
    //    box of the level above.
    const shown = id => mapOpen.has(id) ? kids(id) : [];
    const subW = new Map();
    (function measure(id) {
      const c = shown(id);
      c.forEach(measure);
      const cw = c.reduce((a, x) => a + subW.get(x), 0) + Math.max(0, c.length - 1) * MAP_HGAP;
      subW.set(id, Math.max(width(id), cw));
    })(root);
    const levelH = [];
    visible.forEach(id => { const l = entries[id].level; levelH[l] = Math.max(levelH[l] || 0, box(id).offsetHeight); });
    const levelY = [0];
    for (let l = 1; l < levelH.length; l++) levelY[l] = levelY[l - 1] + levelH[l - 1] + MAP_VGAP;
    const pos = {};
    (function place(id, x0) {
      const c = shown(id), y = levelY[entries[id].level];
      if (!c.length) { pos[id] = { x: x0 + (subW.get(id) - width(id)) / 2, y }; return; }
      const cw = c.reduce((a, x) => a + subW.get(x), 0) + (c.length - 1) * MAP_HGAP;
      let x = x0 + (subW.get(id) - cw) / 2;
      c.forEach(k => { place(k, x); x += subW.get(k) + MAP_HGAP; });
      const first = pos[c[0]], last = pos[c[c.length - 1]];
      const mid = (first.x + width(c[0]) / 2 + last.x + width(c[c.length - 1]) / 2) / 2;
      pos[id] = { x: mid - width(id) / 2, y };
    })(root, 0);
    visible.forEach(id => { const b = box(id); b.style.left = pos[id].x + "px"; b.style.top = pos[id].y + "px"; });

    // 3. edges: tree first (grey), then every enabled relation between visible cards
    const rect = id => ({ x: pos[id].x, y: pos[id].y, w: width(id), h: box(id).offsetHeight });
    const W = Math.max(...visible.map(id => pos[id].x + width(id))) + 60;
    const H = Math.max(...visible.map(id => pos[id].y + box(id).offsetHeight)) + 60;
    const svg = $("map-edges");
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    let html = `<defs>${Object.entries({ tree: "#9ca3af", ...REL_COLOR, mentions: "#9ca3af" }).map(([k, c]) =>
      `<marker id="mk-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("")}</defs>`;
    visible.forEach(id => {
      const p = entries[id].parent;
      if (!p || !pos[p]) return;
      const a = rect(p), b = rect(id), x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
      html += `<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}" class="tree-edge" marker-end="url(#mk-tree)"/>`;
    });
    const isVis = new Set(visible);
    const cross = refs.filter(r => mapRel.has(r.relation) && isVis.has(r.from) && isVis.has(r.to));
    cross.forEach((r, k) => {
      const a = rect(r.from), b = rect(r.to);
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      // leave/enter through the facing sides; bow sideways so it does not hide under tree edges
      const side = bc.x >= ac.x ? 1 : -1;
      const sameRow = Math.abs(ac.y - bc.y) < 10;
      const p1 = sameRow ? { x: ac.x, y: a.y + a.h } : { x: side > 0 ? a.x + a.w : a.x, y: ac.y };
      const p2 = sameRow ? { x: bc.x, y: b.y + b.h + 4 } : { x: side > 0 ? b.x - 4 : b.x + b.w + 4, y: bc.y };
      const bend = sameRow ? 50 + 12 * (k % 4) : 0;
      const c1 = sameRow ? { x: p1.x, y: p1.y + bend } : { x: p1.x + side * 60, y: p1.y };
      const c2 = sameRow ? { x: p2.x, y: p2.y + bend } : { x: p2.x - side * 60, y: p2.y };
      const color = r.relation === "mentions" ? "#9ca3af" : REL_COLOR[r.relation];
      const lx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, ly = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
      html += `<path d="M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}" stroke="${color}" class="rel-edge"
                 stroke-dasharray="${REL_DASH[r.relation] ?? ""}" marker-end="url(#mk-${r.relation})"/>
               <text x="${lx}" y="${ly}" class="rel-label" fill="${color}">${REL_NAME[r.relation]}</text>`;
    });
    svg.innerHTML = html;

    applyMap();
    renderMapLegend(refs);
    renderMapSide();

    layer.querySelectorAll("[data-tog]").forEach(b => b.onclick = e => {
      e.stopPropagation(); const id = b.dataset.tog;
      mapOpen.has(id) ? mapOpen.delete(id) : mapOpen.add(id); saveSet("km-map-open", mapOpen); drawMap();
    });
    layer.querySelectorAll("[data-body]").forEach(b => b.onclick = e => {
      e.stopPropagation(); const id = b.dataset.body;
      mapBody.has(id) ? mapBody.delete(id) : mapBody.add(id); saveSet("km-map-body", mapBody); drawMap();
    });
    layer.querySelectorAll(".mnode").forEach(el => {
      el.onclick = e => { if (e.target.closest("a")) return; mapSel = el.dataset.id; layer.querySelectorAll(".mnode").forEach(x => x.classList.toggle("sel", x === el)); renderMapSide(); };
      el.ondblclick = () => openCard(+el.dataset.id.slice(1));
    });
  }

  function applyMap() {
    $("map-layer").style.transform = `translate(${mapView.x}px,${mapView.y}px) scale(${mapView.k})`;
    try { localStorage.setItem("km-map-view", JSON.stringify(mapView)); } catch (e) {}
  }
  function fitMap() {
    const layer = $("map-layer"), svg = $("map-edges"), stage = $("map-stage");
    if (!svg) return;
    const w = +svg.getAttribute("width"), h = +svg.getAttribute("height");
    const k = Math.max(0.2, Math.min(1.2, (stage.clientWidth - 40) / w, (stage.clientHeight - 40) / h));
    mapView = { k, x: (stage.clientWidth - w * k) / 2, y: 20 };
    applyMap();
  }
  function renderMapLegend(refs) {
    const count = r => refs.filter(x => x.relation === r).length;
    $("map-legend").innerHTML = `<span class="lg"><i style="background:#9ca3af"></i>层级（上一级→下一级）</span>`
      + [...Object.keys(REL).filter(r => r !== "belongs_to"), "mentions"].map(r =>
        `<label class="lg"><input type="checkbox" data-rel="${r}" ${mapRel.has(r) ? "checked" : ""}>
          <i style="background:${r === "mentions" ? "#9ca3af" : REL_COLOR[r]}"></i>${REL_NAME[r]} <span class="hint">${count(r)}</span></label>`).join("");
    $("map-legend").querySelectorAll("[data-rel]").forEach(cb => cb.onchange = () => {
      cb.checked ? mapRel.add(cb.dataset.rel) : mapRel.delete(cb.dataset.rel); saveSet("km-map-rel", mapRel); drawMap();
    });
  }
  function renderMapSide() {
    const side = $("map-side");
    if (!mapData || !mapSel) { side.innerHTML = ""; return; }
    const { nodes, structure: { entries }, refs } = mapData;
    const n = nodes[mapSel], e = entries[mapSel];
    const kids = Object.keys(entries).filter(k => entries[k].parent === mapSel).sort((a, b) => entries[a].order - entries[b].order);
    const link = id => `<a href="#" class="go" data-go="${id}">${esc(nodes[id].name)}</a>`;
    const out = refs.filter(r => r.from === mapSel), inn = refs.filter(r => r.to === mapSel);
    side.innerHTML = `<h2 class="md" id="ms-title"></h2><div class="hint">${mapSel} · <span class="badge ${n.check}">${CHECK[n.check] || ""}</span></div>
      <div class="mcard"><h3>内容</h3><div class="md" id="ms-def"></div></div>
      <div class="mcard"><h3>层级</h3>
        <div class="row">level = ${e.level}</div>
        <div class="row">parent = ${e.parent ? link(e.parent) : "null（根）"}</div>
        <div class="row">order = ${e.order}</div>
        <div class="row">path = ${e.path.map(p => link(p)).join(" → ")}</div></div>
      ${kids.length ? `<div class="mcard"><h3>按顺序的下一级</h3>${kids.map((k, i) => `<div class="row">${i} → ${link(k)}</div>`).join("")}</div>` : ""}
      ${out.length || inn.length ? `<div class="mcard"><h3>其他关系</h3>
        ${out.map(r => `<div class="row"><b style="color:${REL_COLOR[r.relation] || "#9ca3af"}">${REL_NAME[r.relation]}</b> → ${link(r.to)}</div>`).join("")}
        ${inn.map(r => `<div class="row">${link(r.from)} <b style="color:${REL_COLOR[r.relation] || "#9ca3af"}">${REL_NAME[r.relation]}</b> → 这张</div>`).join("")}</div>` : ""}
      <div class="row gap"><button class="btn small" id="ms-open">打开编辑</button><button class="btn small" id="ms-child">在它下面新建</button></div>`;
    mount($("ms-title"), n.name, { inline: true });
    mount($("ms-def"), n.definition);
    side.querySelectorAll("[data-go]").forEach(a => a.onclick = ev => {
      ev.preventDefault(); mapSel = a.dataset.go;
      // make sure the target is visible: open every ancestor
      entries[mapSel].path.slice(0, -1).forEach(p => mapOpen.add(p)); saveSet("km-map-open", mapOpen); drawMap();
    });
    $("ms-open").onclick = () => openCard(+mapSel.slice(1));
    $("ms-child").onclick = () => openEditor({ title: "", body: "", units: [], parent: +mapSel.slice(1) });
  }
  (function wireMap() {
    const stage = $("map-stage");
    stage.onpointerdown = e => {
      if (e.target.closest(".mnode")) return;
      const sx = e.clientX, sy = e.clientY, vx = mapView.x, vy = mapView.y;
      stage.setPointerCapture(e.pointerId); stage.classList.add("panning");
      stage.onpointermove = ev => { mapView.x = vx + ev.clientX - sx; mapView.y = vy + ev.clientY - sy; applyMap(); };
      stage.onpointerup = () => { stage.onpointermove = stage.onpointerup = null; stage.classList.remove("panning"); };
    };
    stage.onwheel = e => {
      e.preventDefault();
      const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.max(0.2, Math.min(2.5, mapView.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      mapView.x = mx - (mx - mapView.x) * k / mapView.k; mapView.y = my - (my - mapView.y) * k / mapView.k; mapView.k = k; applyMap();
    };
    $("map-expand").onclick = () => { Object.keys(mapData?.structure.entries || {}).forEach(id => mapOpen.add(id)); saveSet("km-map-open", mapOpen); drawMap().then(fitMap); };
    $("map-collapse").onclick = () => { mapOpen = new Set(mapData ? [mapData.structure.root] : []); mapBody = new Set(); saveSet("km-map-open", mapOpen); saveSet("km-map-body", mapBody); drawMap().then(fitMap); };
    $("map-bodies").onclick = () => {
      const vis = [...document.querySelectorAll(".mnode")].map(x => x.dataset.id);
      const all = vis.every(id => mapBody.has(id));
      vis.forEach(id => all ? mapBody.delete(id) : mapBody.add(id)); saveSet("km-map-body", mapBody); drawMap();
    };
    $("map-fit").onclick = fitMap;
    $("map-export").onclick = async () => {
      const d = await api("GET", "structure").catch(fail);
      if (!d) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
      a.download = "knowledge_tree.json"; a.click();
    };
  })();

  // --------------------------------------------------------- ④ board
  // You place the cards. Positions are saved; nothing is laid out for you.
  const BW = 230;
  let boardView = JSON.parse(localStorage.getItem("km-board") || '{"x":40,"y":40,"k":1}');
  async function drawBoard() {
    const data = await api("GET", "board");
    const placed = data.cards.filter(c => c.x != null), loose = data.cards.filter(c => c.x == null);
    $("tray").innerHTML = `<h3>还没摆的 <span class="hint">拖到右边白板上</span></h3>` + (loose.length
      ? loose.map(c => `<div class="tray-card" draggable="true" data-id="${c.id}"><span class="dot ${c.check}"></span><span class="md" data-t="${c.id}"></span></div>`).join("")
      : `<div class="hint">都摆上了</div>`);
    loose.forEach(c => mount($("tray").querySelector(`[data-t="${c.id}"]`), c.title, { inline: true }));
    $("tray").querySelectorAll(".tray-card").forEach(el => el.ondragstart = e => e.dataTransfer.setData("text/km-card", el.dataset.id));

    const stage = $("stage"), layer = $("layer");
    layer.innerHTML = `<svg id="edges"></svg>` + placed.map(c => `<div class="bcard ${c.check}" data-id="${c.id}" style="left:${c.x}px;top:${c.y}px;width:${BW}px">
        <div class="bt md"></div><div class="bb md"></div>
        <button class="bx" title="从白板拿下来">×</button></div>`).join("");
    placed.forEach(c => {
      const el = layer.querySelector(`.bcard[data-id="${c.id}"]`);
      mount(el.querySelector(".bt"), c.title, { inline: true });
      mount(el.querySelector(".bb"), c.body);
    });
    const apply = () => { layer.style.transform = `translate(${boardView.x}px,${boardView.y}px) scale(${boardView.k})`; localStorage.setItem("km-board", JSON.stringify(boardView)); };
    apply();
    const drawEdges = () => {
      const svg = $("edges"), pos = new Map();
      layer.querySelectorAll(".bcard").forEach(el => pos.set(+el.dataset.id, { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2, el }));
      const ok = data.edges.filter(e => pos.has(e.from) && pos.has(e.to));
      let W = 0, H = 0; pos.forEach(p => { W = Math.max(W, p.el.offsetLeft + p.el.offsetWidth + 40); H = Math.max(H, p.el.offsetTop + p.el.offsetHeight + 40); });
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.innerHTML = `<defs>${Object.entries({ ...REL_COLOR, mentions: "#9ca3af" }).map(([k, c]) => `<marker id="bar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("")}</defs>`
        + ok.map(e => {
          const a = pos.get(e.from), b = pos.get(e.to);
          const end = edgePoint(b, a), start = edgePoint(a, b);
          const color = e.relation === "mentions" ? "#9ca3af" : REL_COLOR[e.relation];
          return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${color}" stroke-width="${e.relation === "belongs_to" ? 2.2 : 1.5}"
            ${e.relation === "mentions" ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#bar-${e.relation})"/>`;
        }).join("");
    };
    // where the line from a box's centre toward `to` leaves the box
    const edgePoint = (p, to) => {
      const w = p.el.offsetWidth / 2 + 4, h = p.el.offsetHeight / 2 + 4, dx = to.x - p.x, dy = to.y - p.y;
      const t = Math.min(w / Math.abs(dx || 1e-9), h / Math.abs(dy || 1e-9));
      return { x: p.x + dx * t, y: p.y + dy * t };
    };
    requestAnimationFrame(drawEdges);
    setTimeout(drawEdges, 300); // after KaTeX/mermaid settle

    const toBoard = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - boardView.x) / boardView.k, y: (cy - r.top - boardView.y) / boardView.k }; };
    layer.querySelectorAll(".bcard").forEach(el => {
      const id = +el.dataset.id;
      el.querySelector(".bx").onclick = async e => { e.stopPropagation(); await api("POST", `cards/${id}/place`, { x: null, y: null }).catch(fail); drawBoard(); };
      el.ondblclick = () => openCard(id);
      el.onpointerdown = e => {
        if (e.target.closest(".bx, a")) return;
        e.stopPropagation(); el.setPointerCapture(e.pointerId);
        const start = toBoard(e.clientX, e.clientY), ox = el.offsetLeft, oy = el.offsetTop;
        el.classList.add("dragging");
        el.onpointermove = ev => { const p = toBoard(ev.clientX, ev.clientY); el.style.left = (ox + p.x - start.x) + "px"; el.style.top = (oy + p.y - start.y) + "px"; drawEdges(); };
        el.onpointerup = async () => {
          el.onpointermove = el.onpointerup = null; el.classList.remove("dragging");
          if (el.offsetLeft !== ox || el.offsetTop !== oy) await api("POST", `cards/${id}/place`, { x: el.offsetLeft, y: el.offsetTop }).catch(fail);
        };
      };
    });
    stage.onpointerdown = e => {
      if (e.target.closest(".bcard")) return;
      const sx = e.clientX, sy = e.clientY, vx = boardView.x, vy = boardView.y;
      stage.setPointerCapture(e.pointerId); stage.classList.add("panning");
      stage.onpointermove = ev => { boardView.x = vx + ev.clientX - sx; boardView.y = vy + ev.clientY - sy; apply(); };
      stage.onpointerup = () => { stage.onpointermove = stage.onpointerup = null; stage.classList.remove("panning"); };
    };
    stage.onwheel = e => {
      e.preventDefault();
      const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.max(0.3, Math.min(2.5, boardView.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      boardView.x = mx - (mx - boardView.x) * k / boardView.k; boardView.y = my - (my - boardView.y) * k / boardView.k; boardView.k = k; apply();
    };
    stage.ondragover = e => e.preventDefault();
    stage.ondrop = async e => {
      e.preventDefault();
      const id = +e.dataTransfer.getData("text/km-card");
      if (!id) return;
      const p = toBoard(e.clientX, e.clientY);
      await api("POST", `cards/${id}/place`, { x: Math.round(p.x - BW / 2), y: Math.round(p.y - 20) }).catch(fail);
      drawBoard();
    };
    $("board-legend").innerHTML = Object.entries(REL).map(([k, v]) => `<span><i style="background:${REL_COLOR[k]}"></i>${k === "belongs_to" ? "属于（上一级）" : v.out}</span>`).join("")
      + `<span><i style="background:#9ca3af"></i>正文里提到</span><span>· 拖卡片摆位置，拖空白处平移，滚轮缩放，双击打开</span>`;
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
      let skipped = [];
      const take = r => { made = made.concat(r.sources); skipped = skipped.concat(r.skipped || []); };
      if (impMode === "paste") take(await api("POST", "sources", { text: $("imp-text").value, title: $("imp-title").value }));
      else if (impMode === "file") {
        if (!impFiles.length) throw new Error("先选文件");
        for (const f of impFiles) take(await api("POST", "sources", { filename: f.name, file_b64: await b64(f) }));
      } else if (impMode === "folder") {
        if (!$("imp-folder").value.trim()) throw new Error("先填文件夹路径");
        take(await api("POST", "sources", { folder: $("imp-folder").value.trim() }));
      } else {
        if (!impSession) throw new Error("先选一个会话");
        take(await api("POST", "sources", { claude_session: impSession }));
      }
      if (skipped.length) setTimeout(() => alert("这些没导进来：\n" + skipped.join("\n")), 300);
      $("m-import").classList.remove("on");
      $("imp-text").value = ""; $("imp-title").value = ""; impFiles = []; $("imp-files").textContent = "";
      S.sid = made[0].id; S.cur = 0; remember();
      show("sift");
      await loadSources(); refreshStats();
      toast(`${made.length > 1 ? made.length + " 份资料，" : ""}拆成了 ${made.reduce((a, m) => a + m.units, 0)} 句，用 J/K 往下看，Y 留下`);
    } catch (e) { $("imp-err").textContent = e.message; }
    finally { $("imp-go").disabled = false; $("imp-go").textContent = "导入并拆分"; }
  };
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest(".modal").classList.remove("on"));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("mousedown", e => { if (e.target === m) m.classList.remove("on"); }));

  // --------------------------------------------------------- keyboard
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { document.querySelectorAll(".modal.on").forEach(m => m.classList.remove("on")); }
    if (document.querySelector(".modal.on") || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (S.view === "cards" && e.key.toLowerCase() === "e" && S.cardId && !S.editingCard) { e.preventDefault(); S.editingCard = true; return renderCard(); }
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
  loadSources().then(() => show(["sift", "cards", "map", "board"].includes(S.view) ? S.view : "sift")).catch(fail);
})();
