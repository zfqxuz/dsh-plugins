/**
 * DSH plugin: root-confined, read-only filesystem tools.
 *
 * Provides `read` / `glob` / `grep` for sessions that must not see anything
 * outside one allowed directory. Mount it in a read-only preset; it never
 * writes, executes, or delegates to a shell.
 *
 * Why this exists: DSH's own `fs-local` treats `cwd` as a resolution default,
 * not a boundary (absolute paths and `..` are unrestricted), and
 * `dsh-fs-sandbox` confines only mutations — reads stay host-wide. A
 * white-listed read tool is therefore the only way to deny reads.
 *
 * No third-party dependency is imported: only node builtins.
 */

import {
  existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'tool-fs-jailed'
export const inject = ['tools']

const DEFAULTS = {
  readLimit: 2000,
  readMaxLineLength: 2000,
  readMaxBytes: 51200,
  globMaxResults: 100,
  grepMaxResults: 250,
  walkMaxEntries: 20000,
}

const SKIP_DIRS = new Set(['.git'])

/* ------------------------------------------------------------------ paths */

/**
 * Resolve the deepest existing ancestor of a path and re-apply the missing
 * suffix, so that symlinked ancestors cannot smuggle a target outside the root.
 */
function realCandidate(abs) {
  const suffix = []
  let probe = abs
  for (;;) {
    if (existsSync(probe)) break
    const parent = dirname(probe)
    if (parent === probe) break
    suffix.unshift(basename(probe))
    probe = parent
  }
  const base = realpathSync(probe)
  return suffix.length > 0 ? resolve(base, ...suffix) : base
}

/** True when `candidate` is the root itself or lives below it. */
function insideRoot(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Build a path guard bound to one root.
 * @param displayRoot - the root as configured, used to brand error messages.
 * @returns `resolve` (returns { real, display }) and `root`.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function createJail(displayRoot) {
  let root
  let available = true
  try {
    root = realpathSync(expandHome(displayRoot))
  } catch {
    root = undefined
    available = false
  }

  const fail = (requested, reason) => {
    // Never echo the resolved absolute path: the guest must not learn it.
    throw new Error(`cannot read "${requested}": ${reason}`)
  }

  return {
    get root() { return root },
    get available() { return available },
    get displayRoot() { return displayRoot },

    /** Resolve a model-supplied path, rejecting anything outside the root. */
    resolve(requested) {
      if (typeof requested !== 'string' || requested.trim() === '') fail(requested, 'file_path must be a non-empty string')
      if (!available) fail(requested, 'the allowed root is not available on this host')
      const raw = requested.trim()
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
      let real
      try {
        real = realCandidate(abs)
      } catch (error) {
        fail(raw, error?.code === 'ENOENT' ? 'not found' : (error?.message ?? 'cannot be resolved'))
      }
      if (!insideRoot(root, real)) fail(raw, 'outside the allowed root')
      const display = relative(root, real) === '' ? '.' : relative(root, real)
      return { real, display: display.split(sep).join('/') }
    },

    /** Resolve a directory argument that defaults to the root. */
    resolveDir(requested) {
      if (requested === undefined) return { real: root, display: '.' }
      return this.resolve(requested)
    },
  }
}

/* ------------------------------------------------------------------- glob */

function segmentMatch(segment, value) {
  let re = '^'
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1)
      if (close === -1) re += '\\['
      else {
        let body = segment.slice(i + 1, close)
        if (body.startsWith('!')) body = '^' + body.slice(1)
        re += `[${body}]`
        i = close
      }
    } else if ('\\^$.|+(){}'.includes(ch)) re += `\\${ch}`
    else re += ch
  }
  return new RegExp(`${re}$`).test(value)
}

function matchSegments(parts, pi, target, ti) {
  if (pi === parts.length) return ti === target.length
  if (parts[pi] === '**') {
    for (let k = ti; k <= target.length; k += 1) {
      if (matchSegments(parts, pi + 1, target, k)) return true
    }
    return false
  }
  if (ti >= target.length) return false
  if (!segmentMatch(parts[pi], target[ti])) return false
  return matchSegments(parts, pi + 1, target, ti + 1)
}

/** Match a root-relative POSIX path against a glob pattern. */
function matchGlob(pattern, relativePath) {
  const parts = pattern.split('/').filter((part) => part !== '')
  const target = relativePath.split('/').filter((part) => part !== '')
  if (parts.length === 0) return false
  if (!pattern.includes('/')) {
    // A pattern with no separator matches a basename at any depth.
    return target.some((seg) => segmentMatch(parts[0], seg))
  }
  return matchSegments(parts, 0, target, 0)
}

