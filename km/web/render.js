// Markdown → safe HTML with formulas, code highlighting, tables and mermaid.
//
// Math has to come out of the text BEFORE Markdown sees it: Markdown would
// otherwise read `_` as emphasis and eat backslashes inside formulas. So we
// walk the source once, skip over code (a `$` in code is not math), swap
// every formula for a placeholder token, render Markdown, then put the
// KaTeX output where the tokens are.
(function () {
  const md = window.markdownit({
    html: true,          // sanitized below with DOMPurify
    linkify: true,
    breaks: false,
    highlight(code, lang) {
      // A result starting with <pre is used as-is; anything else gets wrapped
      // in <pre><code>, whose styles would hide the diagram.
      if (lang === "mermaid") return `<pre class="mermaid-wrap"><div class="mermaid">${escapeHtml(code)}</div></pre>`;
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch (e) {}
      }
      return "";  // markdown-it escapes it
    },
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Returns [textWithTokens, formulas, wikilinks].
  function extractMath(src) {
    const out = [], math = [], links = [];
    let i = 0;
    const n = src.length;
    const token = (tex, display) => {
      math.push({ tex, display });
      const t = `KMMATH${math.length - 1}KM`;
      return display ? `\n\n${t}\n\n` : t;
    };
    const lineStart = k => k === 0 || src[k - 1] === "\n";
    while (i < n) {
      const rest = src.slice(i, i + 20);
      // fenced code block (also ```math, handled as display math)
      if (lineStart(i) && /^[ \t]*(`{3,}|~{3,})/.test(rest)) {
        const m = src.slice(i).match(/^[ \t]*(`{3,}|~{3,})([^\n]*)\n?/);
        const fence = m[1], lang = m[2].trim().toLowerCase();
        const close = src.indexOf("\n" + fence[0].repeat(fence.length), i + m[0].length - 1);
        const end = close < 0 ? n : src.indexOf("\n", close + 1) < 0 ? n : src.indexOf("\n", close + 1);
        const block = src.slice(i, end);
        if (["math", "latex", "tex", "katex"].includes(lang)) {
          const body = src.slice(i + m[0].length, close < 0 ? n : close);
          out.push(token(body, true));
        } else out.push(block);
        i = end;
        continue;
      }
      // inline code
      if (src[i] === "`") {
        const ticks = src.slice(i).match(/^`+/)[0];
        const close = src.indexOf(ticks, i + ticks.length);
        if (close > 0) { out.push(src.slice(i, close + ticks.length)); i = close + ticks.length; continue; }
      }
      // [[card title]] / [[card title|shown text]] → link to another card
      if (src.startsWith("[[", i)) {
        const close = src.indexOf("]]", i + 2), nl = src.indexOf("\n", i);
        if (close > 0 && (nl < 0 || close < nl)) {
          const [target, label] = src.slice(i + 2, close).split("|");
          if (target.trim()) {
            links.push({ target: target.trim(), label: (label || target).trim() });
            out.push(`KMLINK${links.length - 1}KM`);
            i = close + 2;
            continue;
          }
        }
      }
      // escaped dollar
      if (src[i] === "\\" && src[i + 1] === "$") { out.push("\\$"); i += 2; continue; }
      // $$ display $$
      if (src.startsWith("$$", i)) {
        const close = src.indexOf("$$", i + 2);
        if (close > 0) { out.push(token(src.slice(i + 2, close), true)); i = close + 2; continue; }
      }
      // \[ display \]
      if (src.startsWith("\\[", i)) {
        const close = src.indexOf("\\]", i + 2);
        if (close > 0) { out.push(token(src.slice(i + 2, close), true)); i = close + 2; continue; }
      }
      // \begin{env} ... \end{env}
      if (src.startsWith("\\begin{", i)) {
        const m = src.slice(i).match(/^\\begin\{([a-zA-Z*]+)\}/);
        if (m) {
          const endTag = `\\end{${m[1]}}`;
          const close = src.indexOf(endTag, i);
          if (close > 0) { out.push(token(src.slice(i, close + endTag.length), true)); i = close + endTag.length; continue; }
        }
      }
      // \( inline \)
      if (src.startsWith("\\(", i)) {
        const close = src.indexOf("\\)", i + 2);
        if (close > 0) { out.push(token(src.slice(i + 2, close), false)); i = close + 2; continue; }
      }
      // $inline$ — not "$5 and $10" (no space just inside, no digit after) and
      // not shell like "$HOME/bin:$PATH" (no letter right after the closing $)
      if (src[i] === "$") {
        const m = src.slice(i).match(/^\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\w])/);
        if (m) { out.push(token(m[1], false)); i += m[0].length; continue; }
      }
      out.push(src[i]);
      i++;
    }
    return [out.join(""), math, links];
  }

  function renderTex(tex, display) {
    try {
      return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      return `<code class="math-error">${escapeHtml(tex)}</code>`;
    }
  }

  // refs: {target: cardId|null} from the server; missing targets show as such.
  function renderMarkdown(src, { inline = false, refs = null } = {}) {
    if (!window.markdownit) return `<pre>${escapeHtml(src)}</pre>`;
    const [text, math, links] = extractMath(String(src || ""));
    let html = inline && !/\n\s*\n/.test(text) && !/^\s*([#>|-]|\d+\.|```)/m.test(text)
      ? md.renderInline(text) : md.render(text);
    html = window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ["target"] }) : html;
    return html
      .replace(/<p>\s*KMMATH(\d+)KM\s*<\/p>/g, (_, k) => `<div class="math-block">${renderTex(math[+k].tex, true)}</div>`)
      .replace(/KMMATH(\d+)KM/g, (_, k) => renderTex(math[+k].tex, math[+k].display))
      .replace(/KMLINK(\d+)KM/g, (_, k) => {
        const l = links[+k];
        const missing = refs && !refs[l.target];
        return `<a href="#" class="wikilink${missing ? " missing" : ""}" data-target="${escapeHtml(l.target)}"`
          + `${missing ? ' title="还没有这张卡，点一下新建"' : ""}>${escapeHtml(l.label)}</a>`;
      });
  }

  let mermaidLoading = null;
  function renderMermaidIn(root) {
    const blocks = root.querySelectorAll("div.mermaid:not([data-done])");
    if (!blocks.length) return;
    mermaidLoading = mermaidLoading || new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "vendor/mermaid/mermaid.min.js";
      s.onload = () => {
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
        ok();
      };
      s.onerror = fail;
      document.head.appendChild(s);
    });
    mermaidLoading.then(() => {
      blocks.forEach(b => b.setAttribute("data-done", "1"));
      mermaid.run({ nodes: [...blocks] }).catch(() => {});
    });
  }

  // Render into an element and finish async parts (mermaid).
  function mount(el, src, opts) {
    el.innerHTML = renderMarkdown(src, opts);
    el.querySelectorAll("a[href]:not(.wikilink)").forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
    renderMermaidIn(el);
  }

  window.KMRender = { renderMarkdown, mount, extractMath, escapeHtml };
})();
