import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runStart, runSupervise, runHook, spawnDsh, scheduleSecondChance, main } from '../service.js'
import { readPid, writePid, writeRestartRequest } from '../lib/supervise-state.js'

// A stand-in for the ChildProcess handle spawnDsh returns. `once` records subscriptions so a
// test can prove the supervisor listened for 'exit' instead of polling the pid.
//
// The default child exits on the next turn, because the default exit wait is now an event and a
// handle that never emits would block the loop forever. That is the truth for the loop tests:
// their child is a child that runs and then ends. Two other kinds are named explicitly:
//   fakeChild(pid, { exit: false }) -- still running; the test fires it by hand with close().
//   exitedChild(pid)               -- already dead before anyone could subscribe (no replay).
function fakeChild(childPid, { exit = true } = {}) {
  const child = {
    pid: childPid,
    exitCode: null,
    signalCode: null,
    subscriptions: [],
    once(event, handler) {
      this.subscriptions.push(event)
      if (event === 'exit') {
        this.onExit = handler
        if (exit) setImmediate(() => this.close())
      }
      return this
    },
    close() {
      this.exitCode = 0
      this.onExit?.()
    },
  }
  return child
}

// A handle for a child that died while runSupervise was still in its port wait or hook, so its
// 'exit' event was emitted before anyone could subscribe — and Node never replays it. `once('exit')`
// therefore records the subscription but never calls it, which is exactly the hang the
// exitCode/signalCode guard in superviseChild exists to prevent.
function exitedChild(childPid) {
  const child = fakeChild(childPid, { exit: false })
  child.exitCode = 0
  return child
}

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    dshPort: 3080,
    hookScript: '',
    startTimeoutMs: 1000,
    waitForExitMs: 1000,
    logPaths: { out: 'out.log', err: 'err.log', service: 'service.log' },
    ...overrides,
  }
}

test('runStart skips when the port is already listening', async () => {
  const lines = []
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => true,
      portProbeWindowMs: 0,
      waitForPort: async () => true,
      spawnDsh: () => {
        throw new Error('must not spawn')
      },
      runHook: async () => ({ ran: false }),
    },
  })
  assert.deepEqual(result, { started: false })
  assert.match(lines.join('\n'), /still answering/)
})

test('runStart retries the port probe so an early answer cannot abort the restart', async () => {
  // Measured 2026-09-12 (docs/ACCEPTANCE.md, "restart race"): the outcome turns on a few
  // milliseconds after the old host is confirmed gone. One run probed at +4ms, read the port
  // as occupied, and returned without starting anything -- DSH stayed down; two later runs
  // probed at +10ms and +9ms, read it as free, and restarted normally. A probe landing the
  // instant after a process dies can be answered by a socket the kernel has not released
  // yet, and a plain connect cannot tell that apart from a live foreign service. Hence the
  // retry, which works without deciding which of the two it was.
  const answers = [true, true, false]
  let probes = 0
  let clock = 0
  const result = await runStart({
    config: baseConfig(),
    log: () => {},
    deps: {
      isPortListening: async () => answers[probes++] ?? false,
      portProbeWindowMs: 5000,
      portProbeIntervalMs: 1,
      // Deterministic clock: the deadline must advance without real waiting.
      now: () => (clock += 100),
      sleep: async () => {},
      waitForPort: async () => true,
      spawnDsh: () => fakeChild(4242),
      runHook: async () => ({ ran: false }),
    },
  })
  assert.equal(probes, 3, 'the probe must be retried, not decided on a single sample')
  assert.deepEqual(result, { started: true, pid: 4242, up: true })
})

test('runStart still refuses to start a second instance while the port keeps answering', async () => {
  // The retry above must not weaken the safety property the single probe existed for:
  // a genuinely foreign listener keeps answering, so the window expires and we do not
  // start a competing DSH on the same port.
  const lines = []
  let probes = 0
  let clock = 0
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => {
        probes += 1
        return true
      },
      portProbeWindowMs: 200,
      portProbeIntervalMs: 1,
      now: () => (clock += 100),
      sleep: async () => {},
      spawnDsh: () => {
        throw new Error('must not spawn a second instance')
      },
      runHook: async () => ({ ran: false }),
    },
  })
  assert.deepEqual(result, { started: false })
  assert.ok(probes > 1, `expected more than one probe, got ${probes}`)
  assert.match(lines.join('\n'), /still answering after \d+ probes/)
})

