// The knowledge tree as a document: the same tree the whiteboard draws, laid out
// for paper. This page is what 「导出 PDF」 prints — the server hands it to a
// headless browser and takes the file back, so the PDF, the preview here and
// 「打印 / 另存为 PDF」 are all exactly the same rendering.
(function () {
  const { mount, escapeHtml: esc } = window.KMRender;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const session = params.get("s") || "";
  const title = params.get("t") || "";
  const REL = {
    belongs_to: "属于", prerequisite: "前提是", example_of: "是…的例子",
    refines: "细化了", contradicts: "与…矛盾", related: "相关", mentions: "正文提到",
  };
  const CHECK = { unchecked: "未核对", ok: "对", fixed: "改正过", doubt: "存疑", wrong: "错" };
  const HEAD = { 1: "h2", 2: "h3", 3: "h4", 4: "h5", 5: "h6", 6: "h6" };

  async function api(path) {
    let url = "/api/" + path;
    if (session) url += (url.includes("?") ? "&" : "?") + "s=" + encodeURIComponent(session) + "&t=" + encodeURIComponent(title);
    const r = await fetch(url, { cache: "no-store" });
    const d = await r.json().catch(() => ({ error: "HTTP " + r.status }));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }

  // What a card shows: its own words, or the sentence it came from when it was
  // never touched — the same rule the whiteboard uses on the card face.
  const faceText = n => (n.edited || n.origins.length > 1) ? n.body : (n.origins.length ? n.origins[0].text : n.body);

  function cardHtml(id, d, depth, path) {
    const n = d.nodes[id];
    const h = HEAD[Math.min(6, depth)] || "h6";
    const kids = [...n.children].sort((a, b) => d.nodes[a].order - d.nodes[b].order);
    const out = [];
    out.push(`<section class="card" data-id="${id}">`);
    out.push(`<${h}><span class="num">${path}</span>${esc(n.title)}</${h}>`);
    out.push(`<div class="body" data-md="${id}"></div>`);
    if (n.origins.length) {
      out.push(`<div class="origins">` + n.origins.map((o, k) =>
        `<div class="origin"><div data-orig="${id}:${k}"></div><div class="src">— ${esc(o.source_title)}` +
        (o.dsh_turn ? `（第 ${o.dsh_turn} 轮）` : "") + `</div></div>`).join("") + `</div>`);
    }
    const rels = [];
    (n.out || []).forEach(l => { if (l.relation !== "belongs_to") rels.push(`${REL[l.relation] || l.relation} → ${l.title}`); });
    (n.in || []).forEach(l => { if (l.relation !== "belongs_to") rels.push(`${l.title} → 本卡（${REL[l.relation] || l.relation}）`); });
    if (rels.length) out.push(`<div class="rels">` + rels.map(r => `<span>· ${esc(r)}</span>`).join("") + `</div>`);
    if (n.check && n.check !== "unchecked") {
      out.push(`<div class="checkline"><span class="badge ${n.check}">${CHECK[n.check] || n.check}</span>` +
        (n.check_note ? ` <span class="meta-note">${esc(n.check_note)}</span>` : "") + `</div>`);
    }
    out.push(`</section>`);
    kids.forEach((c, i) => out.push(cardHtml(c, d, depth + 1, `${path}.${i + 1}`)));
    return out.join("");
  }

  async function draw() {
    const doc = $("doc");
    let d;
    try { d = await api("canvas"); }
    catch (e) {
      doc.innerHTML = `<h1>读不到这个会话的知识库</h1><p class="loading">${esc(e.message)}</p>`;
      return;
    }
    const root = d.nodes[d.root];
    const cards = Object.values(d.nodes).filter(n => !n.root);
    const when = new Date().toLocaleString("zh-CN", { hour12: false });
    document.title = root.title + "　知识树";
    $("where").textContent = root.title;
    doc.innerHTML = `<h1>${esc(root.title)}</h1>
      <div class="meta">${cards.length} 张卡 · ${d.refs.length} 条关系 · ${cards.filter(c => c.origins.length).length} 张带原文 · 导出 ${esc(when)}</div>`
      + [...root.children].sort((a, b) => d.nodes[a].order - d.nodes[b].order)
          .map((c, i) => cardHtml(c, d, 2, String(i + 1))).join("");

    // Markdown, formulas and code, exactly as the whiteboard renders them.
    Object.values(d.nodes).forEach(n => {
      const body = doc.querySelector(`[data-md="${n.id}"]`);
      if (body) mount(body, faceText(n), { refs: n.refs });
      n.origins.forEach((o, k) => {
        const el = doc.querySelector(`[data-orig="${n.id}:${k}"]`);
        if (el) mount(el, o.text);
      });
    });

    // Fonts (KaTeX among them) change how tall the document is, so printing
    // starts only once they have arrived.
    const ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    await ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (params.get("auto") === "1") window.print();
  }

  $("do-print").onclick = () => window.print();
  $("do-close").onclick = () => window.close();
  draw();
})();
