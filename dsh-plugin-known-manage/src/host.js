// dsh-plugin-known-manage — Host half.
//
// Runs in the dsh (Cordis) process at boot. Three jobs:
//   1. keep the known_manage server (Python, FastNode storage) running and say
//      where it is (/plugins/known-manage/status);
//   2. read a dsh session from disk and send its raw Markdown to that server
//      (/plugins/known-manage/ingest). Raw, not rendered: formulas arrive as
//      the $…$ / \( \) source the model wrote, code blocks keep their fences;
//   3. tell the sidebar which folder the conversation works in, so "import a
//      folder" can default to the current repository (/plugins/known-manage/session).
//
// Session files are ~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd:
// newline-delimited events written as many concatenated zstd frames, so every
// frame is decoded and the text joined before splitting into lines.

const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const INJECTED = /<(system-reminder|available_skills|skill_content|compacted-summary|ide_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>/g
const READY_TRIES = 40
const READY_INTERVAL_MS = 300

// --- dsh sessions --------------------------------------------------------

function findSession(sessionsDir, sessionId) {
  const id = String(sessionId || '')
  if (!/^[\w.-]+$/.test(id)) throw new Error('会话 id 不对：' + id)
  for (const ws of fs.readdirSync(sessionsDir)) {
    for (const name of [id, 'session-' + id]) {
      const f = path.join(sessionsDir, ws, name, 'session.jsonl.zstd')
      if (fs.existsSync(f)) return f
    }
  }
  throw new Error('在 ' + sessionsDir + ' 里找不到会话 ' + id)
}

function readEvents(file) {
  const buf = fs.readFileSync(file)
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('这个 Node 不支持 zstd（需要 22.15+）')
  const starts = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 4)) starts.push(i)
  let text = ''
  for (let k = 0; k < starts.length; k++) {
    try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8') }
    catch (e) { /* the magic bytes can also occur inside a frame; such a slice is not a frame */ }
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch (e) { /* partial trailing line while the session is being written */ }
  }
  return out
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
  .map((b) => b.text).join('\n\n').trim()

// Turns as [{ user, assistant: [{id, text}] }] in order. Only what was
// said: reasoning, tool calls and tool output are left out.
function turns(events) {
  const list = []
  const seen = new Map()
  for (const e of events) {
    if (e.type === 'user/message') {
      // dsh also writes its own context as "user" messages (workspace
      // instructions, runtime snapshots, skill catalogs, compaction
      // summaries), marked by source.kind. Only what a person typed counts,
      // and harness context must not open a turn of its own.
      const kind = e.data && e.data.source && e.data.source.kind
      if (kind && kind !== 'user') continue
      const said = textOf(e.data && e.data.content).replace(INJECTED, '').trim()
      if (!said) continue
      list.push({ user: said, assistant: [] })
    } else if (e.type === 'assistant/message') {
      const m = e.data && e.data.message
      if (!m) continue
      const text = textOf(m.content)
      if (!list.length) list.push({ user: '', assistant: [] })
      if (seen.has(m.id)) { seen.get(m.id).text = text; continue }
      const entry = { id: m.id, text }
      seen.set(m.id, entry)
      list[list.length - 1].assistant.push(entry)
    }
  }
  return list
}

function sessionInfo(events) {
  const head = events.find((e) => e.type === 'session') || {}
  const titled = events.filter((e) => e.type === 'session/title').pop()
  return { cwd: head.cwd || '', title: (titled && titled.data && titled.data.title) || '' }
}

function messagesFor(sessionsDir, sessionId, messageId, scope) {
  const events = readEvents(findSession(sessionsDir, sessionId))
  const info = sessionInfo(events)
  const all = turns(events)
  let picked = all
  if (scope !== 'session') {
    const hit = all.find((t) => t.assistant.some((a) => a.id === messageId))
    if (!hit) throw new Error('会话里没找到这条回答（可能还没写盘，稍等再试）')
    picked = [hit]
  }
  const messages = []
  for (const t of picked) {
    if (t.user) messages.push({ speaker: 'user', text: t.user })
    const said = t.assistant.map((a) => a.text).filter(Boolean).join('\n\n')
    if (said) messages.push({ speaker: 'assistant', text: said })
  }
  if (!messages.length) throw new Error('这里没有可入库的文字')
  const first = (picked[0] && picked[0].user) || info.title || '对话'
  const title = (scope === 'session' ? '会话：' + (info.title || first) : first).replace(/\s+/g, ' ').slice(0, 60)
  return { messages, title, cwd: info.cwd }
}

