/**
 * DSH plugin: automatic context-pressure handoff.
 *
 * When a live session's AVAILABLE context drops below a configured ratio
 * (default 50%), this plugin opens a NEW session in the SAME workspace, feeds
 * it a compact "recall" digest of the previous session plus a pointer to the
 * full transcript, and (by default) starts the continuation turn there.
 *
 * Design notes
 * ------------
 * - The DSH plugin loader mounts this file by absolute path, so the module
 *   intentionally imports ONLY `node:*` builtins. Every DSH service is reached
 *   through `ctx.get(...)` with graceful degradation.
 * - Occupancy is read from the same source the Web context meter uses:
 *   the `sessionProjections` -> `contextPressure` projection, falling back to
 *   `ctx.tokenMeter.measure(session)` + `session.requestContext()`.
 * - A fresh (unseeded) session is the default because seeding the parent's
 *   whole log would reproduce the very context pressure we are escaping. The
 *   child instead receives a bounded digest and can call the `session_read`
 *   tool for the complete history.
 * - `continueMode: 'seed'` is available for callers that prefer a lossless
 *   fork prefix (it cuts at the last completed turn, like DSH's fork backend).
 *
 * Exports: `name`, `inject`, `apply`. Tools: `context_handoff`. Command:
 * `/handoff`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'context-handoff'
export const inject = ['tools']

/** Default configuration; every value is overridable through the patch `config:` block. */
const DEFAULTS = Object.freeze({
  /** Trigger when available/contextWindow drops below this ratio. 0.5 == 50% available (used >= 50%). */
  availableRatio: 0.5,
  /** Optional context-window fallback used when the session records none. */
  contextWindow: 0,
  /** Never trigger before this many tokens are in use. */
  minUsedTokens: 0,
  /** Boundary that is checked: 'turn-end' (default) or 'step-end'. */
  checkOn: 'turn-end',
  /** Start the continuation turn in the new session automatically. */
  autoContinue: true,
  /** 'fresh' (digest only, recommended) or 'seed' (fork the completed-turn prefix). */
  continueMode: 'fresh',
  /** Maximum characters in the recall digest. */
  digestMaxChars: 12000,
  /** Maximum user/assistant messages retained in the digest. */
  digestMaxMessages: 30,
  /** Maximum tool call/result pairs retained in the digest. */
  digestMaxToolEvents: 16,
  /** Include recent tool activity in the digest. */
  digestIncludeToolCalls: true,
  /** Inject a durable notice into the parent so its model knows about the handoff. */
  notifyParent: true,
  /** After handoff, freeze the source session: a hard scoped prompt + no new work there. */
  freezeParent: true,
  /** Also hide and deny tools in the frozen source session (strongest freeze). */
  freezeTools: true,
  /** Only one automatic handoff per source session. */
  once: true,
  /** Include child sessions that are themselves subagents. */
  includeSubagents: false,
  /** Minimum milliseconds between two automatic handoffs (process-wide). */
  cooldownMs: 30000,
  /** Log and report the decision without creating a session. */
  dryRun: false,
  /** Model-facing tool name. */
  toolName: 'context_handoff',
  /** Human-facing slash command name (without the slash). */
  commandName: 'handoff',
})

const PLUGIN_LABEL = 'context-handoff'

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function safeGet(ctx, serviceName) {
  try {
    if (typeof ctx?.get === 'function') {
      const service = ctx.get(serviceName)
      if (service !== undefined) return service
    }
  } catch {
    /* fall through to the property access */
  }
  // Cordis also exposes services as context properties; fall back for test
  // harnesses and for contexts that only carry the direct registration. This
  // property access throws for an undeclared service, so it is guarded too.
  try {
    return ctx?.[serviceName]
  } catch {
    return undefined
  }
}

/**
 * Resolve a service through an agent-scoped context, preferring the direct
 * property form the subagent drivers use (`agent.ctx.tools.restrict(...)`) so
 * scoped registrations are always bound to that agent.
 */
function scopedGet(ctx, serviceName) {
  try {
    const direct = ctx?.[serviceName]
    if (direct !== undefined) return direct
  } catch {
    /* fall through to the reflective form */
  }
  return safeGet(ctx, serviceName)
}

function clampNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isPositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) }
  cfg.availableRatio = clampNumber(cfg.availableRatio, DEFAULTS.availableRatio)
  if (!(cfg.availableRatio > 0 && cfg.availableRatio <= 1)) {
    throw new Error(`${PLUGIN_LABEL}: availableRatio must be in (0, 1], got ${cfg.availableRatio}`)
  }
  cfg.contextWindow = isPositiveInt(cfg.contextWindow) ? cfg.contextWindow : 0
  cfg.minUsedTokens = Math.max(0, Math.trunc(clampNumber(cfg.minUsedTokens, DEFAULTS.minUsedTokens)))
  cfg.digestMaxChars = Math.max(500, Math.trunc(clampNumber(cfg.digestMaxChars, DEFAULTS.digestMaxChars)))
  cfg.digestMaxMessages = Math.max(1, Math.trunc(clampNumber(cfg.digestMaxMessages, DEFAULTS.digestMaxMessages)))
  cfg.digestMaxToolEvents = Math.max(0, Math.trunc(clampNumber(cfg.digestMaxToolEvents, DEFAULTS.digestMaxToolEvents)))
  cfg.cooldownMs = Math.max(0, Math.trunc(clampNumber(cfg.cooldownMs, DEFAULTS.cooldownMs)))
  if (cfg.checkOn !== 'turn-end' && cfg.checkOn !== 'step-end') {
    throw new Error(`${PLUGIN_LABEL}: checkOn must be 'turn-end' or 'step-end'`)
  }
  if (cfg.continueMode !== 'fresh' && cfg.continueMode !== 'seed') {
    throw new Error(`${PLUGIN_LABEL}: continueMode must be 'fresh' or 'seed'`)
  }
  for (const key of ['autoContinue', 'digestIncludeToolCalls', 'notifyParent', 'freezeParent', 'freezeTools', 'once', 'includeSubagents', 'dryRun']) {
    cfg[key] = cfg[key] === true
  }
  cfg.toolName = typeof cfg.toolName === 'string' && cfg.toolName.trim() !== '' ? cfg.toolName.trim() : DEFAULTS.toolName
  cfg.commandName = typeof cfg.commandName === 'string' && cfg.commandName.trim() !== '' ? cfg.commandName.trim() : DEFAULTS.commandName
  return cfg
}

/** Recursively freeze a plain JSON value (mirrors DSH's message freezing). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Build a frozen user-role message without importing @deepseek-ai/dsh-llm. */
function makeUserMessage(text, source) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: typeof text === 'string' && text !== '' ? [{ type: 'text', text }] : [],
    source,
  })
}

function truncate(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`
}

function iso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/* ------------------------------------------------------------------ */
/* occupancy                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read the current occupancy the same way the Web context meter does.
 * @returns {{used: number, contextWindow: number, available: number, usedRatio: number, availableRatio: number, source: string}|undefined}
 */
function readOccupancy(ctx, session, cfg) {
  const projections = safeGet(ctx, 'sessionProjections')
  let used
  let contextWindow
  let source

  const pressure = typeof projections?.stateOf === 'function' ? projections.stateOf(session, 'contextPressure') : undefined
  if (pressure && typeof pressure === 'object') {
    used = projectedTokensOf(pressure)
    contextWindow = isPositiveInt(pressure.contextWindow) ? pressure.contextWindow : undefined
    if (used !== undefined) source = 'contextPressure'
  }

  if (used === undefined) {
    const meter = safeGet(ctx, 'tokenMeter')
    const measurement = typeof meter?.measure === 'function' ? safeCall(() => meter.measure(session)) : undefined
    if (measurement && typeof measurement.totalTokens === 'number') {
      used = Math.max(0, measurement.totalTokens)
      source = source ?? 'tokenMeter'
    }
  }

  if (contextWindow === undefined) {
    const requestContext = typeof session?.requestContext === 'function' ? safeCall(() => session.requestContext()) : undefined
    if (isPositiveInt(requestContext?.contextWindow)) contextWindow = requestContext.contextWindow
  }
  if (contextWindow === undefined && isPositiveInt(cfg.contextWindow)) contextWindow = cfg.contextWindow

  if (used === undefined || !isPositiveInt(contextWindow)) return undefined
  used = Math.max(0, Math.min(used, contextWindow))
  const available = Math.max(0, contextWindow - used)
  return {
    used,
    contextWindow,
    available,
    usedRatio: used / contextWindow,
    availableRatio: available / contextWindow,
    source: source ?? 'unknown',
  }
}

function projectedTokensOf(pressure) {
  if (typeof pressure.projectedTokens === 'number') return Math.max(0, pressure.projectedTokens)
  if (
    typeof pressure.pressureTokens === 'number' &&
    typeof pressure.surfaceTokens === 'number' &&
    typeof pressure.sampledSurfaceTokens === 'number'
  ) {
    return Math.max(0, pressure.pressureTokens + pressure.surfaceTokens - pressure.sampledSurfaceTokens)
  }
  if (typeof pressure.pressureTokens === 'number') return Math.max(0, pressure.pressureTokens)
  return undefined
}

function shouldTrigger(occ, cfg) {
  if (occ === undefined) return false
  if (occ.used < cfg.minUsedTokens) return false
  return occ.availableRatio < cfg.availableRatio
}

/* ------------------------------------------------------------------ */
/* digest                                                              */
/* ------------------------------------------------------------------ */

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function userText(event) {
  return textOfContent(event?.data?.content)
}

function assistantText(event) {
  return textOfContent(event?.data?.message?.content ?? event?.data?.content)
}

function toolResultText(event) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'tool-result') parts.push(textOfContent(block.content))
  }
  return parts.join('\n').trim()
}

function recentTranscript(events, cfg, charBudget) {
  const lines = []
  let chars = 0
  let messages = 0
  for (let index = events.length - 1; index >= 0 && messages < cfg.digestMaxMessages; index -= 1) {
    const event = events[index]
    let role
    let text
    if (event?.type === 'user/message') {
      role = 'user'
      text = userText(event)
    } else if (event?.type === 'assistant/message') {
      role = 'assistant'
      text = assistantText(event)
    } else {
      continue
    }
    if (text === '') continue
    const entry = `**${role}**: ${text}`
    if (chars + entry.length > charBudget && messages > 0) break
    lines.push(entry)
    chars += entry.length + 2
    messages += 1
  }
  lines.reverse()
  return lines.join('\n\n')
}

function recentTools(events, cfg, charBudget) {
  if (!cfg.digestIncludeToolCalls || cfg.digestMaxToolEvents === 0) return ''
  const lines = []
  let chars = 0
  let count = 0
  for (let index = events.length - 1; index >= 0 && count < cfg.digestMaxToolEvents; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    const name = typeof event.data?.name === 'string' ? event.data.name : '(unknown)'
    const args = truncate(typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments ?? {}), 200)
    let result = ''
    for (let next = index + 1; next < events.length; next += 1) {
      if (events[next]?.type === 'tool/result') {
        result = truncate(toolResultText(events[next]), 240)
        break
      }
      if (events[next]?.type === 'tool/call') break
    }
    const entry = `- \`${name}\` ${args}${result === '' ? '' : `\n  -> ${result}`}`
    if (chars + entry.length > charBudget && count > 0) break
    lines.push(entry)
    chars += entry.length + 1
    count += 1
  }
  lines.reverse()
  return lines.join('\n')
}

