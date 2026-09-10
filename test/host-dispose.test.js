import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupAutostart } from '../index.js'

const VBS = 'C:\\dsh\\dsh-autostart\\bootstrap.vbs'
const SERVICE_JS = 'C:\\dsh\\node_modules\\dsh-autostart\\service.js'

/** Deps for a run where our own registry entry is present. */
function ourEntry(overrides = {}) {
  return {
    dshHome: 'C:\\dsh',
    serviceJsPath: SERVICE_JS,
    registry: {
      readRunValue: () => `wscript.exe "${VBS}"`,
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
    ...overrides,
  }
}

test('cleanup keeps our entry while the plugin is still installed', () => {
  // Disposal is NOT uninstallation. cordis tears plugin rows down on reload and
  // on a failed load as well, and an autostart entry that vanishes for those
  // reasons silently defeats the feature: the user enables it, something reloads,
  // and at the next login nothing starts. Observed on a real machine after a
  // failed load.
  const removed = []
  cleanupAutostart(
    ourEntry({
      exists: () => true,
      registry: {
        readRunValue: () => `wscript.exe "${VBS}"`,
        removeRunValue: () => removed.push('removed'),
      },
    }),
  )
  assert.deepEqual(removed, [], 'the entry must survive a reload')
})

test('cleanup removes our entry once the plugin is really gone', () => {
  // service.js missing is the evidence of an actual uninstall: the generated
  // bootstrap.vbs and config.json live outside node_modules and would otherwise
  // leave a dangling entry running a script that no longer exists.
  const removed = []
  cleanupAutostart(
    ourEntry({
      exists: () => false,
      registry: {
        readRunValue: () => `wscript.exe "${VBS}"`,
        removeRunValue: () => removed.push('removed'),
      },
    }),
  )
  assert.deepEqual(removed, ['removed'])
})

test('cleanup removes our own entry', () => {
  const removed = []
  cleanupAutostart(
    ourEntry({
      exists: () => false,
      registry: {
        readRunValue: () => `wscript.exe "${VBS}"`,
        removeRunValue: () => removed.push('removed'),
      },
    }),
  )
  assert.deepEqual(removed, ['removed'])
})

test('cleanup leaves a foreign entry alone', () => {
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    serviceJsPath: SERVICE_JS,
    exists: () => false,
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
    serviceJsPath: SERVICE_JS,
    exists: () => false,
    registry: { readRunValue: () => null, removeRunValue: () => removed.push('x') },
  })
  assert.deepEqual(removed, [])
})

test('cleanup is a no-op when the registry cannot be read', () => {
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    serviceJsPath: SERVICE_JS,
    exists: () => false,
    registry: {
      readRunValue: () => {
        throw new Error('reg.exe unavailable')
      },
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
  })
})
