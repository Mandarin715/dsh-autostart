import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArgv, detectCommand } from '../lib/detect-command.js'

test('normalizeArgv appends --no-open when the browser must stay closed', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web'], { openBrowser: false }), [
    'bin.js',
    'web',
    '--no-open',
  ])
})

test('normalizeArgv keeps an existing --no-open exactly once', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web', '--no-open'], { openBrowser: false }), [
    'bin.js',
    'web',
    '--no-open',
  ])
})

test('normalizeArgv removes --no-open when the browser should open', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web', '--no-open'], { openBrowser: true }), [
    'bin.js',
    'web',
  ])
})

test('normalizeArgv preserves unrelated flags', () => {
  assert.deepEqual(
    normalizeArgv(['bin.js', 'web', '--trusted-host', 'example.com'], { openBrowser: false }),
    ['bin.js', 'web', '--trusted-host', 'example.com', '--no-open'],
  )
})

test('detectCommand returns the normalized triple', () => {
  const command = detectCommand({
    execPath: 'C:\\node.exe',
    argv: ['C:\\bin.js', 'web'],
    cwd: 'C:\\work',
    openBrowser: false,
  })
  assert.deepEqual(command, {
    execPath: 'C:\\node.exe',
    argv: ['C:\\bin.js', 'web', '--no-open'],
    cwd: 'C:\\work',
  })
})

test('detectCommand rejects incomplete input', () => {
  assert.throws(() => detectCommand({ argv: ['a'], cwd: 'c' }), /execPath/)
  assert.throws(() => detectCommand({ execPath: 'a', cwd: 'c' }), /argv/)
  assert.throws(() => detectCommand({ execPath: 'a', argv: ['b'] }), /cwd/)
})