function buildDigest(ctx, session, cfg) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const header = session.header ?? {}
  const sessionId = header.id ?? session.id
  const parts = ['## 上一会话摘要', '']
  parts.push(`- session_id: \`${sessionId}\``)
  if (header.cwd) parts.push(`- cwd: \`${header.cwd}\``)
  const createdAt = iso(header.createdAt)
  if (createdAt) parts.push(`- created_at: ${createdAt}`)
  const title = projectionValue(ctx, session, 'title')
  if (typeof title === 'string' && title.trim() !== '') parts.push(`- title: ${title.trim()}`)

  const goal = projectionValue(ctx, session, 'goal')
  const objective = goal?.current?.objective ?? goal?.current?.title
  if (typeof objective === 'string' && objective.trim() !== '') parts.push(`- active_goal: ${truncate(objective.trim(), 400)}`)

  const todos = projectionValue(ctx, session, 'todos')
  if (Array.isArray(todos) && todos.length > 0) {
    parts.push('', '### TODO 状态')
    for (const todo of todos) {
      const status = typeof todo?.status === 'string' ? todo.status : 'pending'
      const content = typeof todo?.content === 'string' ? todo.content : String(todo?.content ?? '')
      parts.push(`- [${status}] ${content}`)
    }
  }

  const transcriptBudget = Math.max(500, Math.floor(cfg.digestMaxChars * 0.72))
  const transcript = recentTranscript(events, cfg, transcriptBudget)
  if (transcript !== '') parts.push('', '### 最近对话', transcript)

  const toolBudget = Math.max(0, cfg.digestMaxChars - transcript.length - 1200)
  const tools = recentTools(events, cfg, toolBudget)
  if (tools !== '') parts.push('', '### 最近工具活动', tools)

  let text = parts.join('\n')
  if (text.length > cfg.digestMaxChars) {
    text = `${text.slice(0, cfg.digestMaxChars)}\n…（摘要已截断；完整历史请用 session_read 读取 \`${sessionId}\`）`
  }
  return text
}

function projectionValue(ctx, session, key) {
  const projections = safeGet(ctx, 'sessionProjections')
  if (typeof projections?.stateOf !== 'function') return undefined
  return safeCall(() => projections.stateOf(session, key))
}

