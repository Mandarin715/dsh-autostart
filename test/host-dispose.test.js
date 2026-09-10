import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupAutostart } from '../index.js'

const VBS = 'C:\\dsh\\dsh-autostart\\bootstrap.vbs'

test('cleanup removes our own entry', () => {
  const removed = []
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => `wscript.exe "${VBS}"`,
      removeRunValue: () => removed.push('removed'),
    },
  })
  assert.deepEqual(removed, ['removed'])
})

test('cleanup leaves a foreign entry alone', () => {
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => '"C:\\other\\x.exe"',
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
  })
})

test('cleanup is a no-op when no entry exists', () => {
  const removed = []
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: { readRunValue: () => null, removeRunValue: () => removed.push('x') },
  })
  assert.deepEqual(removed, [])
})
