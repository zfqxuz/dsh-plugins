// 迁移契约（session-transfer）单测：认领/提交/超时三条路径。
import assert from 'node:assert/strict'
import { internals } from '../index.js'

const { maybeHandoff, normalizeConfig, createState } = internals
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeWorld({ mode }) {
  const seen = { created: [], followups: [], injected: [], frozen: [], emitted: [] }
  const bus = new Map()
  const dispatch = (name, payload) => {
    seen.emitted.push([name, payload])
    for (const handler of [...(bus.get(name) ?? [])]) handler(payload)
  }
  const session = {
    id: 'session-parent',
    header: { id: 'session-parent', cwd: '/tmp/ws', agentPreset: 'qq-coding', createdAt: Date.now() },
    snapshotEvents: () => [],
    requestContext: () => ({ contextWindow: 1000 }),
  }
  const child = { id: undefined, session: { header: {} }, followup: (m) => seen.followups.push(m), inject: () => {} }
  const parent = {
    id: 'session-parent', session, status: 'idle', inbox: { hasPending: false },
    options: {}, followup: () => {}, inject: (m) => seen.injected.push(m),
    ctx: {
      get(name) {
        if (name === 'systemPrompt') return { context: (e) => { seen.frozen.push(e); return () => {} } }
        if (name === 'tools') return { restrict: () => () => {}, guard: () => () => {} }
        return undefined
      },
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    emit: (name, payload) => {
      if (name === 'context-handoff/requested') {
        if (mode === 'claim-commit') {
          queueMicrotask(() => {
            dispatch('context-handoff/claimed', { fromSessionId: payload.fromSessionId, by: 'test:consumer' })
            dispatch('context-handoff/committed', { fromSessionId: payload.fromSessionId, toSessionId: 'session-child-consumer', by: 'test:consumer', mode: 'consumer-created' })
          })
        } else if (mode === 'claim-only') {
          queueMicrotask(() => dispatch('context-handoff/claimed', { fromSessionId: payload.fromSessionId, by: 'test:consumer' }))
        }
      }
      dispatch(name, payload)
    },
    on: (name, handler) => {
      const set = bus.get(name) ?? new Set(); set.add(handler); bus.set(name, set)
      return () => set.delete(handler)
    },
    get(name) {
      if (name === 'sessionProjections') return { stateOf: (s, key) => (key === 'contextPressure' ? { projectedTokens: 800, contextWindow: 1000 } : undefined) }
      if (name === 'agents') return { get: (id) => (id === 'session-parent' ? parent : undefined), create: async (o) => { seen.created.push(o); child.id = o.sessionId; return { agent: child, dispose: async () => {} } } }
      if (name === 'agentPresets') return { composedPreset: () => 'qq-coding', composeFrom: () => 'qq-coding' }
      return undefined
    },
  }
  return { ctx, session, seen }
}

const baseCfg = { availableRatio: 0.5, cooldownMs: 0, claimWindowMs: 60, claimCommitMs: 1500, autoContinue: false, freezeParent: true }

let failed = 0
async function t(title, fn) {
  try { await fn(); console.log('ok -', title) } catch (e) { failed += 1; console.error('FAIL -', title); console.error(e) }
}

await t('消费者认领并提交：插件不自建会话，且冻结父会话指向消费者的新会话', async () => {
  const { ctx, session, seen } = makeWorld({ mode: 'claim-commit' })
  const cfg = normalizeConfig(baseCfg)
  const result = await maybeHandoff(ctx, session, cfg, createState(), { reason: 'test' })
  assert.equal(result.ok, true)
  assert.equal(result.entry.method, 'consumer')
  assert.equal(result.entry.childSessionId, 'session-child-consumer')
  assert.equal(seen.created.length, 0, '插件不应自己建会话')
  assert.ok(seen.frozen.some((e) => String(e.text).includes('session-child-consumer')))
})

await t('无人认领：回退到插件自建（旧路径不回归）', async () => {
  const { ctx, session, seen } = makeWorld({ mode: 'none' })
  const cfg = normalizeConfig(baseCfg)
  const result = await maybeHandoff(ctx, session, cfg, createState(), { reason: 'test' })
  assert.equal(result.ok, true)
  assert.equal(result.entry.method, 'fresh')
  assert.equal(seen.created.length, 1)
})

await t('只认领不提交：报错且不自建（禁止双开）', async () => {
  const { ctx, session, seen } = makeWorld({ mode: 'claim-only' })
  const cfg = normalizeConfig({ ...baseCfg, claimCommitMs: 1200, claimWindowMs: 40 })
  const result = await maybeHandoff(ctx, session, cfg, createState(), { reason: 'test' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'error')
  assert.equal(seen.created.length, 0, '认领后不得再自建')
})

await t('excludePresets：qq-readonly 会话不参与交接', async () => {
  const { ctx, session, seen } = makeWorld({ mode: 'claim-commit' })
  const cfg = normalizeConfig({ ...baseCfg, excludePresets: ['qq-readonly'] })
  session.header.agentPreset = 'qq-readonly'
  const result = await maybeHandoff(ctx, session, cfg, createState(), { reason: 'test' })
  assert.equal(result.code, 'excluded-preset')
  assert.equal(seen.created.length, 0)
  assert.equal(seen.emitted.length, 0)
})

console.log(failed === 0 ? '\nall transfer tests passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
