/**
 * Client-half logic tests for the context-handoff companion module.
 *
 * The browser bundle is a plain script that calls
 * `window.__ModuleLoader__.load({ id, factory })`. This test provides a fake
 * window, captures the module definition, and drives `apply` with a fake
 * sessions store and workspace navigator.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import(new URL('../client.js', import.meta.url).href)

assert.equal(captured?.id, 'dsh-context-handoff', 'module id')
assert.equal(typeof captured.factory, 'function', 'module factory')

const clientExports = captured.factory(() => {
  throw new Error('client.js must not require anything')
})
assert.equal(typeof clientExports.apply, 'function')
assert.deepEqual(clientExports.inject, ['sessions', 'uiWorkspace'])

/** Minimal observable store with getSnapshot/subscribe. */
function makeStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

function makeHarness({ initial }) {
  const store = makeStore(initial)
  const opened = []
  const effects = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: store }
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }
  return { ctx, store, opened, effects }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const summary = (overrides) => ({ id: 'x', displayTitle: 'x', running: false, blank: false, updatedAt: 1, ...overrides })

let failures = 0
async function test(title, fn) {
  try {
    await fn()
    console.log(`ok - ${title}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL - ${title}`)
    console.error(error)
  }
}

await test('opens a new child of the current session once', async () => {
  const { ctx, store, opened } = makeHarness({
    initial: { ids: ['A'], byId: { A: summary({ id: 'A' }) }, current: 'A', phase: 'ready' },
  })
  clientExports.apply(ctx)
  await tick()
  assert.deepEqual(opened, [], 'existing rows are never opened')

  store.set({
    ids: ['B', 'A'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A' }) },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, ['B'], 'child of current opened')

  // Re-publishing the same child must not reopen (no repeated focus stealing).
  store.set({
    ids: ['B', 'A'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A', running: true }) },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, ['B'])
})

await test('waits for the first ready snapshot when initially pending', async () => {
  const { ctx, store, opened } = makeHarness({
    initial: { ids: [], byId: {}, current: undefined, phase: 'pending' },
  })
  clientExports.apply(ctx)
  await tick()
  store.set({
    ids: ['A', 'B'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A' }) },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, [], 'sessions present at first ready are baseline, not arrivals')
})

await test('ignores subagents and non-children', async () => {
  const { ctx, store, opened } = makeHarness({
    initial: { ids: ['A'], byId: { A: summary({ id: 'A' }) }, current: 'A', phase: 'ready' },
  })
  clientExports.apply(ctx)
  await tick()
  store.set({
    ids: ['S', 'D', 'A'],
    byId: {
      A: summary({ id: 'A' }),
      S: summary({ id: 'S', parentId: 'A', origin: 'subagent' }),
      D: summary({ id: 'D', parentId: 'OTHER' }),
    },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, [], 'subagents and unrelated sessions stay closed')
})

await test('opens a child of the newly current session', async () => {
  const { ctx, store, opened } = makeHarness({
    initial: { ids: ['A'], byId: { A: summary({ id: 'A' }) }, current: 'A', phase: 'ready' },
  })
  clientExports.apply(ctx)
  await tick()
  store.set({
    ids: ['B', 'A'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A' }) },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  store.set({
    ids: ['C', 'B', 'A'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A' }), C: summary({ id: 'C', parentId: 'B' }) },
    current: 'B',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, ['B', 'C'])
})

await test('effect disposer unsubscribes', async () => {
  const { ctx, store, opened, effects } = makeHarness({
    initial: { ids: ['A'], byId: { A: summary({ id: 'A' }) }, current: 'A', phase: 'ready' },
  })
  clientExports.apply(ctx)
  await tick()
  assert.equal(store.listenerCount(), 1)
  assert.equal(effects.length, 1)
  effects[0]()
  assert.equal(store.listenerCount(), 0)
  store.set({
    ids: ['B', 'A'],
    byId: { A: summary({ id: 'A' }), B: summary({ id: 'B', parentId: 'A' }) },
    current: 'A',
    phase: 'ready',
  })
  await tick()
  assert.deepEqual(opened, [], 'no opens after disposal')
})

console.log(failures === 0 ? '\nall client tests passed' : `\n${failures} client test(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