function resolveLogPath(session) {
  const header = session?.header ?? {}
  const sessionId = header.id ?? session?.id
  if (typeof sessionId !== 'string') return undefined
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return join(home, 'sessions', sessionId, 'session.v3.jsonl.zstd')
  const escaped = `--${cwd.replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\]+/g, '-')}--`
  return join(home, 'sessions', escaped, sessionId, 'session.v3.jsonl.zstd')
}

/* ------------------------------------------------------------------ */
/* session creation                                                    */
/* ------------------------------------------------------------------ */

function balancedTurnPrefix(session) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  let lastEnd = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/end') {
      lastEnd = index
      break
    }
  }
  return lastEnd < 0 ? [] : events.slice(0, lastEnd + 1)
}

function agentOptionsFor(ctx, parent) {
  const out = {}
  const source = parent?.options ?? {}
  if (typeof source.provider === 'string') out.provider = source.provider
  if (typeof source.model === 'string') out.model = source.model
  if (typeof source.reasoningEffort === 'string') out.reasoningEffort = source.reasoningEffort
  if (isPositiveInt(source.maxTokens)) out.maxTokens = source.maxTokens

  const headerConfig = safeCall(() => parent?.session?.requestHeader?.()?.config)
  if (out.provider === undefined && typeof headerConfig?.provider === 'string') out.provider = headerConfig.provider
  if (out.model === undefined && typeof headerConfig?.model === 'string') out.model = headerConfig.model
  if (out.provider === undefined || out.model === undefined) {
    const fallback = safeCall(() => safeGet(ctx, 'agentDefaultModel')?.currentSelection?.())
    if (out.provider === undefined && typeof fallback?.provider === 'string') out.provider = fallback.provider
    if (out.model === undefined && typeof fallback?.model === 'string') out.model = fallback.model
  }
  return out
}

