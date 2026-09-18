/**
 * DSH plugin: read another conversation transcript by session id.
 *
 * The plugin registers a model-facing `session_read` tool. It locates a
 * DSH session directory below `$DSH_HOME/sessions`, decodes the concatenated
 * Zstandard frames of `session.v3.jsonl.zstd` (or a plain JSONL fallback),
 * and renders a bounded transcript of user/assistant messages.
 *
 * No third-party dependency is imported. The plugin resolves its own DSH home
 * and supports either the default `~/.dsh` home or an explicit `DSH_HOME`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'session-reader'
export const inject = ['tools']

const ZSTD_MAGIC = 0xfd2fb528
const DEFAULT_MAX_CHARS = 200_000

function resolveDshHome(config) {
  const configured = config?.dshHome
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function isZstd(buffer) {
  if (buffer.length < 4) return false
  return buffer.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * Scan structurally complete Zstandard frame ranges in a concatenated stream.
 * The DSH JSONL backend appends one independent frame per durable batch.
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decodeSessionLog(buffer) {
  if (!isZstd(buffer)) return buffer.toString('utf8')
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined) {
    throw new Error(
      `corrupt Zstandard session log: incomplete frame at byte ${tornStart}; ` +
        'the session may still be being written or the file is damaged'
    )
  }
  if (frames.length === 0) throw new Error('corrupt Zstandard session log: no complete frames')
  const chunks = frames.map((frame) => {
    try {
      return zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, {
        cause: error,
      })
    }
  })
  return Buffer.concat(chunks).toString('utf8')
}

function parseEvents(raw, position) {
  const events = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`corrupt session log ${position}: line ${index + 1} is not valid JSON`, {
        cause: error,
      })
    }
  }
  return events
}

function candidateSessionFiles(sessionId) {
  const direct = resolve(sessionId)
  const candidates = [
    join(direct, 'session.v3.jsonl.zstd'),
    join(direct, 'session.v2.jsonl.zstd'),
    join(direct, 'session.v1.jsonl.zstd'),
    direct,
  ]
  return candidates
}

function findSessionFile(sessionRoot, sessionId) {
  const searched = []
  const tryFile = (path, source) => {
    searched.push(path)
    if (!existsSync(path)) return undefined
    try {
      if (!statSync(path).isFile()) return undefined
    } catch {
      return undefined
    }
    return { path, source }
  }

  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.endsWith('.zstd') || sessionId.endsWith('.jsonl')) {
    for (const candidate of candidateSessionFiles(sessionId)) {
      const found = tryFile(candidate, 'direct path')
      if (found) return found
    }
  }

  const names = new Set()
  for (const entry of listDir(sessionRoot)) {
    if (!entry.isDirectory()) continue
    const nested = join(sessionRoot, entry.name, sessionId)
    names.add(nested)
    for (const candidate of candidateSessionFiles(nested)) {
      const found = tryFile(candidate, `workspace directory ${entry.name}`)
      if (found) return found
    }
  }
  for (const candidate of candidateSessionFiles(join(sessionRoot, sessionId))) {
    const found = tryFile(candidate, 'session root')
    if (found) return found
  }
  throw new Error(
    `session not found: ${JSON.stringify(sessionId)}; searched ${searched.length} candidate path(s) below ${JSON.stringify(sessionRoot)}`
  )
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function contentOfEvent(event) {
  if (!event || typeof event !== 'object') return []
  const data = event.data ?? {}
  if (Array.isArray(data.content)) return data.content
  if (data.message && Array.isArray(data.message.content)) return data.message.content
  return []
}

function isoTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return new Date(value).toISOString()
}

function formatBlocks(event, options) {
  const content = contentOfEvent(event)
  const lines = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      lines.push(block.text)
      continue
    }
    if (options.includeReasoning && block.type === 'reasoning' && typeof block.text === 'string') {
      lines.push(`[reasoning]\n${block.text}`)
      continue
    }
    if (options.includeToolCalls && block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : '(unknown tool)'
      const id = typeof block.id === 'string' ? block.id : ''
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
      lines.push(`[tool-call${id ? ` ${id}` : ''}] ${name} ${args}`)
    }
  }
  return lines
}

function formatToolResults(event, options) {
  if (!options.includeToolResults) return []
  const message = event?.data?.message
  const blocks = Array.isArray(message?.content) ? message.content : []
  const lines = []
  for (const block of blocks) {
    if (!block || block.type !== 'tool-result') continue
    const parts = Array.isArray(block.content) ? textOfContent(block.content) : ''
    if (parts.trim() !== '') {
      lines.push(`[tool-result${block.isError ? ' error' : ''}]\n${parts}`)
    }
  }
  return lines
}

function renderTranscript(events, found, options) {
  const header = events.find((event) => event?.type === 'session') ?? {}
  const titleEvent = events.find((event) => event?.type === 'session/title')
  const title = titleEvent?.data?.title
  const createdAt = isoTime(header.createdAt)
  const rendered = []

  rendered.push(`session_id: ${header.id ?? options.sessionId}`)
  if (title) rendered.push(`title: ${title}`)
  if (createdAt) rendered.push(`created_at: ${createdAt}`)
  if (header.cwd) rendered.push(`cwd: ${header.cwd}`)
  if (header.agentPreset) rendered.push(`agent_preset: ${header.agentPreset}`)
  rendered.push(`log_file: ${found.path}`)
  rendered.push(`event_count: ${events.length}`)
  rendered.push(
    `filters: reasoning=${options.includeReasoning} tool_calls=${options.includeToolCalls} tool_results=${options.includeToolResults}`
  )
  rendered.push('')

  let turns = 0
  let messages = 0
  for (const event of events) {
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const isUser = type === 'user/message'
    const blocks = formatBlocks(event, options)
    const toolResults = isUser ? [] : formatToolResults(event, options)
    const all = [...blocks, ...toolResults].filter((line) => line.trim() !== '')
    if (all.length === 0) continue
    if (isUser) turns += 1
    messages += 1
    const seq = typeof event.seq === 'number' ? ` seq=${event.seq}` : ''
    const time = isoTime(event.time)
    const turn = typeof event.data?.turn === 'number' ? ` turn=${event.data.turn}` : ''
    const step = typeof event.data?.step === 'number' ? ` step=${event.data.step}` : ''
    rendered.push(`--- ${isUser ? 'user' : 'assistant'}${turn}${step}${seq}${time ? ` time=${time}` : ''} ---`)
    rendered.push(all.join('\n\n'))
    rendered.push('')
  }

  const body = rendered.join('\n')
  const maxChars = options.maxChars
  if (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 && body.length > maxChars) {
    const footer = `\n\n[truncated: showing ${maxChars} of ${body.length} characters; pass max_chars <= 0 for the full transcript]`
    return body.slice(0, maxChars) + footer
  }
  if (maxChars <= 0) {
    rendered.push(`transcript: ${messages} message(s), ${turns} user turn(s); complete output requested (${body.length} chars)`)
    return rendered.join('\n')
  }
  return body
}

export function apply(ctx, config = {}) {
  const sessionsRoot = resolve(config.sessionsRoot ?? join(resolveDshHome(config), 'sessions'))

  ctx.tools.register({
    name: 'session_read',
    description:
      'Read another DSH conversation transcript by session id. Use this when the user asks to inspect/continue/read another session. ' +
      'Arguments: session_id (required, e.g. "session-52f79a2a-ce83-4c7c-a85b-329769bb6d7a"); max_chars (optional, <=0 means full); ' +
      'include_reasoning/include_tool_calls/include_tool_results (optional, default false). Returns a bounded text transcript of user and assistant messages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to read, optionally a session directory or .jsonl.zstd path.',
        },
        max_chars: {
          type: 'integer',
          description: `Maximum characters returned (default ${DEFAULT_MAX_CHARS}; <= 0 means full content).`,
        },
        include_reasoning: {
          type: 'boolean',
          description: 'Include model reasoning blocks. Defaults to false because reasoning can be much larger than the conversation.',
        },
        include_tool_calls: {
          type: 'boolean',
          description: 'Include tool call names and arguments. Defaults to false.',
        },
        include_tool_results: {
          type: 'boolean',
          description: 'Include tool result payloads. Defaults to false because tool output can be huge.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (typeof args.session_id !== 'string' || args.session_id.trim() === '') {
        throw new Error('session_id must be a non-empty string')
      }
      exec.signal?.throwIfAborted?.()
      const found = findSessionFile(sessionsRoot, args.session_id.trim())
      const buffer = readFileSync(found.path)
      const raw = decodeSessionLog(buffer)
      const events = parseEvents(raw, found.path)
      const options = {
        sessionId: args.session_id.trim(),
        maxChars: typeof args.max_chars === 'number' ? args.max_chars : DEFAULT_MAX_CHARS,
        includeReasoning: args.include_reasoning === true,
        includeToolCalls: args.include_tool_calls === true,
        includeToolResults: args.include_tool_results === true,
      }
      return renderTranscript(events, found, options)
    },
  })
}
