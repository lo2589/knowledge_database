// dsh-plugin-known-manage — Client half.
//
// One screen, nothing to switch to: dsh's chat on the left, the knowledge
// graph on the right, both always on screen.
//
//   conversation.chat.node / assistant-step   answers render sentence by
//       sentence (with dsh's own Markdown, so formulas and code look exactly
//       as before); click a sentence and it becomes a card under the graph's
//       挂载点. Picked sentences stay marked; clicking one again shows its card.
//   shell.overlay                             the graph panel, docked right,
//       never closable; drag its left edge to resize. dsh's own frame is
//       narrowed by the same width so nothing sits under the panel.
//
// Every card knows the session, message and sentence it came from; the graph
// asks for a jump with postMessage and this half opens the session, scrolls
// to that sentence and flashes it.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-known-manage',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const MIN_W = 380
    const LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
    // The shared right column, declared by dsh-plugin-rightbar. When it exists
    // the graph is one tab in it and nothing here reserves space; the floating
    // panel below is only the fallback for a harness without that column.
    const TAB_SLOT = 'rightbar.tab'
    const TAB_ID = 'known-manage'
    // dsh's frame makes room for the fallback panel: it sits beside the chat,
    // not on top of it. Inside the shared column rightbar already writes
    // --rightbar-w, so narrowing #root here too would be a fight.
    const NARROW_CSS = '#root{width:calc(100vw - var(--km-w)) !important;min-width:0}'

    const CSS = [
      ':root{--km-w:46vw}',
      '.km-panel{position:fixed;top:0;right:0;bottom:0;width:var(--km-w);z-index:520;display:flex;flex-direction:column;',
      'background:#fbfaf8;border-left:1px solid var(--dsw-alias-border-secondary,#e5e7eb);pointer-events:auto}',
      '.km-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2}',
      '.km-grip:hover,.km-grip.on{background:rgba(47,91,211,.25)}',
      '.km-tab{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.km-frame{flex:1;min-height:0;border:0;width:100%;background:#fbfaf8}',
      '.km-hint{padding:16px;font-size:12.5px;line-height:1.8;opacity:.8;white-space:pre-wrap}',
      '.km-empty{opacity:1;margin:auto;max-width:360px;text-align:center;font-size:14px;color:#374151}',
      '.km-empty b{display:block;font-size:16px;color:#2f5bd3}',
      '.km-panel.dragging .km-frame{pointer-events:none}',
      // sentences in answers
      '.km-ans{display:flex;flex-direction:column;gap:2px}',
      '.km-s{position:relative;border-radius:6px;padding:1px 6px 1px 8px;margin-left:-8px;border-left:3px solid transparent;cursor:pointer;transition:background .12s}',
      '.km-s:hover{background:rgba(47,91,211,.07);border-left-color:rgba(47,91,211,.45)}',
      '.km-s.picked{background:rgba(31,122,74,.07);border-left-color:#1f7a4a;padding-right:64px}',
      '.km-s.busy{opacity:.55}',
      '.km-s.flash{animation:kmflash 2.2s ease}',
      '@keyframes kmflash{0%,45%{background:rgba(242,201,76,.55);box-shadow:0 0 0 2px #f2c94c}100%{background:transparent}}',
      '.km-s .km-tag{position:absolute;right:6px;top:2px;font-size:11px;color:#1f7a4a;background:rgba(255,255,255,.85);border-radius:4px;padding:0 4px}',
      '.km-s > div p:last-child{margin-bottom:0}',
      '.km-user-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}',
      '.km-user-ans{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);background:var(--dsw-specific-bubble,#edf0f4);border-radius:18px;padding:7px 10px}',
      '.km-user-ans .km-s{margin-left:0;padding:3px 8px;border-radius:5px}',
      '.km-think{font-size:12.5px;color:var(--dsw-alias-label-secondary,#6b7280);border-left:2px solid #e5e7eb;padding:2px 8px;margin:4px 0;white-space:pre-wrap}',
      '.km-think summary{cursor:pointer}',
      '.km-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:530;pointer-events:none;',
      'background:#111827;color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px}',
      // Ctrl-drag over the conversation: the sentences in the box are marked,
      // and the bar below says what to do with them.
      '.km-marquee{position:fixed;z-index:525;border:1px solid #2f5bd3;background:rgba(47,91,211,.10);border-radius:3px;pointer-events:none}',
      '.km-s.km-multi{background:rgba(47,91,211,.13);border-left-color:#2f5bd3;box-shadow:inset 0 0 0 1px rgba(47,91,211,.35)}',
      '.km-multi-bar{position:fixed;z-index:531;left:50%;bottom:92px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;',
      'background:#111827;color:#fff;border-radius:10px;padding:7px 10px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '.km-multi-bar button{font:inherit;color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:7px;padding:3px 9px;cursor:pointer}',
      '.km-multi-bar button:hover{background:rgba(255,255,255,.28);border-color:rgba(255,255,255,.4)}',
      '.km-multi-bar button:last-child{background:transparent;border-color:rgba(255,255,255,.28)}',
      '.km-multi-bar button:disabled{opacity:.5;cursor:default}',
    ].join('')

    // Shared between the seats: the graph frame, a toast, and what was picked.
    // `hosted` is true while the graph is a tab of the shared right column.
    const bus = {
      frame: null, toast: '', hosted: false, url: '', listeners: new Set(), pickedVersion: 0,
      set(p) { Object.assign(bus, p); bus.listeners.forEach((f) => f()) },
      post(msg) { const w = bus.frame && bus.frame.contentWindow; if (w) w.postMessage(Object.assign({ source: 'km-host' }, msg), '*') },
    }
    function useBus() {
      const [, tick] = React.useState(0)
      React.useEffect(() => { const f = () => tick((n) => n + 1); bus.listeners.add(f); return () => bus.listeners.delete(f) }, [])
      return bus
    }
    // --- what this page sees of its own right column ---------------------------
    // One small report to the knowledge server after mount, on every seat change
    // and on a slow tick, so a panel that stays blank can be answered from
    // data/repos/diag.json instead of guessed at. Geometry and window errors
    // only; it never changes what is drawn.
    const errors = []
    window.addEventListener('error', (e) => { if (errors.length < 8) errors.push(String(e.message || e).slice(0, 160)) })
    // How much width the shared column says it is using. Rightbar writes this
    // once, on <html>; zero means it is drawing nothing at all.
    function rightbarReserved() {
      const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rightbar-w'))
      return Number.isFinite(n) ? n : 0
    }
    function rectOf(sel) {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    }
    function reportDiag() {
      try {
        if (!bus.url) return
        const body = {
          at: new Date().toString().slice(0, 24), hosted: bus.hosted, errors,
          viewport: [window.innerWidth, window.innerHeight],
          rightbarW: getComputedStyle(document.documentElement).getPropertyValue('--rightbar-w').trim(),
          kmW: document.documentElement.style.getPropertyValue('--km-w'),
          tabs: [...document.querySelectorAll('.rb-tab')].map((t) => t.textContent),
          rbPanel: rectOf('.rb-panel'), rbStrip: rectOf('.rb-strip'), rbBody: rectOf('.rb-body'),
          kmTab: rectOf('.km-tab'), kmPanel: rectOf('.km-panel'), kmFrame: rectOf('.km-frame'),
          frameSrc: (document.querySelector('.km-frame') || {}).src || '',
          ua: navigator.userAgent.slice(0, 110),
        }
        fetch(bus.url + 'api/diag?d=' + encodeURIComponent(JSON.stringify(body)), { mode: 'no-cors', cache: 'no-store' }).catch(() => {})
      } catch (e) { /* a report must never break the page */ }
    }

    function toast(text) { bus.set({ toast: text }); clearTimeout(toast.t); toast.t = setTimeout(() => bus.set({ toast: '' }), 2600) }

    // --- the graph panel -------------------------------------------------------
    function readWidth() {
      const narrow = window.innerWidth < 900
      const min = narrow ? Math.max(250, Math.round(window.innerWidth * 0.45)) : MIN_W
      const max = Math.max(min, window.innerWidth - (narrow ? 270 : 480))
      try { const w = Number(localStorage.getItem('km-panel-w')); if (w >= min) return Math.min(w, max) } catch (e) {}
      return Math.min(max, Math.max(min, Math.round(window.innerWidth * (narrow ? 0.48 : 0.46))))
    }
    function applyWidth(w) { document.documentElement.style.setProperty('--km-w', w + 'px') }

    // The graph frame always shows the CURRENT session's knowledge base. Both
    // seats — the shared column's tab and the fallback floating panel — render
    // exactly this, so what you see does not depend on where it is mounted.
    function GraphFrame({ sessionStore }) {
      const [status, setStatus] = React.useState({ url: '', error: '' })
      const snapshot = React.useSyncExternalStore(
        React.useCallback((notify) => sessionStore.subscribe(notify), [sessionStore]),
        React.useCallback(() => sessionStore.getSnapshot(), [sessionStore]))
      const sessionId = snapshot.current || ''
      const summary = snapshot.byId[sessionId]
      const sessionTitle = summary && (summary.title || summary.displayTitle) || ''
      const [reloadKey, setReloadKey] = React.useState(0)
      const ready = React.useRef(false)

      // tell the graph which session it is showing
      React.useEffect(() => { if (ready.current) bus.post({ type: 'session', id: sessionId, title: sessionTitle }) }, [sessionId, sessionTitle])

      // the graph says "ready" once it has drawn; if it does not (the server
      // was restarting when the frame loaded), load the frame again
      React.useEffect(() => {
        const onMsg = (e) => { if (e.data && e.data.source === 'km-app' && e.data.type === 'ready') { ready.current = true; bus.post({ type: 'session', id: sessionId, title: sessionTitle }) } }
        window.addEventListener('message', onMsg)
        ready.current = false
        const t = setTimeout(() => { if (!ready.current && status.url && sessionId) setReloadKey((k) => k + 1) }, 7000)
        return () => { window.removeEventListener('message', onMsg); clearTimeout(t) }
      }, [status.url, reloadKey, sessionId, sessionTitle])
      React.useEffect(() => {
        let live = true
        const poll = async () => {
          try {
            const s = await (await fetch('/plugins/known-manage/status', { cache: 'no-store' })).json()
            if (s.url && s.url !== bus.url) { bus.url = s.url; reportDiag() }
            if (live) setStatus((o) => (o.url === s.url && o.error === s.error ? o : s))
          } catch (e) { if (live) setStatus((o) => ({ ...o, error: '拿不到知识库状态：' + e.message })) }
        }
        poll()
        const id = setInterval(poll, 5000)
        return () => { live = false; clearInterval(id) }
      }, [])
      if (!sessionId) {
        return h('div', { className: 'km-hint km-empty' },
          h('b', null, '这里是当前会话的知识库'), '\n\n在左边打开一个会话，或者新建一个会话问个问题。\n回答里的每一句都能点，点了就挂到这里。')
      }
      if (!status.url) return h('div', { className: 'km-hint' }, status.error || '知识库正在启动…（起来后自动显示）')
      const src = status.url + '?s=' + encodeURIComponent(sessionId) + '&t=' + encodeURIComponent(sessionTitle) + '&v=20261005p'
      return h('iframe', { className: 'km-frame', src, key: src + '#' + reloadKey, ref: (el) => { bus.frame = el } })
    }

    // The fallback seat: its own floating panel, which disappears the moment
    // the shared right column hosts the same frame as a tab.
    function Panel({ sessionStore }) {
      const b = useBus()
      const [drag, setDrag] = React.useState(false)
      const hosted = b.hosted
      React.useEffect(() => {
        if (hosted) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-known-manage'
        tag.textContent = NARROW_CSS
        document.head.appendChild(tag)
        applyWidth(readWidth())
        const resize = () => applyWidth(readWidth())
        window.addEventListener('resize', resize)
        return () => {
          tag.remove(); window.removeEventListener('resize', resize)
          document.documentElement.style.removeProperty('--km-w')
        }
      }, [hosted])
      const startResize = (e) => {
        e.preventDefault()
        setDrag(true)
        const move = (ev) => {
          const narrow = window.innerWidth < 900
          const min = narrow ? Math.max(250, Math.round(window.innerWidth * 0.45)) : MIN_W
          applyWidth(Math.max(min, Math.min(window.innerWidth - (narrow ? 270 : 480), window.innerWidth - ev.clientX)))
        }
        const up = () => {
          setDrag(false)
          document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
          try { localStorage.setItem('km-panel-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--km-w')))) } catch (err) {}
        }
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
      }
      if (hosted) return null
      return h('div', { className: 'km-panel' + (drag ? ' dragging' : '') },
        h('div', { className: 'km-grip' + (drag ? ' on' : ''), title: '拖动调整宽度', onPointerDown: startResize }),
        h(GraphFrame, { sessionStore }))
    }

    // The shared column's seat: the same frame, filling the tab, with no width
    // or placement of its own — rightbar owns both.
    function makeTab(sessionStore) {
      return function KnownManageTab() { return h('div', { className: 'km-tab' }, h(GraphFrame, { sessionStore })) }
    }
    function Toast() { const b = useBus(); return b.toast ? h('div', { className: 'km-toast' }, b.toast) : null }
    function makeOverlay(sessionStore) { return function Overlay() { return h(React.Fragment, null, h(Panel, { sessionStore }), h(Toast)) } }

    // --- writing into the chat composer ----------------------------------------
    // dsh keeps the draft in a Lexical editor, so the text goes in through the
    // editor's own input pipeline at the caret; Enter then sends it as usual.
    function composerEditor() {
      const editors = [...document.querySelectorAll('[contenteditable="true"]')]
      return editors.find((el) => el.hasAttribute('data-lexical-editor') || el.closest('[data-lexical-editor]'))
        || editors.find((el) => el.closest('[class*=composer],[class*=input]'))
        || editors[0] || null
    }
    function insertIntoComposer(text) {
      if (typeof text !== 'string' || !text.trim()) return
      const el = composerEditor()
      if (!el) return toast('没找到对话框，写不进去')
      el.focus()
      const sel = window.getSelection()
      if (!sel || !el.contains(sel.anchorNode)) {
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      // A rich-text editor keeps paragraphs, so hand it a real paste: that is the
      // path it already understands for multi-line text. Plain insertion stays as
      // the fallback for anything that does not accept a clipboard payload.
      let ok = false
      try {
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        ok = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      } catch (e) { ok = false }
      if (!ok) {
        try { ok = document.execCommand('insertText', false, text) } catch (e) { ok = false }
      }
      if (!ok) {
        el.textContent = (el.textContent || '') + text
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      toast('已写进对话框，回车就发')
    }

    // --- answers, sentence by sentence ---------------------------------------
    const splitCache = new Map()
    // Which turn a rendered message belongs to: the rail of turns in dsh's chat
    // is the only way to page a sentence of a long session back into the DOM.
    function turnOf(node, data) {
      const loc = node && node.location
      if (loc && (loc.kind === 'turn' || loc.kind === 'step')) return loc.turn.turn
      const n = data && data.turn
      return Number.isFinite(n) ? n : null
    }
    function useSentences(text) {
      const [units, setUnits] = React.useState(() => splitCache.get(text) || null)
      React.useEffect(() => {
        if (splitCache.has(text)) { setUnits(splitCache.get(text)); return undefined }
        let live = true
        fetch('/plugins/known-manage/split', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
          .then((r) => r.json()).then((u) => { if (Array.isArray(u)) { splitCache.set(text, u); if (live) setUnits(u) } }).catch(() => {})
        return () => { live = false }
      }, [text])
      return units
    }
    function usePicked(messageId, sessionId) {
      const b = useBus()
      const [state, setState] = React.useState({ picked: {} })
      React.useEffect(() => {
        if (!messageId) return undefined
        let live = true
        fetch('/plugins/known-manage/picked?message=' + encodeURIComponent(messageId) + '&s=' + encodeURIComponent(sessionId || '')).then((r) => r.json())
          .then((d) => { if (live && d && d.picked) setState(d) }).catch(() => {})
        return () => { live = false }
      }, [messageId, sessionId, b.pickedVersion])
      return state
    }

    function SentenceBlock({ text, base, messageId, sessionId, turn, picked, speaker = 'assistant' }) {
      const units = useSentences(text)
      const [busy, setBusy] = React.useState(-1)
      if (!units) return h(MarkdownText, { text, streaming: false, labels: LABELS })
      return h('div', { className: 'km-ans' + (speaker === 'user' ? ' km-user-ans' : '') }, units.map((u, i) => {
        const index = base + i
        const cards = Object.prototype.hasOwnProperty.call(picked, u.text) ? picked[u.text] : null
        return h('div', {
          key: i, className: 'km-s' + (cards ? ' picked' : '') + (busy === index ? ' busy' : ''),
          'data-km-msg': messageId, 'data-km-idx': index, 'data-km-turn': turn == null ? undefined : turn,
          // The exact sentence as it was split, plus who said it: the box
          // selection hands these straight back to the host, so what becomes a
          // card is the sentence itself and not whatever the Markdown rendered to.
          'data-km-text': u.text, 'data-km-speaker': speaker,
          title: cards ? '已入库：点一下在右边看这张卡' : '点一下：放进右边知识图的挂载点下',
          onClick: async (e) => {
            if (e.target.closest('a, button')) return
            if (cards) { bus.post({ type: 'focus', card: cards[cards.length - 1] }); return }
            setBusy(index)
            try {
              const r = await fetch('/plugins/known-manage/pick', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, messageId, index, text: u.text, speaker, turn }) })
              const out = await r.json()
              if (!out.ok) throw new Error(out.error)
              bus.set({ pickedVersion: bus.pickedVersion + 1 })
              bus.post({ type: 'refresh', card: out.card })
              toast('挂上了：' + out.title)
            } catch (err) { toast('没挂上：' + err.message) }
            finally { setBusy(-1) }
          },
        }, h(MarkdownText, { text: u.text, streaming: false, labels: LABELS }), cards ? h('span', { className: 'km-tag' }, '✓ 已入库') : null)
      }))
    }

    function Thinking({ text, running }) {
      return h('details', { className: 'km-think', open: running || undefined }, h('summary', null, running ? '思考中…' : '思考过程'), text)
    }

    function makeUser(getSession) {
      return function KmUser(props) {
        const data = props.node.data
        const sessionId = props.sessionId || getSession()
        const messageId = 'user:' + data.seq
        const turn = turnOf(props.node, data)
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        const images = (data.content || []).filter((b) => b.type === 'image' && b.attachment)
          .map((b) => ({ attachment: b.attachment }))
        const { picked } = usePicked(messageId, sessionId)
        // data-km-msg also marks the whole message: a jump that cannot find the
        // exact sentence still lands on the message it was said in.
        return h('div', { className: 'km-user-row', 'data-km-msg': messageId, 'data-km-turn': turn == null ? undefined : turn },
          images.length ? props.renderMessageImages({ images, align: 'end' }) : null,
          text ? h(SentenceBlock, { text, base: 0, messageId, sessionId, turn, picked, speaker: 'user' }) : null)
      }
    }

    // Replaces dsh's assistant renderer. Tool calls are drawn by the chat view
    // itself (not in this node), so only text, reasoning and images live here.
    function makeAssistant(getSession) {
      return function KmAssistant(props) {
        const data = props.node.data
        const streaming = data.status === 'running'
        const messageId = data.finalNode && data.finalNode.messageId
        const sessionId = props.sessionId || getSession()
        const turn = turnOf(props.node, data)
        const { picked } = usePicked(!streaming ? messageId : '', sessionId)
        const blocks = data.blocks || []
        if (!streaming && !blocks.some((b) => b.kind !== 'tool-call')) return null
        const out = []
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i]
          if (b.kind === 'text') {
            out.push(streaming || !messageId
              ? h(MarkdownText, { key: i, text: b.text, streaming, labels: LABELS })
              : h(SentenceBlock, { key: i, text: b.text, base: i * 1000, messageId, sessionId, turn, picked }))
          } else if (b.kind === 'reasoning') {
            out.push(h(Thinking, { key: i, text: b.text, running: streaming && i === blocks.length - 1 }))
          } else if (b.kind === 'image') {
            const group = [b]
            while (i + 1 < blocks.length && blocks[i + 1].kind === 'image') group.push(blocks[++i])
            out.push(h(React.Fragment, { key: 'img' + i }, props.renderMessageImages({ images: group.map((g) => ({ attachment: g.attachment })), align: 'start' })))
          } else if (b.kind !== 'tool-call') {
            out.push(h('pre', { key: i, style: { fontSize: '11px', whiteSpace: 'pre-wrap' } }, JSON.stringify(b.block || b, null, 2)))
          }
        }
        if (data.status === 'interrupted') out.push(h('span', { key: 'stop', style: { fontSize: '12px', opacity: 0.6 } }, '（已中断）'))
        return h('div', { style: { minWidth: 0 }, 'data-km-msg': streaming ? undefined : messageId,
          'data-km-turn': turn == null ? undefined : turn }, out)
      }
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const sessions = () => ctx.get('sessions')
      const currentSession = () => { const s = sessions(); return s && s.list.getSnapshot().current }

      // dsh renders no drag handle while the sidebar is collapsed, and a wide
      // right column can squeeze the frame below dsh's 1024 auto-collapse
      // breakpoint — which leaves the sidebar as a 56px rail that cannot be
      // dragged at all. When that squeeze is what collapsed it, put it back once
      // so the sidebar's own handle exists again; a collapse the user asked for
      // (wide frame, sidebar closed) is left alone.
      ctx.effect(() => {
        const restore = () => {
          const layout = ctx.get('layout')
          const root = document.getElementById('root')
          if (!layout || typeof layout.toggleSidebar !== 'function' || !root) return
          const rail = document.querySelector('[class*=sidebarCol]')
          const collapsed = !rail || rail.getBoundingClientRect().width <= 60
          if (root.getBoundingClientRect().width < 1024 && collapsed) layout.toggleSidebar()
        }
        const first = setTimeout(restore, 1500)
        return () => clearTimeout(first)
      }, 'known-manage:sidebar-drag')

      // dsh's sidebar drag handle is 8px wide, which is a pixel-hunt. Widen the
      // handle itself (keeping it centred on the edge) so the column is easy to
      // grab — dsh's own drag code still does the resizing.
      ctx.effect(() => {
        const widen = () => {
          const rail = document.querySelector('[class*=sidebarCol]')
          if (!rail) return
          const edge = rail.getBoundingClientRect().right
          const el = document.elementFromPoint(Math.max(1, edge - 4), 200)
          if (!el || getComputedStyle(el).cursor !== 'col-resize') return
          if (el.dataset.kmGrip) return
          el.dataset.kmGrip = '1'
          el.style.width = '20px'
          el.style.transform = 'translateX(-6px)'
        }
        widen()
        const tick = setInterval(widen, 2000)
        return () => {
          clearInterval(tick)
          document.querySelectorAll('[data-km-grip]').forEach((el) => {
            el.style.width = ''
            el.style.transform = ''
            delete el.dataset.kmGrip
          })
        }
      }, 'known-manage:grip')

      // Safety net: if the shared column hosts our tab but reserves no width, it
      // is not showing anything — so show our own panel instead of leaving the
      // right side empty. Two consecutive checks, so a slow first paint of
      // rightbar's own panel never causes a flash.
      ctx.effect(() => {
        let quiet = 0
        const check = () => {
          const reserved = rightbarReserved()
          if (reserved > 0) { quiet = 0; if (!bus.hosted && bus.tabbed) bus.set({ hosted: true }); return }
          quiet += 1
          if (quiet >= 2 && bus.hosted) bus.set({ hosted: false, tabbed: true })
        }
        const first = setTimeout(check, 3000)
        const tick = setInterval(check, 3000)
        return () => { clearTimeout(first); clearInterval(tick) }
      }, 'known-manage:column-check')

      ctx.effect(() => {
        const first = setTimeout(reportDiag, 1500)
        const tick = setInterval(reportDiag, 20000)
        bus.listeners.add(reportDiag)
        return () => { clearTimeout(first); clearInterval(tick); bus.listeners.delete(reportDiag) }
      }, 'known-manage:diag')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-known-manage'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'known-manage:styles')

      // Ctrl-drag a box over the conversation: every sentence inside it is marked,
      // and one bar decides what happens — one card each, or all of them folded
      // into a single card. Picking a passage sentence by sentence is twenty
      // clicks; this is one gesture.
      ctx.effect(() => {
        let box = null, from = null, moved = false
        let chosen = []
        const noSelect = (on) => { const b = document.body; if (b && b.style) b.style.userSelect = on ? 'none' : '' }
        const clearMark = () => {
          document.querySelectorAll('.km-s.km-multi').forEach((el) => el.classList.remove('km-multi'))
        }
        const closeBar = () => {
          const el = document.querySelector('.km-multi-bar')
          if (el) el.remove()
          clearMark()
          chosen = []
          noSelect(false)
        }
        const selected = () => chosen.filter((el) => el.isConnected)
        const marked = (rect) => [...document.querySelectorAll('.km-s')].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom
        })
        const paint = (rect) => {
          clearMark()
          chosen = marked(rect)
          chosen.forEach((el) => el.classList.add('km-multi'))
        }
        async function run(merge) {
          const picked = selected()
          const items = picked.filter((el) => !el.classList.contains('picked')).map((el) => ({
            messageId: el.dataset.kmMsg, index: Number(el.dataset.kmIdx), text: el.dataset.kmText,
            turn: el.dataset.kmTurn === undefined ? null : Number(el.dataset.kmTurn),
            speaker: el.dataset.kmSpeaker || 'assistant',
          }))
          if (!items.length) { toast('框里的句子都已经入库了'); return closeBar() }
          const skipped = picked.length - items.length
          document.querySelectorAll('.km-multi-bar button').forEach((b) => { b.disabled = true })
          toast(items.length > 1 ? `正在把 ${items.length} 句写进知识图…` : '正在写进知识图…')
          try {
            const r = await fetch('/plugins/known-manage/pick-many', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: currentSession(), items, merge }) })
            if (r.status === 404) throw new Error('dsh 里还是旧的插件（重启 dsh 后这句才能用）')
            const out = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
            if (!out.ok) throw new Error(out.error)
            bus.set({ pickedVersion: bus.pickedVersion + 1 })
            bus.post({ type: 'refresh', card: merge ? out.merged : out.cards[out.cards.length - 1] })
            const tail = skipped ? `（${skipped} 句已入库，跳过）` : ''
            toast(merge ? `${out.count} 句合成了一张卡：${out.title}` : `${out.count} 句各成了一张卡${tail}`)
          } catch (err) { toast('没挂上：' + err.message) }
          closeBar()
        }
        const showBar = (n) => {
          const old = document.querySelector('.km-multi-bar')
          if (old) old.remove()
          const el = document.createElement('div')
          el.className = 'km-multi-bar'
          const title = document.createElement('b')
          title.textContent = `选了 ${n} 句`
          el.appendChild(title)
          const add = (label, hint, fn) => {
            const b = document.createElement('button')
            b.textContent = label; b.title = hint; b.onclick = fn
            el.appendChild(b)
            return b
          }
          // 框选出来的一段话就是一张卡：多选不是「多张卡」，是这一块知识。
          add('合成一张卡', '框住的句子合成一张卡，正文按顺序连起来，每句的出处都留着', () => run(true))
          add('取消', '清空选择（Esc 也行）', closeBar)
          document.body.appendChild(el)
        }
        const rectOf = (a, b) => ({ left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
                                    top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) })
        const draw = (ev) => {
          const r = rectOf(from, { x: ev.clientX, y: ev.clientY })
          box.style.left = r.left + 'px'; box.style.top = r.top + 'px'
          box.style.width = (r.right - r.left) + 'px'; box.style.height = (r.bottom - r.top) + 'px'
          paint(r)
        }
        const onDown = (e) => {
          if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return
          const flow = document.querySelector('[data-chat-flow]')
          if (!flow || !flow.contains(e.target)) return
          closeBar()
          const start = { x: e.clientX, y: e.clientY }
          from = start
          moved = false
          const move = (ev) => {
            if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return
            if (!moved) {
              moved = true
              noSelect(true)
              box = document.createElement('div')
              box.className = 'km-marquee'
              document.body.appendChild(box)
            }
            draw(ev)
          }
          const up = (ev) => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', up, true)
            noSelect(false)
            if (box) { box.remove(); box = null }
            from = null
            if (!moved) return                      // a plain Ctrl-click keeps its own meaning
            // The release is a box selection, not a click on the sentence under it.
            const swallow = (ev2) => { ev2.stopPropagation(); ev2.preventDefault() }
            document.addEventListener('click', swallow, true)
            setTimeout(() => document.removeEventListener('click', swallow, true), 300)
            paint(rectOf(start, { x: ev.clientX, y: ev.clientY }))
            const n = selected().length
            if (!n) return toast('框里没有句子（按住 Ctrl 在对话上拖一个框试试）')
            showBar(n)
          }
          document.addEventListener('pointermove', move)
          document.addEventListener('pointerup', up, true)
        }
        const onKey = (e) => { if (e.key === 'Escape') closeBar() }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        bus.listeners.add(closeBar)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
          bus.listeners.delete(closeBar)
          closeBar()
        }
      }, 'known-manage:sentence-marquee')

      // The graph asks to see where something was said.
      ctx.effect(() => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const clean = (s) => String(s || '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()
        // The exact sentence first, the whole message it was said in second.
        const find = (d) => {
          const all = Array.from(document.querySelectorAll('[data-km-msg="' + d.message + '"]'))
          if (!all.length) return null
          const sent = all.filter((el) => el.classList.contains('km-s'))
          const wanted = clean(d.text)
          return sent.find((el) => clean(el.textContent) === wanted)
            || sent.find((el) => wanted && wanted.includes(clean(el.textContent)))
            || sent.find((el) => !wanted && el.dataset.kmIdx === String(d.index))
            || all.find((el) => !el.classList.contains('km-s'))
            || sent[0] || all[0]
        }
        const midOff = (el) => {
          const r = el.getBoundingClientRect()
          return Math.abs(r.top + r.height / 2 - window.innerHeight / 2)
        }
        // dsh lands on the turn itself once its chunk is in, and that landing can
        // push our row away again. Keep putting it back in the middle until it
        // stays there, then flash it — a highlight nobody can see is no jump.
        const settle = async (d, el) => {
          for (let n = 0; n < 6; n++) {
            el.scrollIntoView({ block: 'center', behavior: 'auto' })
            await sleep(220)
            el = find(d) || el
            if (midOff(el) < window.innerHeight * 0.55) break
          }
          el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
          return el
        }
        const waitFor = async (d, tries, step) => {
          for (let n = 0; n < tries; n++) {
            const el = find(d)
            if (el) return el
            await sleep(step)
          }
          return null
        }
        // dsh's chat keeps only a window of the conversation in the DOM and pages
        // the rest in on demand. Its rail of turns is therefore the way back to a
        // sentence of an old turn from outside: the mark carries the turn number
        // in its accessible name, and clicking it is dsh's own jump.
        const turnMark = (turn) => {
          if (!Number.isFinite(turn)) return null
          const zh = new RegExp('第\\s*' + turn + '\\s*轮')
          const en = new RegExp('\\bturn\\s+' + turn + '\\b', 'i')
          return [...document.querySelectorAll('button[aria-label]')].find((b) => {
            const label = b.getAttribute('aria-label') || ''
            if (!/轮|turn/i.test(label)) return false
            return zh.test(label) || en.test(label)
          }) || null
        }
        // A card kept from before the turn was recorded still finds its way home:
        // pull older chunks in until the message shows up.
        const loadEarlier = () => [...document.querySelectorAll('button')]
          .find((b) => /^(加载更早|Load earlier)$/.test((b.textContent || '').trim()) && !b.disabled) || null
        const onMessage = async (e) => {
          const d = e.data
          if (!d || d.source !== 'km-app') return
          if (d.type === 'picked-changed') {
            bus.set({ pickedVersion: bus.pickedVersion + 1 })
            return
          }
          if (d.type === 'insert') { insertIntoComposer(d.text); return }
          if (d.type !== 'goto') return
          const s = sessions()
          // The card may have been made in another conversation: open it first.
          if (d.session && s && s.list.getSnapshot().current !== d.session && typeof s.open === 'function') {
            s.open(d.session)
            toast('正在打开这句话所在的会话…')
            for (let n = 0; n < 40; n++) {
              await sleep(150)
              if (s.list.getSnapshot().current === d.session) break
            }
          }
          let el = await waitFor(d, 10, 150)
          if (!el) {
            const mark = turnMark(Number(d.turn))
            if (mark) {
              mark.click();      // this pages the turn in and lands on it
              toast('这句话在更早的位置，正在加载那一轮…')
              await sleep(1200)  // let dsh's own jump land before we take over
              el = await waitFor(d, 90, 150)
            } else {
              toast('这句话在更早的位置，正在往前加载…')
              for (let n = 0; n < 12 && !el; n++) {
                const more = loadEarlier()
                if (!more) break
                more.click()
                el = await waitFor(d, 12, 150)
              }
            }
          }
          if (el) {
            await settle(d, el)
            toast('已定位到原文')
            return
          }
          toast('原文那段没找到（会话可能已删除，或那一轮还没有加载出来）')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'known-manage:goto')

      const store = sessions().list
      const Overlay = makeOverlay(store)
      // The shared right column, when this harness has one: the graph becomes a
      // tab there and the floating panel below stands down. The declaration is
      // dsh-plugin-rightbar's, so this is a no-op without it.
      slots.inject(TAB_SLOT, () => {
        bus.set({ hosted: true })
        // order 5: the graph is this product's surface, so it is the tab the
        // shared column opens on; 轨迹 (10) and 媒体 stay one click away.
        const seat = slots.register({ name: TAB_SLOT, id: TAB_ID, label: '知识图', order: 5 }, makeTab(store))
        return () => { seat(); bus.set({ hosted: false }) }
      })
      slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'known-manage', order: 50 }, () => h(Overlay)))
      slots.inject('conversation.chat.node', () => slots.register(
        { name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat', priority: -1 }, makeAssistant(currentSession)))
      for (const key of ['user', 'steering']) slots.inject('conversation.chat.node', () => slots.register(
        { name: 'conversation.chat.node', key, locale: 'chat', priority: -1 }, makeUser(currentSession)))
    }

    module.exports = { name: 'known-manage', inject: ['slots', 'sessions'], apply }
    return module.exports
  },
})
