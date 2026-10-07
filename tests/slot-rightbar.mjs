// Does the knowledge graph join the shared right column instead of pinning its
// own panel? Runs the real SlotCore and the plugin's src/client.js in a vm,
// with dsh-plugin-rightbar's declaration present and absent.
//
//   node --import tsx/esm known_manage/tests/slot-rightbar.mjs
//
// DSH_REPO defaults to the deepseek-harness checkout next to this project.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'dsh-plugin-known-manage')
const DSH = process.env.DSH_REPO || '../deepseek-harness'
const { SlotCore } = await import(path.join(DSH, 'packages/client/ui-slots/src/index.ts'))

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log('ok   ' + name) } catch (error) { failed += 1; console.log('FAIL ' + name + ' — ' + error.message) }
}

/** The minimal equivalent of ctx.slots: register/entries/subscribe direct to SlotCore, inject waits for the declaration. */
function slotsOver(core) {
  const injected = new Map()
  const run = (callback) => {
    const result = callback()
    const disposers = typeof result === 'function' ? [result] : [...result]
    return () => disposers.reverse().forEach((d) => d())
  }
  return {
    register: (options, component) => core.register(options, component),
    entries: (key) => core.entries(key),
    subscribe: (key, fn) => core.subscribe(key, fn),
    inject(key, callback) {
      const state = { active: undefined, epoch: undefined }
      const reconcile = () => {
        const epoch = core.declarationEpoch(key)
        if (state.active !== undefined && state.epoch === epoch) return
        state.active?.()
        state.active = undefined
        if (core.specDynamic(key) === undefined) return
        state.active = run(callback)
        state.epoch = epoch
      }
      core.subscribeDeclaration(key, reconcile)
      reconcile()
      const list = injected.get(key) ?? []
      list.push(state)
      injected.set(key, list)
      return () => { state.active?.(); state.active = undefined }
    },
    /** 测试用：撤掉某个 key 上最后一次 inject 注册的东西（模拟插件卸载）。 */
    drop(key) { const list = injected.get(key); const s = list?.[list.length - 1]; s.active?.(); s.active = undefined },
  }
}

/** Run src/client.js in a vm and hand back the plugin object it exports. */
function loadPlugin() {
  const factories = new Map()
  const React = { createElement: (...args) => ({ args }), useState: () => [undefined, () => {}], useEffect: () => {}, useRef: () => ({}), useCallback: (f) => f, useSyncExternalStore: () => ({}) }
  const context = {
    window: {
      __ModuleLoader__: { load: (r) => factories.set(r.id, r.factory) },
      localStorage: { getItem: () => null, setItem() {} },
      innerWidth: 1600, parent: {}, addEventListener() {}, removeEventListener() {},
      getComputedStyle: () => ({ cursor: '', getPropertyValue: () => '' }),
    },
    // The plugin reads the frame and the sidebar handles at apply time. A browser
    // always has these APIs, so the stub provides them as well — they simply find
    // nothing here.
    document: {
      documentElement: { style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' } },
      createElement: () => ({ dataset: {}, style: {}, remove() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }),
      head: { appendChild() {} },
      body: { appendChild() {}, querySelectorAll: () => [] },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      elementFromPoint: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: () => Promise.reject(new Error('no network in this harness')),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    JSON, Math, encodeURIComponent, Number, Object, Array,
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(PLUGIN, 'src', 'client.js'), 'utf8'), context)
  return factories.get('dsh-plugin-known-manage')((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null }
    throw new Error('unexpected require ' + id)
  })
}

const SESSIONS = { list: { getSnapshot: () => ({ current: '', byId: {} }), subscribe: () => () => {} } }
const ctxOver = (slots) => ({ get: (name) => (name === 'slots' ? slots : name === 'sessions' ? SESSIONS : undefined), effect: (fn) => fn() })
const ids = (core, key) => core.entries(key).map((e) => e.options.id)

// --- with the shared right column -----------------------------------------
{
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, () => null)
  const slots = slotsOver(core)
  // rightbar's own client half: it declares rightbar.tab under shell.overlay.
  const undeclareRightbar = slots.inject('shell.overlay', () => core.register(
    { name: 'shell.overlay', id: 'rightbar', children: { 'rightbar.tab': { kind: 'list', scope: 'root' } } }, () => null))

  const plugin = loadPlugin()
  plugin.apply(ctxOver(slots))

  check('共享右栏存在时：知识图注册成 rightbar.tab 的一个标签', () => {
    assert.ok(ids(core, 'rightbar.tab').includes('known-manage'), '没有注册：' + JSON.stringify(ids(core, 'rightbar.tab')))
    const entry = core.entries('rightbar.tab').find((e) => e.options.id === 'known-manage')
    assert.strictEqual(entry.options.label, '知识图')
  })

  check('知识图排在最前：右栏默认打开的就是白板', () => {
    const entries = core.entries('rightbar.tab')
    assert.strictEqual(entries[0].options.id, 'known-manage', '排序第一的不是知识图：' + JSON.stringify(ids(core, 'rightbar.tab')))
    assert.strictEqual(entries[0].options.order, 5)
  })

  check('向后兼容：浮动面板的座位仍然注册（右栏收起时它才让位）', () => {
    assert.ok(ids(core, 'shell.overlay').includes('known-manage'), JSON.stringify(ids(core, 'shell.overlay')))
  })

  check('右栏卸载：标签座位一起撤掉，不留下悬空注册', () => {
    undeclareRightbar()
    assert.deepStrictEqual(ids(core, 'rightbar.tab'), [])
  })
}

// --- without the shared right column --------------------------------------
{
  const core = new SlotCore()
  core.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, () => null)
  const slots = slotsOver(core)
  const plugin = loadPlugin()
  plugin.apply(ctxOver(slots))

  check('没有右栏时：不注册任何 rightbar.tab（inject 只是等着，不报错）', () => {
    assert.strictEqual(core.specDynamic('rightbar.tab'), undefined)
    assert.deepStrictEqual(ids(core, 'rightbar.tab'), [])
  })

  check('没有右栏时：浮动面板照旧挂在 shell.overlay 上', () => {
    assert.deepStrictEqual(ids(core, 'shell.overlay'), ['known-manage'])
  })

  check('右栏稍后才出现：知识图自己补上标签，插件不用重载', () => {
    slots.inject('shell.overlay', () => core.register(
      { name: 'shell.overlay', id: 'rightbar', children: { 'rightbar.tab': { kind: 'list', scope: 'root' } } }, () => null))
    assert.ok(ids(core, 'rightbar.tab').includes('known-manage'), JSON.stringify(ids(core, 'rightbar.tab')))
  })
}

process.exitCode = failed === 0 ? 0 : 1
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' 项失败')
