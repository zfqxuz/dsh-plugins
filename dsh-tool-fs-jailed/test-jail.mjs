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

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
