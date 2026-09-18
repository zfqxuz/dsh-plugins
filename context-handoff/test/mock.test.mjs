/**
 * Dependency-free logic tests for the context-handoff plugin.
 * Run: node test/mock.test.mjs
 */
import assert from 'node:assert/strict'
import { apply, internals, name } from '../index.js'

const { createState, readOccupancy, shouldTrigger, normalizeConfig, maybeHandoff, buildDigest, balancedTurnPrefix } = internals

const makeEvents = () => [
  { type: 'session', seq: 0, data: { id: 'session-parent', cwd: '/tmp/ws' } },
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '请实现登录功能' }], role: 'user', id: 'm1' } },
  { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a.ts b.ts' }], isError: false }], role: 'user', id: 'm2' } } },
  { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已完成登录页面' }] } } },
  { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
]

function makeSession(overrides = {}) {
  const events = overrides.events ?? makeEvents()
  return {
    id: 'session-parent',
    seq: events.length,
    header: { id: 'session-parent', cwd: '/tmp/ws', createdAt: 1700000000000, isSeeded: false, ...(overrides.header ?? {}) },
    snapshotEvents: () => events,
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1000000, ...(overrides.requestContext ?? {}) }),
  }
}

function makeCtx({ pressure, session }) {
  const seen = { created: [], followups: [], injected: [], attached: [], tools: [], commands: [], on: [], logs: [], freeze: { prompt: [], restrict: [], guard: [] } }
  const stateOf = (s, key) => {
    if (key === 'contextPressure') return pressure
    if (key === 'title') return '实现登录'
    if (key === 'todos') return [{ content: '实现登录', status: 'in_progress' }]
    return undefined
  }
  const childSession = { header: { cwd: '/tmp/ws' } }
  const child = {
    id: undefined,
    session: childSession,
    followup: (message) => seen.followups.push(message),
    inject: (message) => seen.injected.push(message),
  }
  const parent = {
    id: 'session-parent',
    session,
    status: 'idle',
    inbox: { hasPending: false },
    options: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    ctx: {
      get(name) {
        if (name === 'systemPrompt') {
          return { context: (entry) => { seen.freeze.prompt.push(entry); return () => {} } }
        }
        if (name === 'tools') {
          return {
            restrict: (filter) => { seen.freeze.restrict.push(filter); return () => {} },
            guard: (guard) => { seen.freeze.guard.push(guard); return () => {} },
          }
        }
        return undefined
      },
      fake: 'parent-scope',
    },
    followup: () => {},
    inject: (message) => seen.injected.push(message),
  }
  const ctx = {
    logger: {
      info: (m) => seen.logs.push(['info', m]),
      warn: (m) => seen.logs.push(['warn', m]),
      debug: () => {},
    },
    get(name) {
      if (name === 'sessionProjections') return { stateOf }
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 800 }) }
      if (name === 'agents') {
        return {
          get: (id) => (id === 'session-parent' ? parent : undefined),
          create: async (options) => {
            seen.created.push(options)
            child.id = options.sessionId
            return { agent: child, dispose: async () => {} }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'ws-1', sessionIds: ['session-parent'], attachSession: async (id) => seen.attached.push(id) }],
          resolveByPath: async () => ({ id: 'ws-1', attachSession: async (id) => seen.attached.push(id) }),
        }
      }
      if (name === 'agentPresets') {
        return { composedPreset: () => 'minimal', composeFrom: () => 'minimal', mount: async () => {} }
      }
      return undefined
    },
    on: (eventName, handler) => seen.on.push([eventName, handler]),
    tools: { register: (definition) => seen.tools.push(definition) },
    commands: { register: (definition) => seen.commands.push(definition) },
  }
  return { ctx, seen, parent }
}

const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
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

await test('exports plugin identity', () => {
  assert.equal(name, 'context-handoff')
})

await test('triggers below the configured available ratio', async () => {
  const session = makeSession()
  const { ctx, seen } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0, digestMaxChars: 2000 })
  assert.equal(seen.on.length, 1)
  const [, handler] = seen.on[0]
  handler(session, { type: 'turn/end' })
  await sleep()
  assert.equal(seen.created.length, 1, 'one child session created')
  const options = seen.created[0]
  assert.equal(options.meta.cwd, '/tmp/ws', 'child inherits cwd')
  assert.equal(options.meta.parentSession, 'session-parent', 'child records lineage')
  assert.equal(options.agentOptions.provider, 'deepseek-official')
  assert.equal(options.agentOptions.reasoningEffort, 'high')
  assert.equal(seen.followups.length, 1, 'continuation turn started')
  assert.equal(seen.followups[0].source.form, 'recall', 'continuation is a recall message')
  assert.match(seen.followups[0].content[0].text, /session-parent/)
  assert.match(seen.followups[0].content[0].text, /实现登录/)
  assert.deepEqual(seen.attached, [options.sessionId], 'child attached to workspace')
  assert.equal(seen.injected.length, 1, 'parent notified')
  assert.equal(seen.injected[0].source.form, 'notice')
  assert.equal(seen.tools.length, 1, 'tool registered')
  assert.equal(seen.commands.length, 1, 'command registered')
  assert.equal(seen.freeze.prompt.length, 1, 'frozen prompt context registered')
  assert.equal(seen.freeze.restrict.length, 1, 'frozen tool restriction registered')
  assert.equal(seen.freeze.guard.length, 1, 'frozen tool guard registered')
  assert.match(seen.injected[0].content[0].text, /冻结/)
})

