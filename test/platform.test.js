import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedPlatform, unsupportedReason } from '../lib/platform.js'

test('win32 is supported', () => {
  assert.equal(isSupportedPlatform('win32'), true)
})

test('other platforms are not supported', () => {
  for (const p of ['darwin', 'linux', 'freebsd']) {
    assert.equal(isSupportedPlatform(p), false)
  }
})

test('unsupportedReason names the current platform', () => {
  const reason = unsupportedReason('linux')
  assert.match(reason, /Windows/)
  assert.match(reason, /linux/)
})

test('defaults to the real platform', () => {
  assert.equal(isSupportedPlatform(), process.platform === 'win32')
})