module.exports = {
  name: 'known-manage',
  inject: ['timer', 'webServer'],
  apply(ctx, config) {
    config = config || {}
    // The plugin directory sits inside the known_manage checkout; the profile
    // links to it, and Node resolves the link, so __dirname is the real path.
    const root = config.workspace || process.env.KM_HOME || path.resolve(__dirname, '..', '..')
    const sessionsDir = config.sessions || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
    const basePort = Number(config.port) || 8795
    const state = { child: null, port: 0, error: '', log: [] }

    const note = (t) => { state.log.push(String(t).slice(0, 300)); while (state.log.length > 40) state.log.shift() }
    const alive = () => {
      const c = state.child
      if (!c || c.exitCode !== null || c.signalCode !== null) return false
      try { process.kill(c.pid, 0); return true } catch (e) { return false }
    }

    function python() {
      const tries = [config.python, process.env.KM_PYTHON, path.join(root, '.venv', 'bin', 'python')].filter(Boolean)
      for (const p of tries) { try { if (fs.existsSync(p)) return p } catch (e) {} }
      return 'python3.11'
    }

    // The page carries <meta name="km-app">, so a stray server on the port is
    // never mistaken for ours.
    function probe(port) {
      return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 900 }, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { if (body.length < 4000) body += c })
          res.on('end', () => resolve(res.statusCode === 200 && body.includes('known-manage')))
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => { req.destroy(); resolve(false) })
      })
    }

    function stop() {
      const c = state.child
      state.child = null
      if (!c) return
      try { c.kill('SIGTERM') } catch (e) {}
      setTimeout(() => { try { c.kill('SIGKILL') } catch (e) {} }, 1500)
    }

    async function start() {
      if (alive() && await probe(state.port)) return
      state.child = null
      state.error = ''
      for (let i = 0; i < 8; i++) {
        const port = basePort + i
        if (await probe(port)) { state.port = port; note('复用已在运行的知识库 :' + port); return }
        let child
        try {
          child = spawn(python(), ['-m', 'km', '--port', String(port)], {
            cwd: root, env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (e) { state.error = '启动失败：' + e.message; return }
        child.stdout.on('data', (b) => note(String(b).trim()))
        child.stderr.on('data', (b) => note(String(b).trim()))
        child.on('error', (e) => { state.error = '启动失败：' + e.message })
        state.child = child
        state.port = port
        for (let n = 0; n < READY_TRIES; n++) {
          if (child.exitCode !== null) break
          if (await probe(port)) { note('知识库已启动 :' + port); return }
          await new Promise((r) => setTimeout(r, READY_INTERVAL_MS))
        }
        stop()
        state.error = '知识库没起来（端口 ' + port + '）：' + (state.log[state.log.length - 1] || '没有输出')
      }
    }

    function kmPost(p, body) {
      return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body))
        const req = http.request({ host: '127.0.0.1', port: state.port, path: p, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 60000 }, (res) => {
          let out = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { out += c })
          res.on('end', () => {
            let parsed
            try { parsed = JSON.parse(out) } catch (e) { return reject(new Error('知识库返回的不是 JSON')) }
            res.statusCode === 200 ? resolve(parsed) : reject(new Error(parsed.error || ('HTTP ' + res.statusCode)))
          })
        })
        req.on('error', reject)
        req.end(data)
      })
    }

    // --- routes ---------------------------------------------------------------

    const send = (res, code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const readBody = (req) => new Promise((resolve) => {
      let s = ''
      req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy() })
      req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch (e) { resolve({}) } })
    })

    const server = ctx.get('webServer')
    if (server && typeof server.register === 'function') {
      ctx.effect(() => server.register({
        kind: 'exact', path: '/plugins/known-manage/status',
        handler: (req, res) => send(res, 200, {
          running: alive(), port: state.port, url: state.port ? 'http://127.0.0.1:' + state.port + '/' : '',
          error: state.error, log: state.log.slice(-6), root,
        }),
      }), 'known-manage:status')

      ctx.effect(() => server.register({
        kind: 'exact', path: '/plugins/known-manage/ingest',
        handler: async (req, res) => {
          try {
            const body = await readBody(req)
            if (!state.port) await start()
            const m = messagesFor(sessionsDir, body.sessionId, body.messageId, body.scope)
            const made = await kmPost('/api/sources', { messages: m.messages, title: m.title, format: 'dsh' })
            const src = made.sources[0]
            send(res, 200, { ok: true, source: src.id, units: src.units, title: src.title, cwd: m.cwd })
          } catch (e) {
            send(res, 400, { ok: false, error: String(e && e.message || e) })
          }
        },
      }), 'known-manage:ingest')

      ctx.effect(() => server.register({
        kind: 'exact', path: '/plugins/known-manage/session',
        handler: (req, res) => {
          try {
            const id = new URL(req.url, 'http://x').searchParams.get('id')
            send(res, 200, sessionInfo(readEvents(findSession(sessionsDir, id))))
          } catch (e) {
            send(res, 400, { error: String(e && e.message || e) })
          }
        },
      }), 'known-manage:session')
    }

    ctx.effect(() => () => stop(), 'known-manage:server')
    void start()
    ctx.interval(() => { if (!alive()) void probe(state.port).then((ok) => { if (!ok) void start() }) }, 15000)

  },
}

module.exports.helpers = { readEvents, turns, messagesFor, sessionInfo, findSession }
