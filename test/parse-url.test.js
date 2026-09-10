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