test('runStart spawns, waits for the port, then runs the hook', async () => {
  const order = []
  const result = await runStart({
    config: baseConfig(),
    log: () => {},
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => {
        order.push('waitForPort')
        return true
      },
      spawnDsh: () => {
        order.push('spawn')
        return fakeChild(4242)
      },
      runHook: async () => {
        order.push('hook')
        return { ran: true, code: 0 }
      },
    },
  })
  assert.deepEqual(order, ['spawn', 'waitForPort', 'hook'])
  assert.deepEqual(result, { started: true, pid: 4242, up: true })
})

test('runStart reports a failed port wait without throwing', async () => {
  const lines = []
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => fakeChild(7),
      runHook: async () => ({ ran: false }),
    },
  })
  assert.equal(result.up, false)
  assert.match(lines.join('\n'), /did not come up/)
})

test('runHook is a no-op without a hookScript', async () => {
  const result = await runHook(baseConfig(), () => {}, {})
  assert.deepEqual(result, { ran: false })
})

test('runHook reports a missing script without throwing', async () => {
  const lines = []
  const result = await runHook(
    baseConfig({ hookScript: 'C:\\missing\\hook.ps1' }),
    (line) => lines.push(line),
    { exists: () => false },
  )
  assert.deepEqual(result, { ran: false, missing: true })
  assert.match(lines.join('\n'), /hook not found/)
})

test('runHook maps .ps1/.cmd/.bat to their interpreters', async () => {
  const seen = []
  const spawnHook = (cmd, args) => {
    seen.push([cmd, args])
    return { once(event, handler) { if (event === 'close') setImmediate(() => handler(0)) } }
  }
  await runHook(baseConfig({ hookScript: 'C:\\h\\a.ps1' }), () => {}, { exists: () => true, spawnHook })
  await runHook(baseConfig({ hookScript: 'C:\\h\\b.cmd' }), () => {}, { exists: () => true, spawnHook })
  await runHook(baseConfig({ hookScript: 'C:\\h\\c.exe' }), () => {}, { exists: () => true, spawnHook })
  assert.match(seen[0][0], /powershell\.exe$/i)
  assert.match(seen[0][0], /^[A-Za-z]:\\/, 'the hook interpreter must be absolute too')
  assert.deepEqual(seen[0][1], ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\h\\a.ps1'])
  assert.deepEqual(seen[1], ['cmd.exe', ['/c', 'C:\\h\\b.cmd']])
  assert.deepEqual(seen[2], ['C:\\h\\c.exe', []])
})

test('runHook captures stderr into the log when the hook fails', async () => {
  // §7 row 8: the exit code AND stderr must be recorded. "hook exited code=1"
  // on its own tells the user nothing about why their hook failed.
  const lines = []
  const stdioSeen = []
  const spawnHook = (cmd, args, options) => {
    stdioSeen.push(options?.stdio)
    return {
      stderr: {
        setEncoding: () => {},
        on: (event, handler) => {
          if (event === 'data') setImmediate(() => handler('boom: cannot start frpc\n'))
        },
      },
      once(event, handler) {
        if (event === 'close') setImmediate(() => handler(1))
      },
    }
  }
  const result = await runHook(
    baseConfig({ hookScript: 'C:\\h\\after.ps1' }),
    (line) => lines.push(line),
    { exists: () => true, spawnHook },
  )
  assert.deepEqual(result, { ran: true, code: 1 })
  // stderr is piped, not ignored — the reviewed defect.
  assert.deepEqual(stdioSeen[0], ['ignore', 'ignore', 'pipe'])
  const text = lines.join('\n')
  assert.match(text, /hook exited code=1/)
  assert.match(text, /hook stderr: boom: cannot start frpc/)
})

test('runHook resolves even when stderr cannot be read', async () => {
  // A hook failure must never block DSH startup, so an unusable stderr stream
  // is swallowed rather than rejecting the promise.
  const lines = []
  const spawnHook = () => ({
    stderr: null,
    once(event, handler) {
      if (event === 'close') setImmediate(() => handler(3))
    },
  })
  const result = await runHook(
    baseConfig({ hookScript: 'C:\\h\\after.ps1' }),
    (line) => lines.push(line),
    { exists: () => true, spawnHook },
  )
  assert.deepEqual(result, { ran: true, code: 3 })
  assert.match(lines.join('\n'), /hook exited code=3/)
})

test('main rejects an unknown mode', async () => {
  // 必须传 configPath:不传的话 main 会去读真实用户 home 的 config.json,
  // 既拿不到测试期望的返回码,还会在用户真实 ~/.dsh 下写一个 service.log。
  const code = await main(['node', 'service.js', 'bogus'], {
    configPath: 'test/fixtures/config.json',
  })
  assert.equal(code, 2)
})

test('spawnDsh refuses a config without log paths instead of throwing a raw TypeError', () => {
  // Throws before touching the filesystem or spawning anything, so this test
  // launches nothing.
  assert.throws(
    () => spawnDsh({ command: { execPath: 'node.exe', argv: ['b.js'], cwd: '.' }, logPaths: {} }),
    /logPaths/,
  )
})

test('runStart hands the logger to the spawner so a spawn failure is reportable', async () => {
  let receivedLog = null
  await runStart({
    config: baseConfig(),
    log: () => {},
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => true,
      spawnDsh: (config, log) => {
        receivedLog = log
        return fakeChild(11)
      },
      runHook: async () => ({ ran: false }),
    },
  })
  assert.equal(typeof receivedLog, 'function')
})