await test('does not trigger while plenty of context remains', async () => {
  const session = makeSession()
  const { ctx, seen } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 100, surfaceTokens: 100, sampledSurfaceTokens: 100 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const [, handler] = seen.on[0]
  handler(session, { type: 'turn/end' })
  await sleep()
  assert.equal(seen.created.length, 0)
})

await test('once guard prevents a second automatic handoff', async () => {
  const session = makeSession()
  const { ctx, seen } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const [, handler] = seen.on[0]
  handler(session, { type: 'turn/end' })
  await sleep()
  handler(session, { type: 'turn/end' })
  await sleep()
  assert.equal(seen.created.length, 1)
})

await test('forced tool handoff bypasses threshold and once', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 10, surfaceTokens: 10, sampledSurfaceTokens: 10 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const tool = seen.tools[0]
  const output = await tool.execute({ action: 'handoff' }, { agent: parent })
  assert.match(String(output), /handoff ok/)
  assert.equal(seen.created.length, 1)
})

await test('status tool renders occupancy without triggering', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const output = String(await seen.tools[0].execute({ action: 'status' }, { agent: parent }))
  assert.match(output, /available: 250 tokens \(25.0%\)/)
  assert.match(output, /would_trigger: yes/)
  assert.equal(seen.created.length, 0)
})

await test('dryRun reports but does not create', async () => {
  const session = makeSession()
  const { ctx, seen } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0, dryRun: true })
  const [, handler] = seen.on[0]
  handler(session, { type: 'turn/end' })
  await sleep()
  assert.equal(seen.created.length, 0)
})

await test('seed mode cuts a balanced completed-turn prefix', () => {
  const session = makeSession()
  const prefix = balancedTurnPrefix(session)
  assert.equal(prefix.at(-1).type, 'turn/end')
  assert.equal(prefix.length, 6)
})

await test('digest contains todo, transcript and tool activity', () => {
  const session = makeSession()
  const { ctx } = makeCtx({ pressure: undefined, session })
  const digest = buildDigest(ctx, session, normalizeConfig({ digestMaxChars: 4000 }))
  assert.match(digest, /### TODO 状态/)
  assert.match(digest, /### 最近对话/)
  assert.match(digest, /请实现登录功能/)
  assert.match(digest, /### 最近工具活动/)
  assert.match(digest, /bash/)
})

await test('config validation', () => {
  assert.throws(() => normalizeConfig({ availableRatio: 0 }))
  assert.throws(() => normalizeConfig({ checkOn: 'nope' }))
  assert.throws(() => normalizeConfig({ continueMode: 'nope' }))
  const cfg = normalizeConfig({ availableRatio: '0.5' })
  assert.equal(cfg.availableRatio, 0.5, 'non-numeric keeps default')
})

await test('occupancy prefers tokenMeter when no projection', () => {
  const session = makeSession()
  const { ctx } = makeCtx({ pressure: undefined, session })
  const occ = readOccupancy(ctx, session, normalizeConfig({}))
  assert.equal(occ.used, 800)
  assert.equal(occ.contextWindow, 1000000)
  assert.equal(occ.source, 'tokenMeter')
})

await test('forced handoff reuses an existing continuation instead of duplicating', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const tool = seen.tools[0]
  const first = String(await tool.execute({ action: 'handoff' }, { agent: parent }))
  const second = String(await tool.execute({ action: 'handoff' }, { agent: parent }))
  assert.match(first, /handoff ok/)
  assert.match(second, /reused existing continuation/)
  assert.equal(seen.created.length, 1, 'only one child created')
})

await test('forced handoff with new_session=true creates a fresh continuation', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  const tool = seen.tools[0]
  await tool.execute({ action: 'handoff' }, { agent: parent })
  await tool.execute({ action: 'handoff', new_session: true }, { agent: parent })
  assert.equal(seen.created.length, 2, 'explicit new_session creates a second child')
})

await test('freeze can be disabled by config', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0, freezeParent: false })
  await seen.tools[0].execute({ action: 'handoff' }, { agent: parent })
  assert.equal(seen.freeze.prompt.length, 0)
  assert.equal(seen.freeze.restrict.length, 0)
})

await test('status reports the existing continuation', async () => {
  const session = makeSession()
  const { ctx, seen, parent } = makeCtx({ pressure: { contextWindow: 1000, pressureTokens: 750, surfaceTokens: 750, sampledSurfaceTokens: 750 }, session })
  apply(ctx, { availableRatio: 0.3, cooldownMs: 0 })
  await seen.tools[0].execute({ action: 'handoff' }, { agent: parent })
  const status = String(await seen.tools[0].execute({ action: 'status' }, { agent: parent }))
  assert.match(status, /continuation: session-/)
})

console.log(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
