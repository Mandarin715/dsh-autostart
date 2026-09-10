import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_KEY,
  RUN_VALUE_NAME,
  registryCommand,
  isOurEntry,
  readRunValue,
  writeRunValue,
  removeRunValue,
} from '../lib/registry.js'

test('registryCommand points wscript at the generated vbs', () => {
  assert.equal(
    registryCommand('C:\\Users\\me\\.dsh\\dsh-autostart\\bootstrap.vbs'),
    'wscript.exe "C:\\Users\\me\\.dsh\\dsh-autostart\\bootstrap.vbs"',
  )
})

test('isOurEntry only accepts our own vbs path', () => {
  const vbs = 'C:\\a\\bootstrap.vbs'
  assert.equal(isOurEntry(registryCommand(vbs), vbs), true)
  assert.equal(isOurEntry('wscript.exe "C:\\other\\bootstrap.vbs"', vbs), false)
  assert.equal(isOurEntry('"C:\\somewhere\\else.exe"', vbs), false)
  assert.equal(isOurEntry(null, vbs), false)
})

test('isOurEntry is case insensitive about the path', () => {
  const vbs = 'C:\\A\\Bootstrap.vbs'
  assert.equal(isOurEntry('wscript.exe "c:\\a\\bootstrap.VBS"', vbs), true)
})

test('readRunValue returns the value and tolerates a missing entry', () => {
  const present = () => 'HKEY_CURRENT_USER\\...\\Run\r\n    DSH autostart    REG_SZ    wscript.exe "C:\\a\\bootstrap.vbs"\r\n\r\n'
  const absent = () => {
    const error = new Error('reg exited 1')
    throw error
  }
  assert.equal(readRunValue(present), 'wscript.exe "C:\\a\\bootstrap.vbs"')
  assert.equal(readRunValue(absent), null)
})

test('writeRunValue issues reg add with the right key, name and data', () => {
  const calls = []
  writeRunValue('C:\\a\\bootstrap.vbs', (args) => {
    calls.push(args)
    return ''
  })
  assert.deepEqual(calls, [
    ['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', 'wscript.exe "C:\\a\\bootstrap.vbs"', '/f'],
  ])
})

test('removeRunValue issues reg delete', () => {
  const calls = []
  removeRunValue((args) => {
    calls.push(args)
    return ''
  })
  assert.deepEqual(calls, [['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f']])
})

test('removeRunValue tolerates a missing entry', () => {
  assert.doesNotThrow(() =>
    removeRunValue(() => {
      throw new Error('reg exited 1')
    }),
  )
})
