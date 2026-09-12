import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runStart, runHook, spawnDsh, scheduleSecondChance, main } from '../service.js'

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
      spawnDsh: () => 4242,
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
        return 4242
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
      spawnDsh: () => 7,
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
        return 11
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
    // Still launched detached and windowless: unchanged by this fix.
    assert.equal(captured.options.detached, true)
    assert.equal(captured.options.windowsHide, true)
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
        return 1000 + spawns
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
        return 2000
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
      spawnDsh: () => 3000,
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
      spawnDsh: () => 3000,
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
