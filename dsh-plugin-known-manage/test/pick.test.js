// node --test dsh-plugin-known-manage/test/pick.test.js
//
// The one hop that only a running system can answer: the client half reads the
// turn a sentence was said in out of the message it draws, and the library has
// to end up with it — that number is what 「跳到原文」 uses to page an old turn
// back into the chat. Here the host half runs for real, against a real
// knowledge server (python -m km) on a scratch folder.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const PY = process.env.KM_PYTHON || 'python3'

function writeSession(dir, id, events) {
  const folder = path.join(dir, '--ws--', id)
  fs.mkdirSync(folder, { recursive: true })
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))
  fs.writeFileSync(path.join(folder, 'session.jsonl.zstd'), Buffer.concat(frames))
}

const json = async (url) => (await fetch(url)).json()

async function waitFor(url, tries = 60) {
  for (let n = 0; n < tries; n++) {
    try { if ((await fetch(url)).ok) return true } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// A Cordis context is only needed for two things here: where routes go, and
// effects that must be undone. Everything else the host half does is HTTP.
function fakeContext(routes) {
  return {
    get: () => ({ register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } }),
    effect: (fn) => { const off = fn(); return off },
    interval: () => () => {},
  }
}

function fakeRes() {
  const out = {}
  return { writeHead: (code) => { out.code = code }, end: (body) => { out.body = JSON.parse(body) }, out }
}

function call(handler, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  const res = fakeRes()
  return handler(req, res).then(() => res.out)
}

// A knowledge server plus the host half, wired together the way dsh wires them.
async function boot(t) {
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), 'km-repos-'))
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'km-sessions-'))
  const port = 24000 + Math.floor(Math.random() * 10000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(PY, ['-m', 'km', '--port', String(port), '--repos', repos], { cwd: ROOT, stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  writeSession(sessions, 'session-abc', [
    { type: 'session', id: 'session-abc', cwd: '/work/repo' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '为什么要除以 $\\sqrt{d_k}$？' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { id: 'm1', role: 'assistant',
      content: [{ type: 'text', text: '先看方差。再看缩放。' }] } } },
  ])
  if (!await waitFor(`${base}/api/version`)) return null
  const routes = new Map()
  require('../src/host.js').apply(fakeContext(routes), { port, workspace: ROOT, sessions })
  await waitFor(`${base}/api/version`)   // start() reuses the server we started
  return { base, routes }
}

const cards = async (base) => Object.values((await json(`${base}/api/canvas?s=session-abc`)).nodes).filter((n) => !n.root)

test('a picked sentence carries the turn it was said in into the library', async (t) => {
  const env = await boot(t)
  if (!env) return t.skip(`起不来知识库服务（${PY} -m km）`)

  const out = await call(env.routes.get('/plugins/known-manage/pick'), {
    sessionId: 'session-abc', messageId: 'm1', index: 0, text: '先看方差。', speaker: 'assistant', turn: 7,
  })
  assert.strictEqual(out.code, 200, JSON.stringify(out.body))
  assert.strictEqual(out.body.ok, true)

  const made = await cards(env.base)
  assert.strictEqual(made.length, 1)
  assert.strictEqual(made[0].origins[0].dsh_turn, 7)
  // and the source of the card reads as the question it answered
  assert.strictEqual(made[0].origins[0].source_title, '为什么要除以 $\\sqrt{d_k}$？')

  // a card picked without a turn stays honest instead of inventing one
  const plain = await call(env.routes.get('/plugins/known-manage/pick'), {
    sessionId: 'session-abc', messageId: 'm1', index: 0, text: '第二句。', speaker: 'assistant',
  })
  assert.strictEqual(plain.code, 200, JSON.stringify(plain.body))
  const second = (await cards(env.base)).map((n) => n.origins[0]).find((o) => o && o.text === '第二句。')
  assert.strictEqual(second.dsh_turn, 7, '同一个消息里已经有轮次了，新句子沿用')
})

test('a box of sentences becomes one card each, or one card holding them all', async (t) => {
  const env = await boot(t)
  if (!env) return t.skip(`起不来知识库服务（${PY} -m km）`)

  const items = [
    { messageId: 'm1', index: 0, text: '先看方差。', speaker: 'assistant', turn: 3 },
    { messageId: 'm1', index: 1, text: '再看缩放。', speaker: 'assistant', turn: 3 },
    { messageId: 'user:8', index: 0, text: '为什么要除以 $\\sqrt{d_k}$？', speaker: 'user', turn: 3 },
  ]

  // 各做一张卡: three sentences, three cards
  const many = await call(env.routes.get('/plugins/known-manage/pick-many'), { sessionId: 'session-abc', items, merge: false })
  assert.strictEqual(many.code, 200, JSON.stringify(many.body))
  assert.deepStrictEqual([many.body.ok, many.body.count, many.body.merged], [true, 3, null])
  assert.strictEqual((await cards(env.base)).length, 3)

  // 合成一张卡: the same three, folded into the first one — body and origins all kept
  const merged = await call(env.routes.get('/plugins/known-manage/pick-many'),
    { sessionId: 'session-abc', items: items.map((it) => ({ ...it, text: it.text + ' x' })), merge: true })
  assert.strictEqual(merged.code, 200, JSON.stringify(merged.body))
  assert.strictEqual(merged.body.merged, merged.body.cards[0])
  const all = await cards(env.base)
  const one = all.find((n) => n.id === merged.body.merged)
  assert.strictEqual(one.origins.length, 3)
  for (const it of items) assert.ok(one.body.includes(it.text), it.text + ' 应该在合成后的正文里')

  // a request with nothing to pick is refused, not silently accepted
  const empty = await call(env.routes.get('/plugins/known-manage/pick-many'), { sessionId: 'session-abc', items: [] })
  assert.strictEqual(empty.code, 400)
  assert.match(empty.body.error, /缺少 sessionId/)
})
