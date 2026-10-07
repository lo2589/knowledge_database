// Codex 知识对话 — chat on the left, the knowledge graph on the right.
//
// The chat is the Codex CLI run by the server (see km/chat.py) and streamed here
// one event per line. Everything else is the same one-screen idea as the dsh
// plugin: sentences are clickable, a click makes a card in the graph beside it,
// and every card can jump back to the sentence it was said in.
(function () {
  const { mount, escapeHtml: esc } = window.KMRender;
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------------------------------------------------------------- state
  const S = {
    chat: store.get("km-codex-chat", ""),     // the conversation, and its library
    cwd: store.get("km-codex-cwd", ""),
    thread: "",
    turns: [],          // {q, a, reasoning, tools, usage, error, at} as rendered
    streaming: false,
    asked: "",          // the question of the turn being streamed (names the library)
    abort: null,
    pending: null,      // the turn currently being streamed
    picked: new Map(),  // message id → {text: [card ids]}
    images: [],         // pictures attached to the next question
  };
  const msgId = (n, who) => `${S.chat}-${n}-${who}`;
  const timeAgo = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? "刚刚" : s < 3600 ? `${s / 60 | 0} 分钟前` : s < 86400 ? `${s / 3600 | 0} 小时前` : `${s / 86400 | 0} 天前`; };

  let toastT;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
  }

  const api = async (method, path, body, signal) => {
    const r = await fetch("/api/" + path, { method, signal,
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({ error: "HTTP " + r.status }));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  };
  const forChat = path => path + (path.includes("?") ? "&" : "?") + "s=" + encodeURIComponent(S.chat);
  // The library beside the chat is named after the first thing asked in it.
  const title = () => ((S.turns[0] && S.turns[0].q) || S.asked || "codex").replace(/\s+/g, " ").slice(0, 60);

  // ------------------------------------------------------------- the graph
  function graphUrl() {
    if (!S.chat) return "about:blank";
    return "/?s=" + encodeURIComponent(S.chat) + "&t=" + encodeURIComponent(title());
  }
  function loadGraph(force) {
    const url = graphUrl();
    if (force || $("graph").getAttribute("src") !== url) $("graph").setAttribute("src", url);
  }
  function tellGraph(msg) {
    const w = $("graph").contentWindow;
    if (w) w.postMessage(Object.assign({ source: "km-host" }, msg), "*");
  }

  // ---------------------------------------------------------- drawing turns
  function mountMd(el, text) {
    if (!el) return;
    try { mount(el, text || ""); } catch (e) { el.textContent = text || ""; }
  }

  function turnEl(i) {
    let el = $("log").querySelector(`[data-turn="${i}"]`);
    if (el) return el;
    el = document.createElement("div");
    el.className = "turn";
    el.dataset.turn = i;
    $("log").appendChild(el);
    return el;
  }

  function paintQuestion(el, q) {
    el.innerHTML = `<div class="q"><div class="bubble" data-qbox="1"><div class="md" data-q="1"></div></div></div>
      <div class="a"><div class="who"><span>Codex</span><span class="tok"></span></div>
      <div class="think" hidden><details><summary>思考过程</summary><div class="body md" data-think="1"></div></details></div>
      <div class="status" hidden></div><div class="tools" hidden></div><div class="err" hidden></div>
      <div class="answer md" data-answer="1"></div></div>`;
    mountMd(el.querySelector("[data-q]"), q);
    return el;
  }

  function scrollDown(force) {
    const log = $("log");
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (force || near) log.scrollTop = log.scrollHeight;
  }

  // The answer as it arrives: plain Markdown while it is still being written,
  // one clickable sentence after it settles.
  function paintAnswer(el, text, streaming) {
    const box = el.querySelector("[data-answer]");
    box.dataset.md = streaming ? "1" : "";
    mountMd(box, text);
    scrollDown();
  }

  function paintTools(el, tools) {
    const box = el.querySelector(".tools");
    box.hidden = !tools.length;
    box.innerHTML = tools.map(t => `<div>· ${esc(t.name || "命令")}${t.detail ? "：" + esc(t.detail) : ""}</div>`).join("");
  }

  function paintUsage(el, usage) {
    el.querySelector(".tok").textContent = usage && usage.output_tokens
      ? `${usage.input_tokens || 0} in / ${usage.output_tokens} out` : "";
  }

  // A settled message becomes sentences: each one can be clicked into a card.
  // @param box - the element that holds them (the answer area, or the bubble the
  //     question is written in).
  function paintSentences(box, index, text, speaker) {
    if (!box) return;
    const id = msgId(index, speaker === "user" ? "q" : "a");
    box.innerHTML = `<div class="km-ans"></div>`;
    api("POST", "split", { text }).then(units => {
      const host = box.querySelector(".km-ans");
      host.innerHTML = "";
      const picked = S.picked.get(id) || {};
      (units || []).forEach((u, i) => {
        const cards = Object.prototype.hasOwnProperty.call(picked, u.text) ? picked[u.text] : null;
        const row = document.createElement("div");
        row.className = "km-s" + (cards ? " picked" : "");
        row.dataset.kmMsg = id;
        row.dataset.kmIdx = String(i);
        row.dataset.kmText = u.text;
        row.dataset.kmSpeaker = speaker || "assistant";
        row.title = cards ? "已入库：点一下在右边看这张卡" : "点一下：放进右边知识图的挂载点下";
        const body = document.createElement("div");
        body.className = "md";
        host.appendChild(row);
        row.appendChild(body);
        mountMd(body, u.text);
        if (cards) {
          const tag = document.createElement("span");
          tag.className = "km-tag"; tag.textContent = "✓ 已入库";
          row.appendChild(tag);
        }
        row.onclick = () => {
          if (cards) { tellGraph({ type: "focus", card: cards[cards.length - 1] }); return toast("已经在右边那张卡上了"); }
          pick(row, u.text, id, i, speaker, index);
        };
      });
      scrollDown();
    }).catch(e => toast("拆句失败：" + e.message));
  }

  async function pick(row, text, message, index, speaker, turn) {
    row.classList.add("busy");
    try {
      const out = await api("POST", forChat("pick"), {
        text, title: "",
        origin: { kind: "codex", session: S.chat, message, index, turn, speaker,
                  question: S.turns[turn] ? S.turns[turn].q : "", cwd: S.cwd },
      });
      row.classList.add("picked");
      if (!row.querySelector(".km-tag")) {
        const tag = document.createElement("span");
        tag.className = "km-tag"; tag.textContent = "✓ 已入库";
        row.appendChild(tag);
      }
      const box = S.picked.get(message) || {};
      (box[text] = box[text] || []).push(out.id);
      S.picked.set(message, box);
      tellGraph({ type: "refresh", card: out.id });
      toast("挂上了：" + out.title);
    } catch (e) { toast("没挂上：" + e.message); }
    finally { row.classList.remove("busy"); }
  }

  // Which sentences of a turn are already cards, so a reload keeps the marks.
  async function loadPicked(index) {
    for (const who of ["a", "q"]) {
      if (who === "q" && !(S.turns[index] && S.turns[index].q)) continue;
      const id = msgId(index, who);
      try {
        const d = await api("GET", forChat("picked?message=" + encodeURIComponent(id)));
        if (d && typeof d === "object") S.picked.set(id, d);
      } catch (e) { /* an unreadable mark is not worth an error */ }
    }
  }

  async function renderTurn(t) {
    const i = S.turns.length;
    S.turns.push(t);
    const el = turnEl(i);
    paintQuestion(el, t.q);
    const shownQ = t.q + (t.images || []).map(n => (t.q ? "\n\n" : "") + "![](/images/" + n + ")").join("");
    if (shownQ) paintSentences(el.querySelector("[data-qbox]"), i, shownQ, "user");
    if (t.reasoning) {
      const think = el.querySelector(".think");
      think.hidden = false;
      mountMd(el.querySelector("[data-think]"), t.reasoning);
    }
    paintTools(el, t.tools || []);
    if (t.status) { const s2 = el.querySelector(".status"); s2.hidden = false; s2.textContent = t.status; }
    if (t.error) { const e = el.querySelector(".err"); e.hidden = false; e.textContent = t.error; }
    await loadPicked(i);
    if (t.a) paintSentences(el.querySelector("[data-answer]"), i, t.a, "assistant");
    paintUsage(el, t.usage);
    scrollDown();
  }

  // ------------------------------------------------------------- one turn
  function liveTurn(q, images) {
    const i = S.turns.length;
    const pics = images || [];
    // The picture is part of the question: it shows in the bubble and can itself
    // be picked into a card like any other sentence.
    const shown = q + pics.map(n => (q ? "\n\n" : "") + "![](/images/" + n + ")").join("");
    const el = paintQuestion(turnEl(i), shown);
    const live = { q, images: pics, a: "", reasoning: "", tools: [], error: "", status: "", usage: {}, at: Date.now() };
    // the user's own question is pickable at once — no need to wait for an answer
    paintSentences(el.querySelector("[data-qbox]"), i, q, "user");
    return { index: i, el, live };
  }

  async function ask() {
    const box = $("ask");
    const prompt = box.value.trim();
    if (!prompt || S.streaming) return;
    if (!S.chat) S.chat = "";                    // the server names the chat
    S.asked = prompt;
    const intro = $("log").querySelector(".intro");
    if (intro) intro.remove();
    box.value = ""; box.style.height = "";
    S.streaming = true;
    $("send").disabled = true; $("stop").hidden = false;
    const { index, el, live } = liveTurn(prompt, S.images);
    const attached = S.images.slice();
    S.images = []; paintAttachments();
    const answer = el.querySelector("[data-answer]");
    let text = "";
    const paint = () => paintAnswer(el, text, true);
    let raf = null;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; paint(); }); };

    const ctl = new AbortController();
    S.abort = ctl;
    // Codex can spend a while connecting before its first word (it retries its
    // socket, then falls back). Say so instead of letting it look hung.
    const slow = setTimeout(() => {
      const box = el.querySelector(".status");
      if (!text && box && !box.textContent) {
        box.hidden = false;
        box.textContent = "还在连接 Codex……（它先试 WebSocket，超时后会回退到 HTTPS，慢网络上第一轮可能要一两分钟）";
      }
    }, 20000);
    try {
      const r = await fetch("/api/chat", {
        method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat: S.chat || undefined, prompt, cwd: S.cwd || undefined, images: attached }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: "HTTP " + r.status }));
        throw new Error(d.error || "HTTP " + r.status);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.event === "chat") {
            if (ev.chat && ev.chat !== S.chat) {
              S.chat = ev.chat;
              store.set("km-codex-chat", S.chat);
              store.set("km-codex-title", title());
              loadGraph(true);
            }
            if (ev.cwd) { S.cwd = ev.cwd; $("cwd").value = S.cwd; store.set("km-codex-cwd", S.cwd); }
          } else if (ev.event === "thread") {
            S.thread = ev.thread || S.thread;
          } else if (ev.event === "text") {
            // Codex may send the whole message again or only the new part.
            const piece = ev.text || "";
            text = piece.startsWith(text) ? piece : text + piece;
            live.a = text;
            soon();
          } else if (ev.event === "reasoning") {
            live.reasoning += ev.text || "";
            const think = el.querySelector(".think");
            think.hidden = false;
            mountMd(el.querySelector("[data-think]"), live.reasoning);
          } else if (ev.event === "tool") {
            live.tools.push({ name: ev.name, detail: ev.detail, status: ev.status });
            paintTools(el, live.tools);
          } else if (ev.event === "status") {
            live.status = ev.message || "";
            const box = el.querySelector(".status");
            box.hidden = false; box.textContent = live.status;
          } else if (ev.event === "usage") {
            live.usage = ev.usage || {};
            paintUsage(el, live.usage);
          } else if (ev.event === "error") {
            live.error = (live.error ? live.error + "\n" : "") + (ev.message || "出错了");
            const e2 = el.querySelector(".err"); e2.hidden = false; e2.textContent = live.error;
          } else if (ev.event === "raw") {
            live.error = (live.error + "\n" + (ev.text || "")).trim();
          } else if (ev.event === "saved") {
            live.saved = true;
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") live.error = (live.error + "\n" + e.message).trim();
    } finally {
      clearTimeout(slow);
      S.abort = null;
      S.streaming = false;
      $("send").disabled = false; $("stop").hidden = true;
      S.turns.push(live);
      const done = el;
      if (live.error) { const e2 = done.querySelector(".err"); e2.hidden = false; e2.textContent = live.error; }
      await loadPicked(index);
      const statusBox = done.querySelector(".status");
      if (statusBox) statusBox.hidden = !live.status || !!live.a;
      if (live.images && live.images.length) paintSentences(done.querySelector("[data-qbox]"), index, live.q + live.images.map(n => "\n\n![](/images/" + n + ")").join(""), "user");
      if (live.a) paintSentences(done.querySelector("[data-answer]"), index, live.a, "assistant");
      else {
        paintAnswer(done, live.error ? "_（这一轮没拿到回答）_" : "_（这一轮没有回答，可能是网络超时）_", false);
        const again = document.createElement("button");
        again.textContent = "重试这一轮";
        again.title = "把刚才那句话再发一次";
        again.style.marginTop = "6px";
        again.onclick = () => { $("ask").value = live.q; $("ask").focus(); again.remove(); };
        done.querySelector(".a").appendChild(again);
      }
      paintUsage(done, live.usage);
      scrollDown(true);
    }
  }

  // ----------------------------------------------------- the box selection
  // Ctrl/⌘ + drag marks the sentences inside the box; one bar decides whether
  // they become one card each or a single card holding all of them — the same
  // gesture as the whiteboard, on the picking side of the screen.
  (function marquee() {
    let box = null, chosen = [], moved = false;
    const noSelect = on => { if (document.body.style) document.body.style.userSelect = on ? "none" : ""; };
    const clearMarks = () => document.querySelectorAll(".km-s.km-multi").forEach(el => el.classList.remove("km-multi"));
    const closeBar = () => {
      const el = document.querySelector(".km-multi-bar");
      if (el) el.remove();
      clearMarks(); chosen = []; noSelect(false);
    };
    const rowsIn = rect => [...document.querySelectorAll("#log .km-s")].filter(el => {
      const r = el.getBoundingClientRect();
      return r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom;
    });
    const paint = rect => { clearMarks(); chosen = rowsIn(rect); chosen.forEach(el => el.classList.add("km-multi")); };
    const rectOf = (a, b) => ({ left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) });

    async function run(merge) {
      const all = chosen.filter(el => el.isConnected);
      const fresh = all.filter(el => !el.classList.contains("picked"));
      if (!fresh.length) { toast("框里的句子都已经入库了"); return closeBar(); }
      document.querySelectorAll(".km-multi-bar button").forEach(b => { b.disabled = true; });
      toast(fresh.length > 1 ? `正在把 ${fresh.length} 句写进知识图……` : "正在写进知识图……");
      const made = [];
      try {
        for (const row of fresh) {
          const out = await api("POST", forChat("pick"), {
            text: row.dataset.kmText, title: "",
            origin: { kind: "codex", session: S.chat, message: row.dataset.kmMsg,
                      index: Number(row.dataset.kmIdx), turn: turnOfRow(row),
                      speaker: row.dataset.kmSpeaker, question: (S.turns[turnOfRow(row)] || {}).q || "", cwd: S.cwd },
          });
          made.push(out.id);
          row.classList.add("picked");
        }
        let keep = made[0];
        if (merge && made.length > 1) {
          for (const id of made.slice(1)) await api("POST", forChat("cards/merge"), { source: id, target: keep });
        }
        const skipped = all.length - fresh.length;
        tellGraph({ type: "refresh", card: keep });
        toast(merge ? `${made.length} 句合成了一张卡` : `${made.length} 句各成了一张卡` + (skipped ? `（${skipped} 句已入库，跳过）` : ""));
        fresh.forEach(r => { if (!r.querySelector(".km-tag")) { const t = document.createElement("span"); t.className = "km-tag"; t.textContent = "✓ 已入库"; r.appendChild(t); } });
      } catch (e) { toast("没挂上：" + e.message); }
      closeBar();
    }
    const turnOfRow = row => {
      const m = /-(\d+)-[aq]$/.exec(row.dataset.kmMsg || "");
      return m ? Number(m[1]) : null;
    };
    function showBar(n) {
      const old = document.querySelector(".km-multi-bar");
      if (old) old.remove();
      const bar = document.createElement("div");
      bar.className = "km-multi-bar";
      const t = document.createElement("b"); t.textContent = `选了 ${n} 句`; bar.appendChild(t);
      // A box of sentences is one card: that is what selecting a passage means.
      [["合成一张卡", "框住的句子合成一张，正文按顺序连起来，每句的出处都留着", () => run(true)],
       ["取消", "清空选择（Esc 也行）", closeBar]].forEach(([label, hint, fn]) => {
        const b = document.createElement("button");
        b.textContent = label; b.title = hint; b.onclick = fn; bar.appendChild(b);
      });
      document.body.appendChild(bar);
    }
    const down = e => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      if (!e.target.closest("#log")) return;
      closeBar();
      const start = { x: e.clientX, y: e.clientY };
      moved = false;
      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        if (!moved) {
          moved = true; noSelect(true);
          box = document.createElement("div"); box.className = "km-marquee"; document.body.appendChild(box);
        }
        const r = rectOf(start, { x: ev.clientX, y: ev.clientY });
        box.style.left = r.left + "px"; box.style.top = r.top + "px";
        box.style.width = (r.right - r.left) + "px"; box.style.height = (r.bottom - r.top) + "px";
        paint(r);
      };
      const up = ev => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up, true);
        noSelect(false);
        if (box) { box.remove(); box = null; }
        if (!moved) return;
        const swallow = e2 => { e2.stopPropagation(); e2.preventDefault(); };
        document.addEventListener("click", swallow, true);
        setTimeout(() => document.removeEventListener("click", swallow, true), 300);
        paint(rectOf(start, { x: ev.clientX, y: ev.clientY }));
        const n = chosen.filter(el => el.isConnected).length;
        if (!n) return toast("框里没有句子");
        showBar(n);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up, true);
    };
    const key = e => { if (e.key === "Escape") closeBar(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
  })();

  // ------------------------------------------- back from a card to its sentence
  // The graph asks to see where something was said: this page owns the chat, so
  // it can simply scroll to it.
  window.addEventListener("message", async e => {
    const d = e.data;
    if (!d || d.source !== "km-app" || d.type !== "goto") return;
    const want = String(d.text || "").replace(/\s+/g, " ").trim();
    for (let n = 0; n < 40; n++) {
      const rows = [...document.querySelectorAll('#log .km-s[data-km-msg="' + d.message + '"]')];
      const el = rows.find(r => r.dataset.kmText === want) || rows[Number(d.index)] || rows[0];
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
        return toast("已定位到原文");
      }
      await new Promise(r => setTimeout(r, 150));
    }
    toast("原文那句没找到（可能还没加载出来）");
  });

  // ------------------------------------------------------------- the shell
  async function openChat(id, { keepGraph = false } = {}) {
    if (!id) return;
    S.chat = id;
    S.picked.clear();
    S.turns = [];
    $("log").innerHTML = "";
    let record = { turns: [] };
    try { record = await api("GET", "chat/" + encodeURIComponent(id)); }
    catch (e) { toast("读不到这个对话：" + e.message); }
    S.thread = record.thread || "";
    if (record.cwd) { S.cwd = record.cwd; $("cwd").value = S.cwd; store.set("km-codex-cwd", S.cwd); }
    store.set("km-codex-chat", S.chat);
    if (record.turns.length) { store.set("km-codex-title", (record.turns[0].q || "").slice(0, 60)); }
    for (const t of record.turns) await renderTurn(t);
    if (!keepGraph) loadGraph(true);
    if (!record.turns.length) {
      $("log").innerHTML = `<div class="who intro" style="color:var(--muted);margin-bottom:10px">
        新对话。问 Codex 一个问题，回答里的每一句都能点进右边的知识图。</div>`;
    }
  }

  function newChat() {
    S.chat = ""; S.turns = []; S.picked.clear(); S.thread = ""; S.asked = "";
    $("log").innerHTML = "";
    $("graph").setAttribute("src", "about:blank");
    store.set("km-codex-chat", "");
    toast("新对话：下一个问题会开一个新的知识库");
    $("ask").focus();
  }

  async function showChats() {
    const panel = $("chats-panel");
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = `<div class="head">最近对话（每个对话有自己的一份知识库）</div>`;
    try {
      const d = await api("GET", "chats");
      if (!d.chats.length) panel.innerHTML += `<div class="head">还没有对话。</div>`;
      d.chats.forEach(c => {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span class="t">${esc(c.title || c.id)}</span><span class="m">${c.turns} 轮 · ${timeAgo(c.at)}</span>`;
        row.onclick = () => { panel.hidden = true; openChat(c.id); };
        panel.appendChild(row);
      });
    } catch (e) { panel.innerHTML += `<div class="head">读不到：${esc(e.message)}</div>`; }
  }

  // One picture at a time is enough to make a question clearer; it goes to Codex
  // itself (`codex exec -i`), not just into the log.
  function paintAttachments() {
    const row = $("attach-row");
    row.hidden = !S.images.length;
    row.innerHTML = "";
    S.images.forEach((name, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const img = document.createElement("img");
      img.src = "/images/" + name;
      const del = document.createElement("button");
      del.textContent = "×"; del.title = "不带这张";
      del.onclick = () => { S.images.splice(i, 1); paintAttachments(); };
      chip.appendChild(img); chip.appendChild(del);
      row.appendChild(chip);
    });
    $("attach").classList.toggle("active", !!S.images.length);
  }
  $("attach").onclick = () => $("file").click();
  $("file").onchange = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("读不出这个文件"));
        fr.readAsDataURL(file);
      });
      const up = await api("POST", "images", { data_b64: dataUrl, name: file.name });
      S.images.push(up.name);
      paintAttachments();
      toast("图加上了，发送时会一起给 Codex");
    } catch (err) { toast("图片没加上：" + err.message); }
  };
  $("ask").onpaste = e => {
    const file = [...((e.clipboardData && e.clipboardData.files) || [])].find(f => /^image\//.test(f.type || ""));
    if (!file) return;
    e.preventDefault();
    const dt = new DataTransfer();
    dt.items.add(file);
    $("file").files = dt.files;
    $("file").onchange({ target: $("file") });
  };
  $("send").onclick = ask;
  $("stop").onclick = () => { if (S.abort) S.abort.abort(); };
  $("new").onclick = newChat;
  $("chats").onclick = showChats;
  $("ask").onkeydown = e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  };
  $("ask").oninput = e => {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
  };
  $("cwd").onchange = e => {
    S.cwd = e.target.value.trim();
    store.set("km-codex-cwd", S.cwd);
    toast(S.cwd ? "下一轮会在 " + S.cwd + " 里工作" : "用 Codex 默认目录");
  };

  // the divider between the two halves
  (function grip() {
    const width = store.get("km-codex-left", 0);
    if (width) $("left").style.flex = `0 0 ${width}px`;
    const start = e => {
      e.preventDefault();
      const g = $("grip");
      g.classList.add("on");
      const move = ev => {
        const w = Math.max(320, Math.min(window.innerWidth - 320, ev.clientX));
        $("left").style.flex = `0 0 ${w}px`;
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        g.classList.remove("on");
        store.set("km-codex-left", $("left").getBoundingClientRect().width | 0);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    $("grip").addEventListener("pointerdown", start);
  })();

  // ------------------------------------------------------------- first paint
  if (!S.cwd) S.cwd = store.get("km-codex-cwd", "") || "";
  $("cwd").value = S.cwd;
  $("cwd").placeholder = "例如 /Users/你/项目（留空用默认）";
  if (S.chat) openChat(S.chat);
  else { $("log").innerHTML = `<div class="who intro" style="color:var(--muted)">新对话。问 Codex 一个问题，回答里的每一句都能点进右边的知识图。</div>`; }
  $("ask").focus();
})();
