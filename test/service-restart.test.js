import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForProcessExit, runRestart, defaultIsAlive, main } from '../service.js'

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    dshPort: 3080,
    hookScript: '',
    startTimeoutMs: 500,
    waitForExitMs: 500,
    logPaths: { out: 'out.log', err: 'err.log', service: 'service.log' },
    ...overrides,
  }
}

// A stand-in for the ChildProcess handle spawnDsh returns (it returns the handle, not the pid,
// so the supervisor can learn of the exit by event). See service-start.test.js for the fuller
// helper; this file only needs the pid and the `once`/`unref` shape spawnDsh touches.
function fakeChild(pid) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once() { return this },
    unref() {},
  }
}

test('waitForProcessExit returns true as soon as the pid is gone', async () => {
  let calls = 0
  const alive = await waitForProcessExit(1, {
    timeoutMs: 1000,
    intervalMs: 10,
    isAlive: () => {
      calls += 1
      return calls < 3
    },
  })
  assert.equal(alive, true)
  assert.equal(calls, 3)
})

test('waitForProcessExit returns false on timeout', async () => {
  const gone = await waitForProcessExit(1, {
    timeoutMs: 60,
    intervalMs: 10,
    isAlive: () => true,
  })
  assert.equal(gone, false)
})

test('runRestart waits for exit, then starts and hooks', async () => {
  const order = []
  const result = await runRestart({
    config: baseConfig(),
    oldPid: 999,
    log: () => {},
    deps: {
      waitForProcessExit: async () => {
        order.push('waitExit')
        return true
      },
      isPortListening: async () => false,
      waitForPort: async () => {
        order.push('waitPort')
        return true
      },
      spawnDsh: () => {
        order.push('spawn')
        return fakeChild(555)
      },
      runHook: async () => {
        order.push('hook')
        return { ran: false }
      },
    },
  })
  assert.deepEqual(order, ['waitExit', 'spawn', 'waitPort', 'hook'])
  assert.deepEqual(result, { restarted: true, started: true, pid: 555, up: true })
})

test('runRestart aborts without spawning when the old process never exits', async () => {
  const lines = []
  const result = await runRestart({
    config: baseConfig(),
    oldPid: 999,
    log: (line) => lines.push(line),
    deps: {
      waitForProcessExit: async () => false,
      spawnDsh: () => {
        throw new Error('must not spawn a second instance')
      },
    },
  })
  assert.deepEqual(result, { restarted: false })
  assert.match(lines.join('\n'), /aborting restart/)
})

test('main rejects restart without a --pid', async () => {
  const code = await main(['node', 'service.js', 'restart'], {
    configPath: 'test/fixtures/config.json',
  })
  assert.equal(code, 2)
})

test('defaultIsAlive treats only ESRCH as gone', () => {
  // All three killers are injected, so this test probes no real process.
  const alive = () => {}
  const esrch = () => {
    const error = new Error('no such process')
    error.code = 'ESRCH'
    throw error
  }
  const eperm = () => {
    const error = new Error('operation not permitted')
    error.code = 'EPERM'
    throw error
  }
  assert.equal(defaultIsAlive(1, alive), true)
  assert.equal(defaultIsAlive(1, esrch), false)
  // EPERM means the process exists but may not be signalled: reporting it as
  // gone would skip the abort and could start a second instance.
  assert.equal(defaultIsAlive(1, eperm), true)
})
