// dsh-plugin-known-manage — Client half.
//
// Registered under the PACKAGE name (the bundle route is built from it). Four
// seats, all additive — nothing dsh ships is replaced:
//   shell.overlay                         the right-hand sidebar holding the
//                                         knowledge base (an iframe of the
//                                         known_manage app in its narrow mode)
//   sidebar.footer.action                 a 「知识库」 button that opens/closes it
//   conversation.chat.assistant-actions   「入库」 under every answer: that turn
//                                         (question + answer) goes into the
//                                         current repository, raw Markdown
//   conversation.session.header.utilities 「整段入库」: the whole session
//
// The details column on the right is dsh's tool-details seat; taking it would
// remove tool details, so the sidebar floats in shell.overlay instead. Other
// plugins float panels there too (one sits at z-index 500 on the right edge),
// so the sidebar and its tab stack above them while open.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-known-manage',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const CSS = [
      '.km-panel{position:fixed;top:0;right:0;bottom:0;z-index:520;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);',
      'border-left:1px solid var(--dsw-alias-border-secondary,#e5e7eb);box-shadow:-8px 0 24px rgba(0,0,0,.08);',
      'pointer-events:auto;font-family:var(--dsw-font-family,inherit);transition:width .18s ease}',
      '.km-head{display:flex;align-items:center;gap:6px;padding:7px 10px;flex:0 0 auto;',
      'border-bottom:1px solid var(--dsw-alias-border-secondary,#e5e7eb);font-size:13px}',
      '.km-head b{flex:1;font-weight:600}',
      '.km-head .km-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}',
      '.km-head .km-dot.on{background:#22c55e}.km-head .km-dot.bad{background:#ef4444}',
      '.km-btn{border:1px solid var(--dsw-alias-border-secondary,#d1d5db);background:transparent;color:inherit;',
      'border-radius:6px;padding:2px 9px;font:12px var(--dsw-font-family,inherit);cursor:pointer}',
      '.km-btn:hover{background:rgba(127,127,127,.12)}',
      '.km-frame{flex:1;min-height:0;border:0;width:100%;background:#fff}',
      '.km-hint{padding:16px;font-size:12.5px;line-height:1.8;opacity:.8;white-space:pre-wrap}',
      '.km-hint code{background:rgba(127,127,127,.16);border-radius:3px;padding:1px 5px;font:11.5px ui-monospace,monospace}',
      '.km-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:510;pointer-events:auto;',
      'writing-mode:vertical-rl;padding:12px 6px;border-radius:8px 0 0 8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-secondary,#d1d5db);border-right:0;',
      'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);',
      'font:12.5px var(--dsw-font-family,inherit);letter-spacing:.15em;box-shadow:-2px 0 8px rgba(0,0,0,.06)}',
      '.km-tab:hover{color:#2f5bd3}',
      '.km-toast{position:fixed;right:24px;bottom:24px;z-index:530;pointer-events:auto;max-width:340px;',
      'background:#111827;color:#fff;border-radius:8px;padding:8px 12px;font-size:12.5px;line-height:1.5}',
      '.km-act{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;',
      'font:12px var(--dsw-font-family,inherit);padding:2px 6px;border-radius:5px;display:inline-flex;align-items:center;gap:3px}',
      '.km-act:hover{background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,#111)}',
      '.km-act[disabled]{opacity:.5;cursor:default}',
      '.km-foot{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:inherit;',
      'cursor:pointer;padding:6px 8px;border-radius:8px;font:13px var(--dsw-font-family,inherit)}',
      '.km-foot:hover{background:rgba(127,127,127,.12)}',
    ].join('')

    // One shared state for the four seats; React components subscribe to it.
    const bus = {
      open: false, wide: false, cwd: '', pending: null, toast: '', listeners: new Set(),
      set(patch) { Object.assign(bus, patch); bus.listeners.forEach((f) => f()) },
    }
    try {
      const saved = JSON.parse(localStorage.getItem('km-sidebar') || '{}')
      bus.open = !!saved.open; bus.wide = !!saved.wide
    } catch (e) {}
    const persist = () => { try { localStorage.setItem('km-sidebar', JSON.stringify({ open: bus.open, wide: bus.wide })) } catch (e) {} }
    function useBus() {
      const [, tick] = React.useState(0)
      React.useEffect(() => { const f = () => tick((n) => n + 1); bus.listeners.add(f); return () => bus.listeners.delete(f) }, [])
      return bus
    }
    function toast(text) {
      bus.set({ toast: text })
      clearTimeout(toast.t)
      toast.t = setTimeout(() => bus.set({ toast: '' }), 3200)
    }

    async function ingest(sessionId, messageId, scope) {
      const r = await fetch('/plugins/known-manage/ingest', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId, scope }),
      })
      const out = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
      if (!out.ok) throw new Error(out.error || '入库失败')
      bus.set({ open: true, pending: { id: out.source, note: '拆成了 ' + out.units + ' 句，挑有用的留下' }, cwd: out.cwd || bus.cwd })
      persist()
      return out
    }

    // --- the sidebar ---------------------------------------------------------
    function Sidebar() {
      const b = useBus()
      const [status, setStatus] = React.useState({ url: '', error: '' })
      const [loaded, setLoaded] = React.useState(false)
      const frame = React.useRef(null)

      React.useEffect(() => {
        let live = true
        const poll = async () => {
          try {
            const s = await (await fetch('/plugins/known-manage/status', { cache: 'no-store' })).json()
            if (live) setStatus((old) => (old.url === s.url && old.error === s.error ? old : s))
          } catch (e) { if (live) setStatus((o) => ({ ...o, error: '拿不到知识库状态：' + e.message })) }
        }
        poll()
        const id = setInterval(poll, 5000)
        return () => { live = false; clearInterval(id) }
      }, [])

      // Hand the iframe whatever it should show now: a freshly ingested source,
      // the conversation's folder for "import a folder".
      React.useEffect(() => {
        const w = frame.current && frame.current.contentWindow
        if (!loaded || !w) return
        w.postMessage({ source: 'km-host', type: 'layout', wide: b.wide }, '*')
        if (b.cwd) w.postMessage({ source: 'km-host', type: 'cwd', cwd: b.cwd }, '*')
        if (b.pending) {
          w.postMessage({ source: 'km-host', type: 'open-source', id: b.pending.id, note: b.pending.note }, '*')
          bus.pending = null
        }
      })

      if (!b.open) {
        return h('button', { className: 'km-tab', title: '打开知识库', onClick: () => { bus.set({ open: true }); persist() } }, '知识库')
      }
      const width = b.wide ? 'min(78vw, 1200px)' : '440px'
      const src = status.url ? status.url + '?mode=side' + (b.cwd ? '&cwd=' + encodeURIComponent(b.cwd) : '') : ''
      const dot = 'km-dot' + (loaded ? ' on' : status.error ? ' bad' : '')
      return h('div', { className: 'km-panel', style: { width } },
        h('div', { className: 'km-head' },
          h('span', { className: dot }),
          h('b', null, '知识库'),
          h('button', { className: 'km-btn', title: b.wide ? '变窄' : '加宽（看层级图、白板）',
            onClick: () => { bus.set({ wide: !b.wide }); persist() } }, b.wide ? '变窄' : '加宽'),
          status.url ? h('button', { className: 'km-btn', title: '在新标签页打开完整界面',
            onClick: () => window.open(status.url, '_blank') }, '新窗口') : null,
          h('button', { className: 'km-btn', title: '收起', onClick: () => { bus.set({ open: false }); persist() } }, '×')),
        src
          ? h('iframe', { className: 'km-frame', ref: frame, src, key: status.url, onLoad: () => setLoaded(true) })
          : h('div', { className: 'km-hint' },
              status.error || '知识库正在启动…',
              '\n\n手动启动：', h('code', null, 'cd known_manage && .venv/bin/python -m km --port 8795')))
    }

    function Toast() {
      const b = useBus()
      return b.toast ? h('div', { className: 'km-toast' }, b.toast) : null
    }

    function Overlay() {
      return h(React.Fragment, null, h(Sidebar), h(Toast))
    }

    // --- 「知识库」 at the sidebar foot ------------------------------------------
    function FooterAction(props) {
      const b = useBus()
      const wide = !props || props.wide !== false
      return h('button', { className: 'km-foot', title: '知识库（拆分、筛选、卡片、层级图）',
        onClick: () => { bus.set({ open: !b.open }); persist() } },
        h('span', { style: { fontSize: '15px' } }, '◫'), wide ? h('span', null, b.open ? '收起知识库' : '知识库') : null)
    }

    // --- 「入库」 under an answer -------------------------------------------------
    function IngestAction(props) {
      const [busy, setBusy] = React.useState(false)
      const sessionId = props.kmSession
      if (!sessionId || !props.messageId) return null
      return h('button', {
        className: 'km-act', disabled: busy, title: '把这一轮（你的问题 + 这段回答）放进知识库，拆成句子让你挑',
        onClick: async () => {
          setBusy(true)
          try { const r = await ingest(sessionId, props.messageId, 'turn'); toast('已入库：' + r.units + ' 句 →「' + r.title + '」') }
          catch (e) { toast('没入成：' + e.message) }
          finally { setBusy(false) }
        },
      }, busy ? '入库中…' : '⊕ 入库')
    }

    // --- 「整段入库」 in the session header ----------------------------------------
    function SessionIngest(props) {
      const [busy, setBusy] = React.useState(false)
      const sessionId = props.kmSession
      React.useEffect(() => {
        // Let the sidebar default "import a folder" to this conversation's repository.
        if (!sessionId) return
        fetch('/plugins/known-manage/session?id=' + encodeURIComponent(sessionId))
          .then((r) => r.json()).then((s) => { if (s.cwd) bus.set({ cwd: s.cwd }) }).catch(() => {})
      }, [sessionId])
      if (!sessionId) return null
      return h('button', {
        className: 'km-act', disabled: busy, title: '把整段会话放进知识库',
        onClick: async () => {
          setBusy(true)
          try { const r = await ingest(sessionId, null, 'session'); toast('整段入库：' + r.units + ' 句') }
          catch (e) { toast('没入成：' + e.message) }
          finally { setBusy(false) }
        },
      }, busy ? '入库中…' : '⊕ 整段入库')
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-known-manage'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'known-manage:styles')

      const withSession = (sessionId) => ({ kmSession: sessionId })

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'known-manage', order: 50 }, () => h(Overlay)))
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'known-manage', order: 50 }, (p) => h(FooterAction, p)))
      slots.inject('conversation.chat.assistant-actions', () => slots.register(
        { name: 'conversation.chat.assistant-actions', id: 'known-manage', order: 40, inject: withSession },
        (p) => h(IngestAction, p)))
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'known-manage', order: 40, inject: withSession },
        (p) => h(SessionIngest, p)))
    }

    module.exports = { name: 'known-manage', inject: ['slots'], apply }
    return module.exports
  },
})
