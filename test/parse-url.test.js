import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLatestAccessUrl } from '../lib/parse-url.js'

test('extracts the token URL', () => {
  const log = 'dsh web: http://127.0.0.1:3080/?token=abcDEF_123-xyz\n'
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=abcDEF_123-xyz')
})

test('returns the LAST url when the log holds several runs', () => {
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=first',
    'starting up',
    'dsh web: http://127.0.0.1:3080/?token=second',
    '',
  ].join('\r\n')
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=second')
})

test('stops at the LAN suffix that follows the url', () => {
  const log = 'dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.5:3080/?token=def)\n'
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=abc')
})

test('returns null when there is no match', () => {
  assert.equal(parseLatestAccessUrl('nothing here'), null)
  assert.equal(parseLatestAccessUrl(''), null)
  assert.equal(parseLatestAccessUrl(undefined), null)
})

test('ignores a trailing partial line so a mid-write read cannot yield a truncated token', () => {
  // The log is captured while DSH writes it: the tail can be half a line, and
  // the token in it would be a prefix of the real one.
  const partial = 'dsh web: http://127.0.0.1:3080/?token=realToken\nstarting up\ndsh web: http://127.0.0.1:3080/?token=realTo'
  assert.equal(parseLatestAccessUrl(partial), null)
})

test('does not fall back to an older URL while the newest line is still being written', () => {
  // Showing the previous run's token would be a wrong URL that the browser
  // cannot use (DSH mints a new token per process), so "not captured yet" is
  // the honest answer until the newest line is flushed.
  const log = 'dsh web: http://127.0.0.1:3080/?token=stale\ndsh web: http://127.0.0.1:3080/?to'
  assert.equal(parseLatestAccessUrl(log), null)
})

test('treats an unterminated final line as not yet complete', () => {
  assert.equal(parseLatestAccessUrl('dsh web: http://127.0.0.1:3080/?token=abc'), null)
})
