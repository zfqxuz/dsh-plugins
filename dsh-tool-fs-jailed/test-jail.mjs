#!/usr/bin/env node
/**
 * Unit tests for dsh-tool-fs-jailed. No DSH runtime needed: the plugin is
 * loaded with a fake context that only implements the `tools` service.
 *
 * Usage: node test-jail.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'jail-test-'))
const root = join(sandbox, 'root')
const outside = join(sandbox, 'outside')
const sibling = join(sandbox, 'root-sibling')

mkdirSync(join(root, 'docs'), { recursive: true })
mkdirSync(join(root, '.git'), { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(sibling, { recursive: true })

writeFileSync(join(root, 'hello.txt'), 'line one\nline two\nline three\n')
writeFileSync(join(root, 'docs', 'guide.md'), '# guide\nsecret-ish keyword here\n')
writeFileSync(join(root, '.git', 'config'), 'keyword should not appear\n')
writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n')
writeFileSync(join(sibling, 'secret2.txt'), 'SIBLING SECRET\n')
symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-link.txt'))

// Register the plugin against a minimal fake ctx.
const tools = new Map()
const ctx = {
  logger: { warn: () => {} },
  tools: { register: (definition) => tools.set(definition.name, definition) },
}
apply(ctx, { root })

assert.deepEqual([...tools.keys()].sort(), ['glob', 'grep', 'read'])

const call = async (name, args) => tools.get(name).execute(args, { signal: undefined })

let passed = 0
async function ok(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}
async function rejects(label, fn, pattern) {
  await assert.rejects(fn, (error) => {
    assert.match(error.message, pattern, `${label}: unexpected message: ${error.message}`)
    return true
  })
  passed += 1
  console.log(`  ok  ${label} (rejected)`)
}

console.log('jaw jail unit tests')

await ok('read inside root', async () => {
  const text = await call('read', { file_path: 'hello.txt' })
  assert.match(text, /1: line one/)
  assert.match(text, /3: line three/)
  assert.match(text, /End of file - total 4 lines/)
})

await ok('read with offset/limit', async () => {
  const text = await call('read', { file_path: 'hello.txt', offset: 2, limit: 1 })
  assert.match(text, /2: line two/)
  assert.doesNotMatch(text, /1: line one/)
  assert.match(text, /\(Showing lines 2-2 of 4\. Use offset=3 to continue\.\)/)
})

await rejects('read absolute path outside root', () => call('read', { file_path: join(outside, 'secret.txt') }), /outside the allowed root/)
await rejects('read .. escape', () => call('read', { file_path: '../outside/secret.txt' }), /outside the allowed root/)
await rejects('read sibling prefix trap', () => call('read', { file_path: join(sibling, 'secret2.txt') }), /outside the allowed root/)
await rejects('read via symlink escape', () => call('read', { file_path: 'escape-link.txt' }), /outside the allowed root/)
await rejects('read /etc/passwd', () => call('read', { file_path: '/etc/passwd' }), /outside the allowed root/)
await rejects('read missing file', () => call('read', { file_path: 'nope.txt' }), /not found/)
await rejects('read directory', () => call('read', { file_path: 'docs' }), /not a regular file/)
await rejects('read empty path', () => call('read', { file_path: '  ' }), /non-empty string/)

await ok('glob matches recursively, relative, exclusions', async () => {
  const text = await call('glob', { pattern: '**/*.md' })
  assert.match(text, /docs\/guide\.md/)
  assert.doesNotMatch(text, /\.git/)
})

await ok('glob basename pattern at any depth', async () => {
  const text = await call('glob', { pattern: '*.md' })
  assert.match(text, /docs\/guide\.md/)
})

await rejects('glob path escape', () => call('glob', { pattern: '*', path: '../outside' }), /outside the allowed root/)

await ok('grep finds matches with line numbers', async () => {
  const text = await call('grep', { pattern: 'keyword' })
  assert.match(text, /> docs\/guide\.md/)
  assert.match(text, /Line 2: secret-ish keyword here/)
  assert.doesNotMatch(text, /\.git/)
})

await ok('grep include filter', async () => {
  const text = await call('grep', { pattern: 'keyword', include: '*.txt' })
  assert.match(text, /No matches/)
})