test('main returns 1 rather than rejecting when the start path throws', async () => {
  const code = await main(['node', 'service.js', 'start'], {
    configPath: 'test/fixtures/config.json',
    isPortListening: async () => false,
    spawnDsh: () => {
      throw new Error('boom')
    },
  })
  assert.equal(code, 1)
})

test('main writes service.log NEXT TO the config file when the config cannot be read', async () => {
  // The old code derived the log path by rewriting `config.json` out of the
  // config path: for any other file name that rewrite was a no-op and the error
  // was appended INTO the config file. An isolated temp dir keeps this off the
  // real ~/.dsh.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-test-'))
  try {
    const configPath = path.join(dir, 'renamed-config.json')
    fs.writeFileSync(configPath, '{ not json', 'utf8')
    const code = await main(['node', 'service.js', 'start'], { configPath })
    assert.equal(code, 1)
    const logPath = path.join(dir, 'service.log')
    assert.equal(fs.existsSync(logPath), true)
    assert.match(fs.readFileSync(logPath, 'utf8'), /cannot read config/)
    // The config file itself is untouched.
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ not json')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('main reads the config named by --config, never a re-derived DSH home', async () => {
  // WMI creates the helper with the provider host's environment, so DSH_HOME is
  // absent there. If the helper re-derived the home it would read a different
  // config.json, exit 1, and leave DSH down — the defect this flag removes.
  // DSH_HOME is pointed at a temp dir so that even the fallback path cannot
  // touch the real ~/.dsh while this is red.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-cfg-'))
  const home = path.join(dir, 'home')
  const named = path.join(dir, 'named', 'config.json')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const code = await main(['node', 'service.js', 'start', '--config', named], {})
    assert.equal(code, 1)
    assert.equal(
      fs.existsSync(path.join(dir, 'named', 'service.log')),
      true,
      'the failure log must land next to the --config path (proof it was used)',
    )
    assert.equal(
      fs.existsSync(path.join(home, 'dsh-autostart', 'service.log')),
      false,
      'the helper must not fall back to DSH_HOME',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('spawnDsh re-asserts the DSH_HOME captured at enable time', () => {
  // The replacement instance is created by the helper, which inherited the WMI
  // host's environment — so without re-asserting it, a custom-DSH_HOME user's
  // restarted DSH would come up against the wrong home.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-spawn-'))
  try {
    let captured = null
    const config = baseConfig({
      dshHome: 'C:\\custom home',
      command: { execPath: process.execPath, argv: ['-e', '0'], cwd: dir },
      logPaths: {
        out: path.join(dir, 'out.log'),
        err: path.join(dir, 'err.log'),
        service: path.join(dir, 'service.log'),
      },
    })
    spawnDsh(config, () => {}, {
      baseEnv: { PATH: 'C:\\WINDOWS' },
      spawn: (command, args, options) => {
        captured = { command, args, options }
        return { once() {}, unref() {} }
      },
    })
    assert.equal(captured.options.env.DSH_HOME, 'C:\\custom home')
    assert.equal(captured.options.env.PATH, 'C:\\WINDOWS', 'the rest of the environment is preserved')
    // Attached on purpose: DETACHED_PROCESS leaves the host with no console, and DSH's
    // sandboxed children cannot be given their own hidden console, so each of them would
    // create a new one and Windows 11 would hand it to Windows Terminal (one window per
    // command). Inheriting the supervisor's hidden console is what removes those windows.
    assert.equal(captured.options.detached, false)
    assert.equal(captured.options.windowsHide, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('spawnDsh leaves the environment alone when no dshHome was captured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-spawn2-'))
  try {
    let captured = null
    const baseEnv = { PATH: 'C:\\WINDOWS' }
    const config = baseConfig({
      command: { execPath: process.execPath, argv: ['-e', '0'], cwd: dir },
      logPaths: {
        out: path.join(dir, 'out.log'),
        err: path.join(dir, 'err.log'),
        service: path.join(dir, 'service.log'),
      },
    })
    spawnDsh(config, () => {}, {
      baseEnv,
      spawn: (command, args, options) => {
        captured = { command, args, options }
        return { once() {}, unref() {} }
      },
    })
    assert.equal(captured.options.env, baseEnv, 'an absent dshHome must not invent one')
    assert.equal('DSH_HOME' in captured.options.env, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- fallbacks
// A restart that fails leaves DSH down, and the card lives inside DSH's page, so no UI can
// report it. The only useful fallbacks are automatic: retry the start, then leave one
// delayed attempt behind before giving up.

test('runStart retries a start that never came up, once the failed child is gone', async () => {
  const lines = []
  let spawns = 0
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => {
        spawns += 1
        return fakeChild(1000 + spawns)
      },
      isProcessAlive: () => false,
      startAttempts: 3,
      startRetryDelayMs: 0,
      sleep: async () => {},
      runHook: async () => ({ ran: false }),
      scheduleSecondChance: () => 1,
    },
  })
  assert.equal(spawns, 3, 'a failed start must be retried up to the attempt limit')
  assert.equal(result.up, false)
  assert.match(lines.join('\n'), /attempt 3\/3/)
})

test('runStart does not start a competitor while the failed child is still alive', async () => {
  // A live child may still bind the port a moment later; spawning a second one at that
  // point is how you get two DSH instances racing for 3080.
  const lines = []
  let spawns = 0
  await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => {
        spawns += 1
        return fakeChild(2000)
      },
      isProcessAlive: () => true,
      startAttempts: 3,
      startRetryDelayMs: 0,
      sleep: async () => {},
      runHook: async () => ({ ran: false }),
      scheduleSecondChance: () => 1,
    },
  })
  assert.equal(spawns, 1, 'the live child gets the port wait to itself')
  assert.match(lines.join('\n'), /still alive/)
})

test('a failed start leaves exactly one delayed attempt behind', async () => {
  const scheduled = []
  await runStart({
    config: baseConfig(),
    configPath: 'C:\\home\\.dsh\\dsh-autostart\\config.json',
    log: () => {},
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => fakeChild(3000),
      isProcessAlive: () => false,
      startAttempts: 1,
      sleep: async () => {},
      runHook: async () => ({ ran: false }),
      scheduleSecondChance: (input) => {
        scheduled.push(input)
        return 4242
      },
    },
  })
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].configPath, 'C:\\home\\.dsh\\dsh-autostart\\config.json')
})

