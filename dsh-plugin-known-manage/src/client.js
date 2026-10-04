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
//   conversation.chat.assistant-actions       「⊕ 整段入库」 for one answer, and
//   conversation.session.header.utilities     「⊕ 整段入库」 for the session: the
//       text lands in the graph's source column, still pickable.
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

    const CSS = [
      ':root{--km-w:46vw}',
      // dsh's frame makes room: the panel sits beside the chat, not on top of it.
      '#root{width:calc(100vw - var(--km-w)) !important;min-width:0}',
      '.km-panel{position:fixed;top:0;right:0;bottom:0;width:var(--km-w);z-index:520;display:flex;flex-direction:column;',
      'background:#fbfaf8;border-left:1px solid var(--dsw-alias-border-secondary,#e5e7eb);pointer-events:auto}',
      '.km-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2}',
      '.km-grip:hover,.km-grip.on{background:rgba(47,91,211,.25)}',
      '.km-frame{flex:1;min-height:0;border:0;width:100%;background:#fbfaf8}',
      '.km-hint{padding:16px;font-size:12.5px;line-height:1.8;opacity:.8;white-space:pre-wrap}',
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
      '.km-think{font-size:12.5px;color:var(--dsw-alias-label-secondary,#6b7280);border-left:2px solid #e5e7eb;padding:2px 8px;margin:4px 0;white-space:pre-wrap}',
      '.km-think summary{cursor:pointer}',
      '.km-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:530;pointer-events:none;',
      'background:#111827;color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px}',
      '.km-act{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;',
      'font:12px var(--dsw-font-family,inherit);padding:2px 6px;border-radius:5px}',
      '.km-act:hover{background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,#111)}',
    ].join('')

    // Shared between the seats: the graph frame, a toast, and what was picked.
    const bus = {
      frame: null, toast: '', listeners: new Set(), pickedVersion: 0,
      set(p) { Object.assign(bus, p); bus.listeners.forEach((f) => f()) },
      post(msg) { const w = bus.frame && bus.frame.contentWindow; if (w) w.postMessage(Object.assign({ source: 'km-host' }, msg), '*') },
    }
    function useBus() {
      const [, tick] = React.useState(0)
      React.useEffect(() => { const f = () => tick((n) => n + 1); bus.listeners.add(f); return () => bus.listeners.delete(f) }, [])
      return bus
    }
    function toast(text) { bus.set({ toast: text }); clearTimeout(toast.t); toast.t = setTimeout(() => bus.set({ toast: '' }), 2600) }

    // --- the graph panel -------------------------------------------------------
    function readWidth() {
      try { const w = Number(localStorage.getItem('km-panel-w')); if (w >= MIN_W) return w } catch (e) {}
      return Math.max(MIN_W, Math.round(window.innerWidth * 0.46))
    }
    function applyWidth(w) { document.documentElement.style.setProperty('--km-w', w + 'px') }

    function Panel() {
      const [status, setStatus] = React.useState({ url: '', error: '' })
      const [drag, setDrag] = React.useState(false)
      React.useEffect(() => {
        applyWidth(readWidth())
        let live = true
        const poll = async () => {
          try {
            const s = await (await fetch('/plugins/known-manage/status', { cache: 'no-store' })).json()
            if (live) setStatus((o) => (o.url === s.url && o.error === s.error ? o : s))
          } catch (e) { if (live) setStatus((o) => ({ ...o, error: '拿不到知识库状态：' + e.message })) }
        }
        poll()
        const id = setInterval(poll, 5000)
        return () => { live = false; clearInterval(id) }
      }, [])
      const startResize = (e) => {
        e.preventDefault()
        setDrag(true)
        const move = (ev) => applyWidth(Math.max(MIN_W, Math.min(window.innerWidth - 480, window.innerWidth - ev.clientX)))
        const up = () => {
          setDrag(false)
          document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up)
          try { localStorage.setItem('km-panel-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--km-w')))) } catch (err) {}
        }
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
      }
      return h('div', { className: 'km-panel' + (drag ? ' dragging' : '') },
        h('div', { className: 'km-grip' + (drag ? ' on' : ''), title: '拖动调整宽度', onPointerDown: startResize }),
        status.url
          ? h('iframe', { className: 'km-frame', src: status.url, key: status.url, ref: (el) => { bus.frame = el } })
          : h('div', { className: 'km-hint' }, status.error || '知识库正在启动…'))
    }
    function Toast() { const b = useBus(); return b.toast ? h('div', { className: 'km-toast' }, b.toast) : null }
    function Overlay() { return h(React.Fragment, null, h(Panel), h(Toast)) }

    // --- answers, sentence by sentence ---------------------------------------
    const splitCache = new Map()
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
    function usePicked(messageId) {
      const b = useBus()
      const [state, setState] = React.useState({ picked: {} })
      React.useEffect(() => {
        if (!messageId) return undefined
        let live = true
        fetch('/plugins/known-manage/picked?message=' + encodeURIComponent(messageId)).then((r) => r.json())
          .then((d) => { if (live && d && d.picked) setState(d) }).catch(() => {})
        return () => { live = false }
      }, [messageId, b.pickedVersion])
      return state
    }

    function SentenceBlock({ text, base, messageId, sessionId, picked }) {
      const units = useSentences(text)
      const [busy, setBusy] = React.useState(-1)
      if (!units) return h(MarkdownText, { text, streaming: false, labels: LABELS })
      return h('div', { className: 'km-ans' }, units.map((u, i) => {
        const index = base + i
        const cards = picked[String(index)]
        return h('div', {
          key: i, className: 'km-s' + (cards ? ' picked' : '') + (busy === index ? ' busy' : ''),
          'data-km-msg': messageId, 'data-km-idx': index,
          title: cards ? '已入库：点一下在右边看这张卡' : '点一下：放进右边知识图的挂载点下',
          onClick: async (e) => {
            if (e.target.closest('a, button')) return
            if (cards) { bus.post({ type: 'focus', card: cards[cards.length - 1] }); return }
            setBusy(index)
            try {
              const r = await fetch('/plugins/known-manage/pick', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, messageId, index, text: u.text }) })
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

    // Replaces dsh's assistant renderer. Tool calls are drawn by the chat view
    // itself (not in this node), so only text, reasoning and images live here.
    function makeAssistant(getSession) {
      return function KmAssistant(props) {
        const data = props.node.data
        const streaming = data.status === 'running'
        const messageId = data.finalNode && data.finalNode.messageId
        const sessionId = props.sessionId || getSession()
        const { picked } = usePicked(!streaming ? messageId : '')
        const blocks = data.blocks || []
        if (!streaming && !blocks.some((b) => b.kind !== 'tool-call')) return null
        const out = []
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i]
          if (b.kind === 'text') {
            out.push(streaming || !messageId
              ? h(MarkdownText, { key: i, text: b.text, streaming, labels: LABELS })
              : h(SentenceBlock, { key: i, text: b.text, base: i * 1000, messageId, sessionId, picked }))
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
        return h('div', { style: { minWidth: 0 } }, out)
      }
    }

    // --- 「⊕ 整段入库」 -------------------------------------------------------------
    async function ingest(sessionId, messageId, scope) {
      const r = await fetch('/plugins/known-manage/ingest', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId, scope }) })
      const out = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
      if (!out.ok) throw new Error(out.error || '入库失败')
      bus.post({ type: 'refresh' })
      return out
    }
    function IngestAction(props) {
      const [busy, setBusy] = React.useState(false)
      if (!props.kmSession || !props.messageId) return null
      return h('button', { className: 'km-act', disabled: busy, title: '整段回答放进右边的资料栏，再从里面挑',
        onClick: async () => {
          setBusy(true)
          try { const r = await ingest(props.kmSession, props.messageId, 'turn'); toast('整段入库：' + r.units + ' 句，在右边资料栏') }
          catch (e) { toast('没入成：' + e.message) } finally { setBusy(false) }
        } }, busy ? '入库中…' : '⊕ 整段入库')
    }
    function SessionIngest(props) {
      const [busy, setBusy] = React.useState(false)
      if (!props.kmSession) return null
      return h('button', { className: 'km-act', disabled: busy, title: '整个会话放进右边的资料栏',
        onClick: async () => {
          setBusy(true)
          try { const r = await ingest(props.kmSession, null, 'session'); toast('整个会话入库：' + r.units + ' 句') }
          catch (e) { toast('没入成：' + e.message) } finally { setBusy(false) }
        } }, busy ? '入库中…' : '⊕ 整段入库')
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const sessions = () => ctx.get('sessions')
      const currentSession = () => { const s = sessions(); return s && s.current }

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-known-manage'
        tag.textContent = CSS
        document.head.appendChild(tag)
        applyWidth(readWidth())
        return () => { tag.remove(); document.documentElement.style.removeProperty('--km-w') }
      }, 'known-manage:styles')

      // The graph asks to see where something was said.
      ctx.effect(() => {
        const onMessage = async (e) => {
          const d = e.data
          if (!d || d.source !== 'km-app' || d.type !== 'goto') return
          const s = sessions()
          if (d.session && s && s.current !== d.session && typeof s.open === 'function') s.open(d.session)
          const sel = '.km-s[data-km-msg="' + d.message + '"][data-km-idx="' + d.index + '"]'
          for (let n = 0; n < 40; n++) {
            const el = document.querySelector(sel)
            if (el) {
              el.scrollIntoView({ block: 'center', behavior: 'smooth' })
              el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
              return
            }
            await new Promise((r) => setTimeout(r, 150))
          }
          toast('原文那段没找到（会话可能已删除）')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, 'known-manage:goto')

      const withSession = (sessionId) => ({ kmSession: sessionId })
      slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'known-manage', order: 50 }, () => h(Overlay)))
      slots.inject('conversation.chat.node', () => slots.register(
        { name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat', priority: -1 }, makeAssistant(currentSession)))
      slots.inject('conversation.chat.assistant-actions', () => slots.register(
        { name: 'conversation.chat.assistant-actions', id: 'known-manage', order: 40, inject: withSession }, (p) => h(IngestAction, p)))
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'known-manage', order: 40, inject: withSession }, (p) => h(SessionIngest, p)))
    }

    module.exports = { name: 'known-manage', inject: ['slots'], apply }
    return module.exports
  },
})