await rejects('grep include rejects negated/comma lists', () => call('grep', { pattern: 'x', include: '!*.md' }), /single positive glob/)
await rejects('grep invalid regex', () => call('grep', { pattern: '(' }), /invalid regular expression/)

// Fail-closed behaviour when the configured root does not exist.
const tools2 = new Map()
apply({ logger: { warn: () => {} }, tools: { register: (d) => tools2.set(d.name, d) } }, { root: join(sandbox, 'does-not-exist') })
await rejects('unavailable root refuses reads', () => tools2.get('read').execute({ file_path: 'x' }, {}), /not available/)

// ------------------------------------------------------------------ extra roots
// 一个只读会话可能需要"自己的目录 + 共享只读区"两块地方。两块根不能拍平成一个
// （相对路径会静默改投），所以共享区用显式前缀寻址：shared/xxx。
const shared = join(sandbox, 'shared')
mkdirSync(join(shared, 'docs'), { recursive: true })
writeFileSync(join(shared, 'rules.md'), '群规第一条：不要刷屏\n')
writeFileSync(join(shared, 'docs', 'toc.md'), '目录页 keyword\n')
writeFileSync(join(outside, 'secret3.txt'), 'EXTRA SECRET\n')
symlinkSync(join(outside, 'secret3.txt'), join(shared, 'escape2.txt'))

const tools3 = new Map()
apply(
  { logger: { warn: () => {} }, tools: { register: (d) => tools3.set(d.name, d) } },
  { root, extraRoots: [{ prefix: 'shared', root: shared }, { prefix: '', root: '/nope' }] },
)
const call3 = async (name, args) => tools3.get(name).execute(args, { signal: undefined })

await ok('extra root: read through the prefix', async () => {
  const text = await call3('read', { file_path: 'shared/rules.md' })
  assert.match(text, /群规第一条/)
})
await ok('extra root: read tool description advertises the prefix', async () => {
  assert.match(tools3.get('read').description, /shared\//)
})
await ok('extra root: glob on the prefix returns prefixed display paths', async () => {
  const text = await call3('glob', { pattern: '**/*.md', path: 'shared' })
  assert.match(text, /^shared\/docs\/toc\.md$/m)
  assert.match(text, /^shared\/rules\.md$/m)
})
await ok('extra root: grep on the prefix', async () => {
  const text = await call3('grep', { pattern: 'keyword', path: 'shared' })
  assert.match(text, /> shared\/docs\/toc\.md/)
})
await ok('primary root stays separate: default glob does not see the shared area', async () => {
  const text = await call3('glob', { pattern: '**/*.md' })
  assert.doesNotMatch(text, /shared\//)
  assert.match(text, /docs\/guide\.md/)
})
await ok('absolute path into an extra root is accepted and reported with its prefix', async () => {
  const text = await call3('read', { file_path: join(shared, 'rules.md') })
  assert.match(text, /群规第一条/)
})
await rejects('extra root: prefix escape is rejected', () => call3('read', { file_path: 'shared/../outside/secret.txt' }), /outside the allowed root/)
await rejects('extra root: symlink escape inside the shared area is rejected', () => call3('read', { file_path: 'shared/escape2.txt' }), /outside the allowed root/)
await rejects('extra root does not widen the primary jail', () => call3('read', { file_path: '../outside/secret.txt' }), /outside the allowed root/)
await rejects('empty prefix entries are ignored', () => call3('read', { file_path: '/nope/x' }), /outside the allowed root/)

// 共享区不存在时只警告，主根照常能用（fail-open 到"少一块地方"，不是整个会话读不了）
const tools4 = new Map()
const warnings = []
apply(
  { logger: { warn: (line) => warnings.push(String(line)) }, tools: { register: (d) => tools4.set(d.name, d) } },
  { root, extraRoots: [{ prefix: 'shared', root: join(sandbox, 'shared-missing') }] },
)
await ok('unavailable extra root still lets the primary root work', async () => {
  const text = await tools4.get('read').execute({ file_path: 'hello.txt' }, {})
  assert.match(text, /line one/)
  assert.ok(warnings.some((line) => line.includes('extra root unavailable')), warnings.join(' | '))
})
await rejects('unavailable extra root refuses that area', () => tools4.get('read').execute({ file_path: 'shared/x.md' }, {}), /not available/)

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
