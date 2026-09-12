import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForProcessExit, defaultIsAlive, main } from '../service.js'

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

test('main treats start as an alias for supervise so existing installs keep working', async () => {
  // bootstrap.vbs is generated at enable time and snapshots `service.js start --config …`,
  // so an upgrade must not require the user to re-enable autostart.
  const calls = []
  await main(['node', 'service.js', 'start'], {
    configPath: 'test/fixtures/config.json',
    runSupervise: async (input) => {
      calls.push(input)
      return { supervised: true, pid: 1 }
    },
    // Nested: `deps` is the seam bag main forwards to the mode implementation. The guard is
    // refused so a regression that reached the real supervisor could not poll the live port
    // (127.0.0.1:3080) for the whole 3000ms probe window before this test failed.
    deps: { anotherSupervisorAlive: () => true },
  })
  assert.equal(calls.length, 1)
  // The requested config path is what main resolved and handed over, not a re-derived home.
  assert.equal(calls[0].configPath, 'test/fixtures/config.json')
  assert.equal(calls[0].takeoverPid, null, 'a bare start asks for no takeover')
})

test('main resolves supervise as the real entry point', async () => {
  // The other half of the alias: naming the mode explicitly must reach the same function.
  // `--takeover <pid>` is parsed here rather than in the alias test, because that is the shape
  // the launch helper actually generates and the flag is new in this task.
  const calls = []
  await main(['node', 'service.js', 'supervise', '--takeover', '4321'], {
    configPath: 'test/fixtures/config.json',
    runSupervise: async (input) => {
      calls.push(input)
      return { supervised: true, pid: 1 }
    },
    deps: { anotherSupervisorAlive: () => true },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].takeoverPid, 4321)
})

test('main refuses a --takeover that is not a positive integer', async () => {
  // The value reaches runSupervise and then a pid wait, so a malformed one must be refused
  // rather than coerced. Number('421x') is NaN and a negative pid is nonsense.
  for (const bad of ['abc', '0', '-1', '1.5']) {
    let called = false
    const code = await main(['node', 'service.js', 'supervise', '--takeover', bad], {
      configPath: 'test/fixtures/config.json',
      runSupervise: async () => {
        called = true
        return { supervised: true, pid: 1 }
      },
      deps: { anotherSupervisorAlive: () => true },
    })
    assert.equal(code, 2, `expected --takeover ${bad} to be refused`)
    assert.equal(called, false, 'a refused --takeover must not reach the supervisor')
  }
})

test('main rejects the removed restart mode', async () => {
  // `restart --pid <n>` was the WMI-relay contract; supervise with --takeover replaced it.
  // Refusing loudly beats silently doing nothing, which would leave DSH down with no clue.
  //
  // The pid below is a placeholder from the brief and the mode must be refused before anything
  // can wait on it: this test may never depend on the liveness of a real pid (pid 5 is the
  // Windows idle process, i.e. always "alive"), or a regression would poll the machine's
  // process table for the whole waitForExitMs instead of failing on the exit code. That is the
  // failure mode this test exists to catch, so the seam is poisoned to make it unreachable.
  const code = await main(['node', 'service.js', 'restart', '--pid', '5'], {
    configPath: 'test/fixtures/config.json',
    deps: {
      waitForProcessExit: async () => {
        throw new Error('restart must be refused before any pid is waited on')
      },
    },
  })
  assert.equal(code, 2, 'restart is gone; refusing loudly beats silently doing nothing')
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