/**
 * Walk a directory tree without ever leaving the jail: symlinked directories
 * are resolved and skipped when they point outside.
 */
function walk(jail, startReal, limits, onFile) {
  const queue = [startReal]
  let visited = 0
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= limits.walkMaxEntries) return { truncated: true }
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        let real
        try { real = realpathSync(abs) } catch { continue }
        if (!insideRoot(jail.root, real)) continue
        queue.push(real)
        continue
      }
      if (entry.isSymbolicLink()) {
        let stat
        try { stat = statSync(abs) } catch { continue }
        if (!stat.isFile()) continue
        let real
        try { real = realpathSync(abs) } catch { continue }
        if (!insideRoot(jail.root, real)) continue
        visited += 1
        if (onFile(abs, real) === false) return { truncated: false, stopped: true }
        continue
      }
      if (!entry.isFile()) continue
      visited += 1
      if (onFile(abs, abs) === false) return { truncated: false, stopped: true }
    }
  }
  return { truncated: false }
}

/* ------------------------------------------------------------------ tools */

function textOutput(text) {
  return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

export function apply(ctx, config = {}) {
  const configuredRoot = typeof config.root === 'string' && config.root.trim() !== '' ? config.root.trim() : undefined
  const displayRoot = configuredRoot ?? '(unset — refusing every call)'
  const limits = { ...DEFAULTS, ...Object.fromEntries(
    Object.entries(config).filter(([key]) => key in DEFAULTS && typeof config[key] === 'number'),
  ) }
  const jail = createJail(configuredRoot ?? '')
  if (!jail.available) {
    ctx.logger?.warn?.(`[tool-fs-jailed] allowed root unavailable: ${displayRoot} — all reads will be refused`)
  }

  ctx.tools.register({
    name: 'read',
    description:
      `Read a UTF-8 text file with line numbers. Read-only and confined to the allowed directory (${displayRoot}); ` +
      'paths outside it are refused. Arguments: file_path (required, absolute or relative to the allowed directory); ' +
      'offset (optional, 1-based first line); limit (optional, max lines).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'Path to the file, inside the allowed directory.' },
        offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'integer', description: `Maximum number of lines to return. Defaults to ${limits.readLimit}.` },
      },
      required: ['file_path'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const requested = requireString(args.file_path, 'file_path')
      const target = jail.resolve(requested)
      let info
      try {
        info = statSync(target.real)
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`cannot read "${requested}": not found`)
        throw new Error(`cannot read "${requested}": ${error?.message ?? 'unknown error'}`)
      }
      if (!info.isFile()) throw new Error(`cannot read "${requested}": not a regular file`)

      let raw
      try {
        raw = readFileSync(target.real)
      } catch (error) {
        throw new Error(`cannot read "${requested}": ${error?.message ?? 'unknown error'}`)
      }
      if (raw.includes(0)) throw new Error(`cannot read "${requested}": not a UTF-8 text file`)

      const allLines = raw.toString('utf8').split('\n')
      const total = allLines.length
      const first = Math.max(1, Number.isFinite(args.offset) ? Math.trunc(args.offset) : 1)
      const wanted = Number.isFinite(args.limit) ? Math.trunc(args.limit) : limits.readLimit
      const maxLines = Math.min(Math.max(1, wanted), limits.readLimit)
      const window = allLines.slice(first - 1, first - 1 + maxLines)

      const out = []
      let bytes = 0
      let shown = 0
      for (let i = 0; i < window.length; i += 1) {
        let line = window[i]
        if (line.length > limits.readMaxLineLength) line = `${line.slice(0, limits.readMaxLineLength)}... [truncated]`
        const rendered = `${first + i}: ${line}`
        bytes += Buffer.byteLength(rendered, 'utf8')
        if (bytes > limits.readMaxBytes && shown > 0) break
        out.push(rendered)
        shown += 1
      }

      const last = first + shown - 1
      if (shown === 0) {
        out.push(first > total
          ? `(offset ${first} is past the end of file; total ${total} lines)`
          : '(no content)')
      } else if (last < total) {
        out.push('')
        out.push(`(Showing lines ${first}-${last} of ${total}. Use offset=${last + 1} to continue.)`)
      } else {
        out.push('')
        out.push(`(End of file - total ${total} lines)`)
      }
      return out.join('\n')
    },
  })

  ctx.tools.register({
    name: 'glob',
    description:
      `Find files whose paths match a glob pattern. Read-only and confined to the allowed directory (${displayRoot}). ` +
      'A pattern with no "/" matches basenames at any depth; "**" matches across directories. ' +
      'Results are paths relative to the allowed directory, most recently modified first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "*.md", "src/**/*.ts".' },
        path: { type: 'string', description: 'Directory to search, inside the allowed directory. Defaults to the root.' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const pattern = requireString(args.pattern, 'pattern')
      const base = jail.resolveDir(args.path === undefined ? undefined : requireString(args.path, 'path'))
      let info
      try { info = statSync(base.real) } catch { throw new Error(`cannot read "${args.path ?? '.'}": not found`) }
      if (!info.isDirectory()) throw new Error(`cannot read "${args.path ?? '.'}": not a directory`)

      const hits = []
      walk(jail, base.real, limits, (abs, real) => {
        const rel = relative(jail.root, real).split(sep).join('/')
        if (!matchGlob(pattern, rel)) return true
        let stat
        try { stat = statSync(real) } catch { return true }
        hits.push({ rel, mtime: stat.mtimeMs })
        return true
      })
      hits.sort((a, b) => b.mtime - a.mtime)
      if (hits.length === 0) return `No files matched "${pattern}" under ${base.display}.`
      const shown = hits.slice(0, limits.globMaxResults)
      const lines = shown.map((hit) => hit.rel)
      if (hits.length > shown.length) {
        lines.push('')
        lines.push(`(Showing ${shown.length} of ${hits.length} paths; narrow the pattern to see the rest.)`)
      }
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'grep',
    description:
      `Search file contents with a regular expression. Read-only and confined to the allowed directory (${displayRoot}). ` +
      'Returns matches grouped by file as "Line N: <preview>". Arguments: pattern (required regex); path (optional directory); ' +
      'include (optional single positive glob such as "*.md").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search, inside the allowed directory. Defaults to the root.' },
        include: { type: 'string', description: 'One positive glob filter for file names, e.g. "*.ts".' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const source = requireString(args.pattern, 'pattern')
      const include = args.include === undefined ? undefined : requireString(args.include, 'include')
      if (include !== undefined && (include.includes(',') || include.startsWith('!'))) {
        throw new Error('include must be a single positive glob (comma-separated lists and negated values are not supported)')
      }
      let regex
      try {
        regex = new RegExp(source)
      } catch (error) {
        throw new Error(`invalid regular expression: ${error?.message ?? source}`)
      }
      const base = jail.resolveDir(args.path === undefined ? undefined : requireString(args.path, 'path'))
      let info
      try { info = statSync(base.real) } catch { throw new Error(`cannot read "${args.path ?? '.'}": not found`) }
      if (!info.isDirectory()) throw new Error(`cannot read "${args.path ?? '.'}": not a directory`)

      const groups = []
      let total = 0
      let capped = false
      walk(jail, base.real, limits, (abs, real) => {
        const rel = relative(jail.root, real).split(sep).join('/')
        if (include !== undefined && !matchGlob(include, rel)) return true
        let stat
        try { stat = statSync(real) } catch { return true }
        if (stat.size > 2 * 1024 * 1024) return true
        let data
        try { data = readFileSync(real) } catch { return true }
        if (data.includes(0)) return true
        const lines = data.toString('utf8').split('\n')
        const found = []
        for (let i = 0; i < lines.length; i += 1) {
          if (!regex.test(lines[i])) continue
          const preview = lines[i].length > 300 ? `${lines[i].slice(0, 300)}...` : lines[i]
          found.push(`Line ${i + 1}: ${preview}`)
          total += 1
          if (total >= limits.grepMaxResults) { capped = true; break }
        }
        if (found.length > 0) groups.push({ rel, found })
        return !capped
      })

      if (groups.length === 0) return `No matches for /${source}/ under ${base.display}.`
      const out = []
      for (const group of groups) {
        out.push(`> ${group.rel}`)
        out.push(...group.found)
        out.push('')
      }
      if (capped) out.push(`(Showing the first ${limits.grepMaxResults} matches; narrow the pattern to see more.)`)
      return out.join('\n').trimEnd()
    },
  })
}