async function resolveWorkspace(ctx, session) {
  const registry = safeGet(ctx, 'workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const list = typeof registry.list === 'function' ? registry.list() : []
    const direct = list.find((workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(session.id))
    if (direct !== undefined) return direct
  } catch {
    /* fall through to path resolution */
  }
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  if (typeof registry.resolveByPath !== 'function') return undefined
  try {
    return await registry.resolveByPath(cwd)
  } catch {
    return undefined
  }
}

function composeChild(agentCtx, parent, ctx, presetId) {
  const presets = safeGet(ctx, 'agentPresets')
  if (presets === undefined) return undefined
  if (typeof presets.composeFrom === 'function') {
    try {
      presets.composeFrom(agentCtx, parent.ctx)
      return undefined
    } catch {
      /* fall back to an explicit mount below */
    }
  }
  if (typeof presetId === 'string' && presetId !== '' && typeof presets.mount === 'function') {
    return presets.mount(agentCtx, presetId)
  }
  return undefined
}

function buildContinuationText(parent, occ, digest, cfg) {
  const session = parent.session
  const sessionId = session.header?.id ?? session.id
  const logPath = resolveLogPath(session)
  const lines = [
    '# 自动上下文交接（context-handoff）',
    '',
    `上一会话 \`${sessionId}\` 的可用上下文已低于 ${formatPct(cfg.availableRatio)}（当前约剩 ${formatPct(occ.availableRatio)}，已用 ${occ.used}/${occ.contextWindow} tokens）。`,
    `已自动在当前工作区新建本会话继续，请从这里接着做。`,
    '',
    '请先阅读下面的「上一会话摘要」。如果需要更完整的历史，请调用 `session_read` 工具读取上一会话：',
    `- session_id: \`${sessionId}\``,
    ...(session.header?.cwd ? [`- cwd: \`${session.header.cwd}\``] : []),
    ...(logPath !== undefined ? [`- log_file: \`${logPath}\``] : []),
    ...(pathExists(logPath) ? [] : ['- （日志文件尚未出现时请只依赖 session_id 或摘要）']),
    '',
    '然后从上一会话未完成的地方继续，不要重复已经完成的工作；摘要里的 TODO 若有未完成项，请优先继续。',
    '',
    '---',
    '',
    digest,
  ]
  return lines.join('\n')
}

function pathExists(path) {
  if (typeof path !== 'string') return false
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function buildParentNotice(childId, occ, cfg) {
  const summary = `已交接给 ${childId}，本会话已冻结`
  return makeUserMessage(
    [
      `[context-handoff] 本会话可用上下文已低于 ${formatPct(cfg.availableRatio)}（约剩 ${formatPct(occ.availableRatio)}），已交接给接续会话 \`${childId}\`，当前会话已冻结。`,
      `后续工作请到该会话继续。**不要**再调用工具、不要再继续任务、不要向用户提问；如果用户在此发言，只回复一行：「已交接给 ${childId}，请打开该会话继续。」`,
    ].join('\n'),
    { kind: 'plugin', plugin: name, form: 'notice', summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…` }
  )
}

/* ------------------------------------------------------------------ */
/* orchestration                                                       */
/* ------------------------------------------------------------------ */

function createState() {
  return {
    handled: new Set(),
    inflight: new Map(),
    /** parent session id -> handoff entry (one active continuation per parent). */
    children: new Map(),
    /** Disposers for the frozen-parent prompt context / tool restriction / guard. */
    freezeDisposers: [],
    lastTriggerAt: 0,
    triggers: [],
    skipped: [],
  }
}

function record(state, bucket, entry) {
  state[bucket].push(entry)
  if (state[bucket].length > 50) state[bucket].splice(0, state[bucket].length - 50)
}

/**
 * Freeze the source session after a handoff so it cannot keep doing the task.
 *
 * Two independent layers, both registered through the parent agent's own scoped
 * context so they cannot leak to other agents:
 *   1. a hard system-prompt context that forbids work and asks for a one-line
 *      pointer;
 *   2. an optional tool restriction (hide global tools) plus a monotonic guard
 *      (deny every tool execution in this session, scoped registrations included).
 *
 * @returns a small record for logging/tool output.
 */
function freezeParent(ctx, parent, childId, cfg, state) {
  const parentId = parent?.session?.header?.id ?? parent?.session?.id ?? parent?.id
  const info = {
    parentSessionId: parentId,
    childSessionId: childId,
    enabled: cfg.freezeParent === true,
    prompt: false,
    toolsRestricted: false,
    toolsGuarded: false,
  }
  if (cfg.freezeParent !== true) return info

  const promptText = [
    '[context-handoff] THIS SESSION IS FROZEN AND HAS BEEN HANDED OFF.',
    `All further work continues in the new session \`${childId}\` (same workspace).`,
    'Do not perform work here. Do not call tools. Do not ask the user questions.',
    `If the user sends a message in this session, reply with exactly one short line:"已交接给 ${childId}，请打开该会话继续。"`,
  ].join(' ')

  const systemPrompt = scopedGet(parent.ctx, 'systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    try {
      const dispose = systemPrompt.context({ name: `${PLUGIN_LABEL}:frozen`, order: 9999, text: promptText })
      if (typeof dispose === 'function') state.freezeDisposers.push(dispose)
      info.prompt = true
    } catch (error) {
      safeLog(ctx, 'warn', `${PLUGIN_LABEL}: could not register frozen prompt context: ${String(error?.message ?? error)}`)
    }
  }

  if (cfg.freezeTools === true) {
    const tools = scopedGet(parent.ctx, 'tools')
    if (tools !== undefined && typeof tools.restrict === 'function') {
      try {
        const dispose = tools.restrict({ allow: [] })
        if (typeof dispose === 'function') state.freezeDisposers.push(dispose)
        info.toolsRestricted = true
      } catch (error) {
        safeLog(ctx, 'warn', `${PLUGIN_LABEL}: could not restrict tools on frozen session: ${String(error?.message ?? error)}`)
      }
    }
    if (tools !== undefined && typeof tools.guard === 'function') {
      try {
        const dispose = tools.guard((exec) => {
          const execAgent = exec?.agent?.id
          return execAgent === parentId
            ? `${PLUGIN_LABEL}: session ${parentId} was handed off to ${childId}; tools are disabled here`
            : undefined
        })
        if (typeof dispose === 'function') state.freezeDisposers.push(dispose)
        info.toolsGuarded = true
      } catch (error) {
        safeLog(ctx, 'warn', `${PLUGIN_LABEL}: could not guard tools on frozen session: ${String(error?.message ?? error)}`)
      }
    }
  }
  return info
}

async function performHandoff(ctx, session, occ, cfg, state, reason) {
  const agents = safeGet(ctx, 'agents')
  const parent = typeof agents?.get === 'function' ? agents.get(session.id) : undefined
  if (parent === undefined) throw new Error(`${PLUGIN_LABEL}: live agent for session ${session.id} not found`)

  const digest = buildDigest(ctx, session, cfg)
  const childId = `session-${randomUUID()}`
  const presets = safeGet(ctx, 'agentPresets')
  const presetId =
    safeCall(() => presets?.composedPreset?.(parent.ctx)) ?? session.header?.agentPreset ?? undefined
  const seed = cfg.continueMode === 'seed' ? balancedTurnPrefix(session) : undefined
  const meta = {
    ...(session.header?.cwd ? { cwd: session.header.cwd } : {}),
    parentSession: session.header?.id ?? session.id,
    ...(typeof presetId === 'string' && presetId !== '' ? { agentPreset: presetId } : {}),
    ...(seed !== undefined && seed.length > 0 ? { isSeeded: true } : {}),
  }

  const created = await agents.create({
    sessionId: childId,
    ...(seed !== undefined && seed.length > 0 ? { seed, inheritedEventCount: seed.length } : {}),
    meta,
    agentOptions: agentOptionsFor(ctx, parent),
    setup: (agentCtx) => composeChild(agentCtx, parent, ctx, presetId),
  })
  const child = created.agent

  let workspace
  try {
    workspace = await resolveWorkspace(ctx, session)
    if (workspace !== undefined && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(childId)
    }
  } catch (error) {
    safeLog(ctx, 'warn', `${PLUGIN_LABEL}: session ${childId} created but workspace attach failed: ${String(error)}`)
  }

  const continuation = makeUserMessage(buildContinuationText(parent, occ, digest, cfg), {
    kind: 'plugin',
    plugin: name,
    form: 'recall',
  })

  let started = false
  if (cfg.autoContinue && typeof child.followup === 'function') {
    child.followup(continuation)
    started = true
  } else if (typeof child.inject === 'function') {
    child.inject(continuation)
  }

  if (cfg.notifyParent && typeof parent.inject === 'function') {
    try {
      parent.inject(buildParentNotice(childId, occ, cfg))
    } catch (error) {
      safeLog(ctx, 'warn', `${PLUGIN_LABEL}: could not notify parent ${session.id}: ${String(error)}`)
    }
  }

  const freeze = freezeParent(ctx, parent, childId, cfg, state)

  const entry = {
    at: Date.now(),
    reason,
    parentSessionId: session.header?.id ?? session.id,
    childSessionId: childId,
    workspaceId: workspace?.id,
    used: occ.used,
    contextWindow: occ.contextWindow,
    availableRatio: occ.availableRatio,
    digestChars: digest.length,
    autoContinue: cfg.autoContinue && started,
    presetId,
    method: cfg.continueMode,
    freeze,
  }
  state.children.set(session.id, entry)
  record(state, 'triggers', entry)
  safeLog(
    ctx,
    'info',
    `${PLUGIN_LABEL}: handed ${entry.parentSessionId} -> ${childId} (available ${formatPct(occ.availableRatio)}, ${occ.used}/${occ.contextWindow} tokens)`
  )
  return entry
}

/**
 * Central guarded entry point. Returns a structured outcome instead of throwing
 * for expected conditions so tool/command callers can render it.
 */
async function maybeHandoff(ctx, session, cfg, state, options = {}) {
  const { force = false, recreate = false, reason = 'auto' } = options
  const occ = readOccupancy(ctx, session, cfg)
  if (occ === undefined) {
    return { ok: false, code: 'unavailable', occ, message: 'context occupancy is unavailable: no contextPressure projection, tokenMeter, or contextWindow' }
  }
  // One active continuation per source session: a forced `handoff` reuses it
  // instead of creating duplicate child sessions. Pass recreate=true for a new one.
  const existing = recreate ? undefined : state.children.get(session.id)
  if (existing !== undefined) {
    return { ok: true, code: 'reused', occ, entry: existing, message: `session ${session.id} already has continuation ${existing.childSessionId}` }
  }
  if (!force && !shouldTrigger(occ, cfg)) {
    return { ok: false, code: 'below-threshold', occ, message: `available ${formatPct(occ.availableRatio)} >= threshold ${formatPct(cfg.availableRatio)}` }
  }
  if (!force && cfg.once && state.handled.has(session.id)) {
    return { ok: false, code: 'already-handled', occ, message: `session ${session.id} was already handed off automatically` }
  }
  if (state.inflight.has(session.id)) {
    return { ok: false, code: 'inflight', occ, message: `a handoff for session ${session.id} is already in flight` }
  }
  if (!force && Date.now() - state.lastTriggerAt < cfg.cooldownMs) {
    return { ok: false, code: 'cooldown', occ, message: `cooldown active (${cfg.cooldownMs}ms)` }
  }
  if (cfg.dryRun) {
    record(state, 'skipped', { at: Date.now(), parentSessionId: session.id, code: 'dry-run', availableRatio: occ.availableRatio })
    return { ok: false, code: 'dry-run', occ, message: `dryRun: would hand off session ${session.id} (available ${formatPct(occ.availableRatio)})` }
  }

  const agents = safeGet(ctx, 'agents')
  const parent = typeof agents?.get === 'function' ? agents.get(session.id) : undefined
  if (parent === undefined) return { ok: false, code: 'no-agent', occ, message: `no live agent for session ${session.id}` }
  if (!force && parent.status !== 'idle') {
    return { ok: false, code: 'busy', occ, message: `agent ${session.id} is ${String(parent.status)}, deferring handoff` }
  }
  if (!force && parent.inbox?.hasPending === true) {
    return { ok: false, code: 'pending', occ, message: `agent ${session.id} still has pending input, deferring handoff` }
  }

  const operation = performHandoff(ctx, session, occ, cfg, state, reason)
  state.inflight.set(session.id, operation)
  try {
    const entry = await operation
    if (cfg.once) state.handled.add(session.id)
    state.lastTriggerAt = Date.now()
    return { ok: true, code: 'handed-off', occ, entry, message: `created continuation session ${entry.childSessionId}` }
  } catch (error) {
    safeLog(ctx, 'warn', `${PLUGIN_LABEL}: handoff for ${session.id} failed: ${String(error?.stack ?? error)}`)
    return { ok: false, code: 'error', occ, error, message: `handoff failed: ${String(error?.message ?? error)}` }
  } finally {
    state.inflight.delete(session.id)
  }
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function safeLog(ctx, level, message) {
  try {
    const logger = ctx?.logger
    const method = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : undefined
    if (method !== undefined) method(message)
  } catch {
    /* logging must never break the handoff */
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function statusText(session, occ, cfg, state) {
  const header = session.header ?? {}
  const lines = [
    'context_handoff status',
    `- plugin: ${PLUGIN_LABEL}`,
    `- session_id: ${header.id ?? session.id}`,
    `- cwd: ${header.cwd ?? '(none)'}`,
    `- agent_preset: ${header.agentPreset ?? '(none)'}`,
    `- model: ${safeCall(() => session.requestContext())?.provider ?? '?'} / ${safeCall(() => session.requestContext())?.model ?? '?'}`,
  ]
  if (occ === undefined) {
    lines.push('- context: unavailable (no contextPressure/tokenMeter/contextWindow)')
    return lines.join('\n')
  }
  lines.push(
    `- context_window: ${occ.contextWindow} tokens`,
    `- used: ${occ.used} tokens (${formatPct(occ.usedRatio)}, source=${occ.source})`,
    `- available: ${occ.available} tokens (${formatPct(occ.availableRatio)})`,
    `- trigger_threshold: available < ${formatPct(cfg.availableRatio)}`,
    `- would_trigger: ${shouldTrigger(occ, cfg) ? 'yes' : 'no'}`,
    `- already_handled: ${state.handled.has(session.id) ? 'yes' : 'no'}`,
    `- continuation: ${state.children.get(session.id)?.childSessionId ?? '(none)'}`,
    `- inflight: ${state.inflight.has(session.id) ? 'yes' : 'no'}`,
    `- auto_continue: ${cfg.autoContinue ? 'yes' : 'no'}`,
    `- continue_mode: ${cfg.continueMode}`,
    `- dry_run: ${cfg.dryRun ? 'yes' : 'no'}`
  )
  return lines.join('\n')
}

function okText(result) {
  if (result.ok) {
    const e = result.entry
    const lines = [
      result.code === 'reused' ? 'handoff ok (reused existing continuation)' : 'handoff ok',
      `- from: ${e.parentSessionId}`,
      `- to: ${e.childSessionId}`,
      `- workspace: ${e.workspaceId ?? '(none)'}`,
      `- available_at_trigger: ${formatPct(e.availableRatio)} (${e.used}/${e.contextWindow})`,
      `- auto_continue: ${e.autoContinue ? 'yes' : 'no'}`,
      `- digest_chars: ${e.digestChars}`,
      `- method: ${e.method}`,
    ]
    if (result.code === 'reused') lines.push('- reused: yes')
    if (e.freeze !== undefined) {
      lines.push(`- frozen: prompt=${e.freeze.prompt ? 'yes' : 'no'} tools_restricted=${e.freeze.toolsRestricted ? 'yes' : 'no'} tools_guarded=${e.freeze.toolsGuarded ? 'yes' : 'no'}`)
    }
    return lines.join('\n')
  }
  const occ = result.occ
  const suffix = occ === undefined ? '' : ` (available ${formatPct(occ.availableRatio)})`
  return `handoff skipped: ${result.code} — ${result.message}${suffix}`
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const state = createState()

  const boundaryType = cfg.checkOn === 'turn-end' ? 'turn/end' : 'step/end'
  const onBoundary = (session, event) => {
    if (event?.type !== boundaryType) return
    if (session === undefined || typeof session.id !== 'string') return
    if (!cfg.includeSubagents) {
      const header = session.header ?? {}
      // Ordinary continuation sessions also carry parentSession (and a
      // delegationDepth of 0), so only a real subagent origin/depth is skipped.
      if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) return
    }
    void Promise.resolve()
      .then(async () => {
        // At a turn/step boundary the agent may still be transitioning to
        // idle. Wait for the driver to settle so a handoff cannot race the
        // turn that just ended.
        const agents = safeGet(ctx, 'agents')
        const parent = typeof agents?.get === 'function' ? agents.get(session.id) : undefined
        if (parent !== undefined && parent.status !== 'idle' && typeof parent.whenIdle === 'function') {
          try {
            await parent.whenIdle()
          } catch {
            /* shutdown or a failed turn: fall through to the guarded check */
          }
        }
        return maybeHandoff(ctx, session, cfg, state, { reason: `auto:${cfg.checkOn}` })
      })
      .then((result) => {
        if (!result.ok && result.code !== 'below-threshold' && result.code !== 'already-handled') {
          safeLog(ctx, 'debug', `${PLUGIN_LABEL}: auto handoff skipped (${result.code}): ${result.message}`)
        }
      })
      .catch((error) => safeLog(ctx, 'warn', `${PLUGIN_LABEL}: auto handoff error: ${String(error?.stack ?? error)}`))
  }

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', onBoundary)
  }

  // Lift every frozen-parent registration when the plugin unloads.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of state.freezeDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* cleanup must never throw */
        }
      }
    }, `${PLUGIN_LABEL}: frozen-parent cleanup`)
  }

  const tool = {
    name: cfg.toolName,
    description:
      'Inspect or trigger the context-pressure handoff: when this session is running low on available context, open a new session in the same workspace and continue there with a digest of this one. ' +
      "Actions: 'status' (current occupancy and trigger decision), 'check' (trigger only if below threshold), 'handoff' (force a handoff now), 'list' (recent handoffs/skips).",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'check', 'handoff', 'list'],
          description: "Default 'status'.",
        },
        new_session: {
          type: 'boolean',
          description: 'For action=handoff only: create a brand-new continuation even when one already exists. Default false reuses the existing continuation.',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) throw new Error(`${PLUGIN_LABEL}: no live agent session for this call`)
      const action = typeof args?.action === 'string' ? args.action : 'status'
      if (action === 'status') return statusText(session, readOccupancy(ctx, session, cfg), cfg, state)
      if (action === 'list') {
        const triggers = state.triggers.map((entry) => `+ ${new Date(entry.at).toISOString()} ${entry.parentSessionId} -> ${entry.childSessionId} (${formatPct(entry.availableRatio)})`)
        const skipped = state.skipped.map((entry) => `- ${new Date(entry.at).toISOString()} ${entry.parentSessionId} ${entry.code}`)
        return [`recent handoffs (${triggers.length}):`, ...triggers, `recent skips (${skipped.length}):`, ...skipped].join('\n')
      }
      if (action === 'check') return okText(await maybeHandoff(ctx, session, cfg, state, { reason: 'tool:check' }))
      if (action === 'handoff') return okText(await maybeHandoff(ctx, session, cfg, state, { force: true, recreate: args?.new_session === true, reason: 'tool:force' }))
      throw new Error(`${PLUGIN_LABEL}: unknown action ${JSON.stringify(action)}`)
    },
  }
  if (typeof ctx.tools?.register === 'function') ctx.tools.register(tool)

  const commands = safeGet(ctx, 'commands')
  if (typeof commands?.register === 'function') {
    commands.register({
      name: cfg.commandName,
      description: `Open a continuation session when available context is below ${formatPct(cfg.availableRatio)} (or force one)`,
      handler: async (invocation) => {
        const session = invocation?.agent?.session
        if (session === undefined) return { kind: 'error', text: `${PLUGIN_LABEL}: no live agent session` }
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim().toLowerCase() : ''
        if (raw === 'status') return { kind: 'success', text: statusText(session, readOccupancy(ctx, session, cfg), cfg, state) }
        const force = raw === 'force' || raw === 'now'
        const result = await maybeHandoff(ctx, session, cfg, state, { force, reason: `command:${raw || 'auto'}` })
        return { kind: result.ok ? 'success' : 'error', text: okText(result) }
      },
    })
  }

  safeLog(ctx, 'info', `${PLUGIN_LABEL}: loaded (availableRatio<${formatPct(cfg.availableRatio)}, checkOn=${cfg.checkOn}, autoContinue=${cfg.autoContinue}, mode=${cfg.continueMode})`)
}

/**
 * Test/extension seam: the pure internals, exported so the behaviour can be
 * verified without booting a full DSH profile. They take an explicit context,
 * config, and state instead of a closure.
 */
export const internals = Object.freeze({
  DEFAULTS,
  normalizeConfig,
  readOccupancy,
  shouldTrigger,
  createState,
  maybeHandoff,
  performHandoff,
  freezeParent,
  buildDigest,
  balancedTurnPrefix,
  resolveLogPath,
  makeUserMessage,
})