test('the delayed attempt itself never schedules another one (no loop)', async () => {
  const scheduled = []
  await runStart({
    config: baseConfig(),
    configPath: 'C:\\home\\.dsh\\dsh-autostart\\config.json',
    secondChance: true,
    log: () => {},
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => fakeChild(3000),
      isProcessAlive: () => false,
      startAttempts: 1,
      sleep: async () => {},
      runHook: async () => ({ ran: false }),
      scheduleSecondChance: (input) => {
        scheduled.push(input)
        return 1
      },
    },
  })
  assert.deepEqual(scheduled, [], 'the fallback must be a single extra attempt')
})

test('a port we refused to fight over only gets a fallback after a restart', async () => {
  // At login a busy port usually means something else is already serving DSH, and a
  // fallback would be an attempt to fight it. After a restart it means our own instance
  // just died and something is lingering, which is exactly the case worth retrying.
  const scheduled = []
  const deps = {
    isPortListening: async () => true,
    portProbeWindowMs: 0,
    spawnDsh: () => {
      throw new Error('must not spawn')
    },
    runHook: async () => ({ ran: false }),
    scheduleSecondChance: (input) => {
      scheduled.push(input)
      return 1
    },
  }
  await runStart({ config: baseConfig(), configPath: 'cfg.json', log: () => {}, deps })
  assert.deepEqual(scheduled, [], 'a login-time skip must not schedule a retry')

  await runStart({ config: baseConfig(), configPath: 'cfg.json', afterRestart: true, log: () => {}, deps })
  assert.equal(scheduled.length, 1, 'a restart-time skip should')
})

