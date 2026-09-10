import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runStart, runHook, spawnDsh, main } from '../service.js'

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
      waitForPort: async () => true,
      spawnDsh: () => {
        throw new Error('must not spawn')
      },
      runHook: async () => ({ ran: false }),
    },
  })
  assert.deepEqual(result, { started: false })
  assert.match(lines.join('\n'), /already running/)
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
  assert.deepEqual(seen[0], ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\h\\a.ps1']])
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
