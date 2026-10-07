// node --test dsh-plugin-known-manage/test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { readEvents, turns, sessionInfo, findSession } = require('../src/host.js').helpers

// A session file the way dsh writes it: one zstd frame per append.
function writeSession(dir, id, events) {
  const folder = path.join(dir, '--ws--', id)
  fs.mkdirSync(folder, { recursive: true })
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))
  fs.writeFileSync(path.join(folder, 'session.jsonl.zstd'), Buffer.concat(frames))
}

const user = (text, kind = 'user') => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })
const answer = (id, text, extra = []) => ({ type: 'assistant/message', data: { message: { id, role: 'assistant',
  content: [{ type: 'reasoning', text: 'hidden thoughts' }, ...extra, { type: 'text', text }] } } })

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-dsh-'))
writeSession(dir, 'session-abc', [
  { type: 'session', id: 'session-abc', cwd: '/work/repo' },
  user('<system-reminder>workspace rules</system-reminder>', 'agent-instructions'),
  user('为什么要除以 $\\sqrt{d_k}$？'),
  user('Current runtime context. ...', 'plugin'),
  answer('m1', '先看方差：$\\operatorname{Var}(q\\cdot k)=d_k$。', [{ type: 'tool-call', name: 'bash' }]),
  answer('m2', '```python\natt = q @ k.T / math.sqrt(k.size(-1))\n```'),
  { type: 'session/title', data: { title: '缩放' } },
  user('那 mask 呢？'),
  answer('m3', '$$\\mathrm{softmax}(z)_j = e^{z_j}/\\sum_m e^{z_m}$$'),
])

test('every concatenated zstd frame is read', () => {
  assert.strictEqual(readEvents(findSession(dir, 'session-abc')).length, 9)
  assert.strictEqual(findSession(dir, 'abc'), findSession(dir, 'session-abc'))
})

test('only what a person typed opens a turn; harness context is dropped', () => {
  const t = turns(readEvents(findSession(dir, 'session-abc')))
  assert.deepStrictEqual(t.map((x) => x.user), ['为什么要除以 $\\sqrt{d_k}$？', '那 mask 呢？'])
  assert.deepStrictEqual(t[0].assistant.map((a) => a.id), ['m1', 'm2'])
})

test('turns keep formulas and code fences as written, without reasoning or tool calls', () => {
  const t = turns(readEvents(findSession(dir, 'session-abc')))
  assert.strictEqual(t[0].assistant[0].text, '先看方差：$\\operatorname{Var}(q\\cdot k)=d_k$。')
  assert.strictEqual(t[0].assistant[1].text, '```python\natt = q @ k.T / math.sqrt(k.size(-1))\n```')
  assert.ok(!t[0].assistant[0].text.includes('hidden thoughts'))
})

test('the session header reads as the folder the conversation works in', () => {
  assert.deepStrictEqual(sessionInfo(readEvents(findSession(dir, 'session-abc'))),
    { cwd: '/work/repo', title: '缩放' })
})

test('bad ids are refused, not searched for', () => {
  assert.throws(() => findSession(dir, '../etc'), /会话 id 不对/)
})

test('whole-段 ingest is gone: no helper and no route stay behind', () => {
  const mod = require('../src/host.js')
  assert.strictEqual(mod.helpers.messagesFor, undefined)
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'src', 'host.js'), 'utf8').includes('/plugins/known-manage/ingest'))
})