test('scheduleSecondChance spawns one detached, delayed start attempt', () => {
  let captured = null
  const lines = []
  const pid = scheduleSecondChance({
    configPath: 'C:\\home\\.dsh\\dsh-autostart\\config.json',
    log: (line) => lines.push(line),
    deps: {
      secondChanceDelayMs: 60000,
      spawn: (command, args, options) => {
        captured = { command, args, options }
        return { pid: 777, unref() {} }
      },
    },
  })
  assert.equal(pid, 777)
  assert.equal(captured.command, process.execPath)
  assert.match(captured.args.join(' '), /service\.js start --config/)
  assert.match(captured.args.join(' '), /--second-chance/)
  assert.match(captured.args.join(' '), /--delay 60000/)
  assert.equal(captured.options.detached, true, 'it has to outlive the helper')
  assert.match(lines.join('\n'), /scheduled one more start attempt/)
})

// ---------------------------------------------------------------- supervisor

test('runSupervise starts DSH once and reports that it is supervising', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup-'))
  try {
    const spawned = []
    const child = fakeChild(4242)
    let hooked = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 1000 }),
      configPath: path.join(dir, 'config.json'),
      log: () => {},
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawned.push(1); return child },
        runHook: async () => { hooked += 1; return { ran: false } },
        isProcessAlive: () => false,
        // Task 4 returns as soon as the port is up and the hook has run; the supervision loop
        // that would call this belongs to Task 5. It is injected so the Task 5 test can keep
        // this body once that loop exists.
        waitForChildExit: async () => 0,
        sleep: async () => {},
      },
    })
    assert.equal(spawned.length, 1)
    assert.equal(hooked, 1, 'the start phase ends by running the hook')
    // Explicit fields plus the handle's pid: the result gained a `child` key, so a deepEqual
    // against the old shape would no longer pin the contract as strictly.
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 4242)
    assert.equal(result.child, child)
    assert.equal(result.child.pid, 4242)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise retries a start that never came up, until the attempt limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup2-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => false,
        spawnDsh: () => { spawns += 1; return fakeChild(5000 + spawns) },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        superviseAttempts: 3,
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 60000) })(),
      },
    })
    assert.equal(spawns, 3, 'every attempt must be tried')
    assert.equal(result.supervised, false)
    // Pins the fourth exit path of the give-up counter: a loop that runs to exhaustion must
    // report the same number of attempts it made. This is NOT a pin for the original defect —
    // the old `${attempts}` code also printed 3 on this path — it is a guard so that a future
    // edit to the new `spawned` arithmetic, or a reintroduction of the cap, breaks loudly.
    assert.match(lines.join('\n'), /giving up: DSH did not come up after 3 attempt\(s\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise stands down when another supervisor is already alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup3-'))
  try {
    const lines = []
    writePid(path.join(dir, 'supervise.pid'), 999)
    const result = await runSupervise({
      config: baseConfig(),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isProcessAlive: (pid) => pid === 999,
        spawnDsh: () => { throw new Error('must not spawn a second supervisor') },
      },
    })
    assert.deepEqual(result, { supervised: false, reason: 'already-running' })
    assert.match(lines.join('\n'), /already running \(999\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise waits out a draining socket instead of accepting the port as busy', async () => {
  // Measured 2026-09-12 (docs/ACCEPTANCE.md, "restart race"): a probe landing the instant
  // after a process dies can be answered by a socket the kernel has not released yet. A
  // single bare probe here would make the supervisor exit reporting success while DSH is
  // down and nobody is left to start it — the exact failure runStart re-probes to avoid.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup4-'))
  try {
    const lines = []
    let probes = 0
    let spawns = 0
    const child = fakeChild(4242, { exit: false })
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        // The first probe lands on the draining socket; the next one finds it gone.
        isPortListening: async () => {
          probes += 1
          return probes === 1
        },
        // Deterministic clock over a 5000ms window: one 1000ms tick between the two probes.
        now: (() => { let t = 0; return () => (t += 1000) })(),
        sleep: async () => {},
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return child },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        takeoverPortWindowMs: 5000,
        portProbeIntervalMs: 1,
        // This is the one Task 4 test that reaches the supervision loop. The exit is injected so
        // the test does not also depend on the fake handle's own exit behaviour: here the child
        // stays up (the loop is not what is under test), and the seam stands in for "it ended".
        waitForChildExit: async (pid) => pid,
      },
    })
    assert.equal(probes, 2, 'the busy answer must be re-probed, not accepted once')
    assert.equal(spawns, 1, 'a draining socket must not stop the start')
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 4242)
    assert.equal(result.child, child)
    assert.equal(result.child.pid, 4242)
    assert.doesNotMatch(lines.join('\n'), /port-busy|standing down/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise stands down when the port still answers after the drain window', async () => {
  // The retry must not weaken the property the single probe existed for: a genuinely foreign
  // listener keeps answering, so the window expires and no competing DSH is started.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup5-'))
  try {
    const lines = []
    let probes = 0
    const result = await runSupervise({
      config: baseConfig(),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => {
          probes += 1
          return true
        },
        now: (() => { let t = 0; return () => (t += 1000) })(),
        sleep: async () => {},
        spawnDsh: () => { throw new Error('must not start a competitor for a served port') },
        takeoverPortWindowMs: 5000,
        portProbeIntervalMs: 1,
      },
    })
    assert.ok(probes > 1, `expected the probe to be retried, got ${probes} probes`)
    assert.deepEqual(result, { supervised: false, reason: 'port-busy' })
    assert.match(lines.join('\n'), /served by something else/)
    assert.equal(readPid(path.join(dir, 'supervise.pid')), null, 'standing down must clear the pid file')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise does not retry while the failed child is still alive', async () => {
  // A live child may still bind the port a moment later, and spawning a second instance at
  // that point is how two DSH processes end up racing for the same port.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup6-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => false,
        spawnDsh: () => { spawns += 1; return fakeChild(6000) },
        isProcessAlive: () => true,
        runHook: async () => ({ ran: false }),
        superviseAttempts: 3,
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'the live child gets its port wait to itself')
    assert.deepEqual(result, { supervised: false, reason: 'start-failed' })
    const text = lines.join('\n')
    assert.match(text, /still alive/)
    // The log is the user's only diagnostic, so the count must match the line above it.
    assert.match(text, /giving up: DSH did not come up after 1 attempt\(s\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise stops retrying once the total time budget is spent', async () => {
  // The retry is bounded twice over: attempt count AND total elapsed time. The default budget
  // is unreachable here — 5 attempts of startTimeoutMs never reach the 5-minute default — so
  // the bound only ever trips when the values are injected, as they are below.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup7-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => false,
        spawnDsh: () => { spawns += 1; return fakeChild(7000) },
        isProcessAlive: () => false,
        runHook: async () => ({ ran: false }),
        superviseAttempts: 10,
        superviseTotalMs: 5000,
        superviseBackoffMs: 1000,
        // Deterministic clock: every reading jumps a minute, so the first budget check
        // (elapsed + the next delay) is already over the 5000ms budget.
        now: (() => { let t = 0; return () => (t += 60000) })(),
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'the budget must stop the loop long before the attempt limit')
    assert.deepEqual(result, { supervised: false, reason: 'start-failed' })
    const text = lines.join('\n')
    assert.doesNotMatch(text, /still alive/)
    assert.match(text, /giving up: DSH did not come up after 1 attempt\(s\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise refuses to spawn a retry while the port still answers', async () => {
  // The pre-spawn drain wait is what stops attempt 2 from racing a child whose socket is
  // still up. When it never drains, the honest outcome is to stand down, not to spawn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup8-'))
  try {
    const lines = []
    let probes = 0
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => {
          probes += 1
          return probes > 1
        },
        now: (() => { let t = 0; return () => (t += 1000) })(),
        sleep: async () => {},
        waitForPort: async () => false,
        spawnDsh: () => { spawns += 1; return fakeChild(8000) },
        isProcessAlive: () => false,
        runHook: async () => ({ ran: false }),
        superviseAttempts: 2,
        takeoverPortWindowMs: 5000,
        portProbeIntervalMs: 1,
      },
    })
    assert.equal(spawns, 1, 'the retry must not spawn while the port still answers')
    assert.deepEqual(result, { supervised: false, reason: 'start-failed' })
    const text = lines.join('\n')
    assert.match(text, /still answers after waiting for it to drain/)
    assert.match(text, /giving up: DSH did not come up after 1 attempt\(s\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ------------------------------------------------------- supervision loop

test('runSupervise restarts DSH only when the exit was requested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup4-'))
  try {
    const lines = []
    let spawns = 0
    // First child (pid 111) exits with a matching restart request; second (222) exits with
    // none, which must end the loop without another spawn.
    writeRestartRequest(path.join(dir, 'restart.request'), 111)
    const first = fakeChild(111)
    const second = fakeChild(222)
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return spawns === 1 ? first : second },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        // The replacement start goes through runSupervise's takeover wait, which uses a
        // different seam from waitForChildExit. Left to the real one it would poll a real
        // pid and could sit out DEFAULT_TAKEOVER_EXIT_MS on a machine where 111 exists.
        waitForProcessExit: async () => true,
        waitForChildExit: async (pid) => { return pid },
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 2, 'the requested restart must respawn exactly once')
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 222)
    assert.equal(result.child, second)
    assert.equal(result.child.pid, 222)
    assert.match(lines.join('\n'), /restart requested/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise does not resurrect DSH when the exit was not requested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup5-'))
  try {
    const lines = []
    let spawns = 0
    const child = fakeChild(777)
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return child },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => pid,
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'a plain exit is not a reason to start another instance')
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 777)
    assert.equal(result.child, child)
    assert.equal(result.child.pid, 777)
    assert.match(lines.join('\n'), /exited without a restart request/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise exits when a stop marker names this supervisor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup6-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return fakeChild(555) },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => {
          writePid(path.join(dir, 'supervise.stop'), process.pid)
          return pid
        },
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'a stop must not spawn a replacement')
    assert.equal(result.supervised, false)
    assert.match(lines.join('\n'), /stop requested/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise learns of the exit from the child handle, not by polling the pid', async () => {
  // The spec says it four times (design.md:46,:51,:80,:106) and the plan's architecture
  // paragraph agrees (plan.md:7): liveness is judged by `child.on('exit')`, 不轮询. The pid
  // alone cannot carry that, which is why spawnDsh returns the handle.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup7-'))
  try {
    const child = fakeChild(4242, { exit: false })
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: () => {},
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => child,
        runHook: async () => {
          // Fires a turn after the handle exists, by which point the loop has subscribed. A
          // handle that closed before anyone listened is the other test's scenario.
          setImmediate(() => child.close())
          return { ran: false }
        },
        isProcessAlive: () => false,
        // waitForChildExit is deliberately NOT injected: this test exists to cover the default
        // branch, which is the only one in the change with no other test over it.
      },
    })
    assert.ok(
      child.subscriptions.includes('exit'),
      `the default must subscribe to the handle's 'exit' event, got: ${JSON.stringify(child.subscriptions)}`,
    )
    // The exit was delivered as an event, no restart was requested, so the story ends.
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 4242)
    assert.equal(result.child, child)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise does not hang when the child exited before the listener was attached', async () => {
  // runSupervise only reaches superviseChild after waitForPort and the hook have run, so a child
  // that died in that window already emitted 'exit' — and Node does not replay events. Without
  // the exitCode/signalCode guard the loop would wait forever on a dead child while still holding
  // supervise.pid, which also blocks the single-instance guard. This is a regression pin for that
  // hang, not a mechanism RED: it passes against the old polling default too, because a fake pid
  // that does not exist makes defaultIsAlive report "gone".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup8-'))
  try {
    const child = exitedChild(4242)
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: () => {},
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => child,
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
      },
    })
    assert.equal(result.supervised, true)
    assert.equal(result.pid, 4242)
    assert.equal(readPid(path.join(dir, 'supervise.pid')), null, 'an ended story must not leave its pid behind')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
