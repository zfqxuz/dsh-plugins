#!/usr/bin/env node
/**
 * Manage dsh-plugins insert blocks inside a DSH home-level cordis.patch.yml
 * without a YAML dependency.
 *
 * Usage:
 *   node tools/patch-blocks.mjs remove <patchFile> <pluginId>
 *   node tools/patch-blocks.mjs has    <patchFile> <pluginId>
 *
 * `remove` deletes, for the given plugin id:
 *   - managed marker ranges "# >>> dsh-plugins: <id> >>>" .. "# <<< ... <<<"
 *   - legacy top-level patch entries mounting `<id>` (unmarked installs),
 *     dropping only that item when a multi-item insert also carries it
 *   - any leftover marker line for `<id>`
 *
 * Comments/blank lines outside the removed entries are preserved, so removing
 * one plugin never eats a neighbouring plugin's markers.
 *
 * No-op when the file does not exist.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [, , command, file, id] = process.argv
if (!['remove', 'has'].includes(command) || !file || !id) {
  console.error('usage: patch-blocks.mjs <remove|has> <patchFile> <pluginId>')
  process.exit(2)
}
if (!existsSync(file)) {
  if (command === 'has') process.exit(1)
  process.exit(0)
}

const text = readFileSync(file, 'utf8')
const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
const begin = `# >>> dsh-plugins: ${id} >>>`
const end = `# <<< dsh-plugins: ${id} <<<`
const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const idRe = new RegExp(`^\\s*- id:\\s*${escaped}\\s*$`)

if (command === 'has') {
  process.exit(lines.some((line) => idRe.test(line)) ? 0 : 1)
}

/** Remove balanced marker ranges, then any leftover marker line for the id. */
function stripMarkers(source) {
  const out = []
  let skipping = false
  for (const line of source) {
    const trimmed = line.trim()
    if (trimmed === begin) {
      skipping = true
      continue
    }
    if (trimmed === end) {
      skipping = false
      continue
    }
    if (skipping) continue
    if (trimmed === begin || trimmed === end) continue
    out.push(line)
  }
  return out
}

/** Drop one `    - id: ...` item and its continuation lines from a block. */
function dropItem(block) {
  const out = []
  let dropping = false
  for (const line of block) {
    if (idRe.test(line)) {
      dropping = true
      continue
    }
    if (dropping) {
      if (/^    - /.test(line)) dropping = false
      else if (/^\s{6,}\S/.test(line) || line.trim() === '') continue
      else dropping = false
    }
    out.push(line)
  }
  return out
}

/**
 * Walk top-level YAML entries (a line starting with "- ") and drop the ones
 * that mount this id. Everything outside those entries is emitted unchanged.
 */
function removeLegacyEntries(source) {
  const out = []
  let index = 0
  while (index < source.length) {
    const line = source[index]
    if (!/^- /.test(line)) {
      out.push(line)
      index += 1
      continue
    }
    let end = index + 1
    // Stop at the next top-level entry OR at the next managed block marker:
    // comment lines before a following entry belong to that entry, not this one.
    while (end < source.length && !/^- /.test(source[end]) && !/^# >>> dsh-plugins:/.test(source[end])) end += 1
    const block = source.slice(index, end)
    const mountsId = block.some((entry) => idRe.test(entry))
    if (!mountsId) {
      out.push(...block)
    } else if (block.filter((entry) => /^    - /.test(entry)).length > 1) {
      const reduced = dropItem(block)
      if (reduced.some((entry) => /^- /.test(entry))) out.push(...reduced)
    }
    index = end
  }
  return out
}

const result = removeLegacyEntries(stripMarkers(lines))
// Collapse runs of 3+ blank lines left behind by removals, then trim trailing.
const collapsed = []
let blankRun = 0
for (const line of result) {
  if (line.trim() === '') {
    blankRun += 1
    if (blankRun > 2) continue
  } else {
    blankRun = 0
  }
  collapsed.push(line)
}
while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') collapsed.pop()
writeFileSync(file, `${collapsed.join('\n')}\n`)
