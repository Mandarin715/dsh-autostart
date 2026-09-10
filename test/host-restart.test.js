import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHandlers, countRunningAgents, defaultSpawnHelper } from '../index.js'

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) {
      this.statusCode = code
    },
    end(body) {
      this.body = body
    },
  }
}
const req = () => ({
  method: 'POST',
  headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
})

/**
 * Handler deps that let the restart path reach the spawn step: the fs double
 * reports config.json as present, and every dangerous seam is a throwing
 * double so a regression cannot reach the real filesystem or exit anything.
 */
function restartDeps(overrides = {}) {
  return {
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: { existsSync: () => true },
    spawnHelper: () => {},
    scheduleExit: () => {},
    ...overrides,
  }
}

test('countRunningAgents counts only running agents', () => {
  const agents = { list: () => [{ status: 'running' }, { status: 'idle' }, { status: 'running' }] }
  assert.equal(countRunningAgents(agents), 2)
  // An absent service is "unknown", not "nothing is running" — see the
  // unknown-state test below.
  assert.equal(countRunningAgents(undefined), null)
  assert.equal(countRunningAgents({}), null)
})

test('restart refuses with 400 and spawns nothing when config.json is missing', async () => {
  // Without config.json, service.js restart cannot read the launch command: it
  // logs, returns 1, and nothing starts DSH. Spawning the helper and exiting
  // would therefore mean "restart" silently means "shut down".
  let spawned = false
  const handlers = createHandlers(
    restartDeps({
      // The throwing fs double: the guard must short-circuit before any write.
      fs: {
        existsSync: () => false,
        writeFileSync: () => {
          throw new Error('must not touch the filesystem')
        },
      },
      agents: { list: () => [] },
      spawnHelper: () => {
        spawned = true
        throw new Error('must not spawn')
      },
      scheduleExit: () => {
        throw new Error('must not schedule an exit')
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body, /config\.json is missing/)
  assert.equal(spawned, false)
})

test('restart refuses while a restart is already scheduled', async () => {
  const handlers = createHandlers(restartDeps({ scheduleExit: () => {} }))
  const first = fakeRes()
  await handlers.restart(req(), first)
  assert.equal(first.statusCode, 202)
  const second = fakeRes()
  await handlers.restart(req(), second)
  assert.equal(second.statusCode, 409)
})

test('restart spawns the helper with the current pid', async () => {
  const calls = []
  // Counted, not merely stubbed: spawning the helper is useless unless the exit
  // that lets it restart us is actually armed, so pin that call too.
  let exits = 0
  const handlers = createHandlers(
    restartDeps({
      currentPid: 4321,
      spawnHelper: (deps) => calls.push(deps),
      scheduleExit: () => {
        exits += 1
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].oldPid, 4321)
  assert.equal(exits, 1)
})

test('restart still accepts with runningAgents null when the gate is off', async () => {
  // The default config has blockWhenAgentsRunning false, and an absent `agents`
  // service now counts as "unknown". That must not break the accepted path.
  const handlers = createHandlers(restartDeps({ agents: undefined }))
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(JSON.parse(res.body).runningAgents, null)
})

test('restart returns 500 and schedules no exit when the helper fails to spawn', async () => {
  let exits = 0
  const handlers = createHandlers(
    restartDeps({
      spawnHelper: () => {
        throw new Error('spawn boom')
      },
      scheduleExit: () => {
        exits += 1
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 500)
  assert.equal(exits, 0)
})

test('restart blocks when agents are running and the guard is on', async () => {
  const handlers = createHandlers(
    restartDeps({
      config: { blockWhenAgentsRunning: true },
      agents: { list: () => [{ status: 'running' }] },
      // Returning 409 already short-circuits today, but if the gate ever regressed
      // the default setTimeout(() => process.exit(0)) would arm a real exit and
      // kill the test runner — so inject a no-op.
      scheduleExit: () => {},
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /agent/i)
})

test('countRunningAgents reports unknown rather than zero when the list cannot be read', () => {
  // This backs a protection the user explicitly opted into: when the agent list
  // cannot be read the result must be "unknown", never 0 — 0 would silently lift
  // the protection, which is the unsafe direction. An absent service (a DSH
  // build without `agents`) is unknown for the same reason.
  assert.equal(countRunningAgents(undefined), null)
  assert.equal(countRunningAgents({ list: () => [] }), 0)
  assert.equal(countRunningAgents({ list: () => [{ status: 'running' }] }), 1)
  assert.equal(countRunningAgents({ list: () => { throw new Error('boom') } }), null)
  assert.equal(countRunningAgents({ list: () => 'not-an-array' }), null)
})

test('restart refuses when the agent list cannot be read and the gate is on', async () => {
  // This one guards the branch this fix wave is about: without it, reverting the
  // gate to `running > 0` would still leave the whole suite green.
  const handlers = createHandlers(
    restartDeps({
      config: { blockWhenAgentsRunning: true },
      agents: {
        list: () => {
          throw new Error('boom')
        },
      },
      spawnHelper: () => {
        throw new Error('must not spawn')
      },
      scheduleExit: () => {
        throw new Error('must not schedule an exit')
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /unreadable/)
})

test('restart refuses when the agents service is absent and the gate is on', async () => {
  // The service was made an optional injection, so its absence must still refuse
  // rather than silently lift the gate.
  const handlers = createHandlers(
    restartDeps({
      config: { blockWhenAgentsRunning: true },
      agents: undefined,
      spawnHelper: () => {
        throw new Error('must not spawn')
      },
      scheduleExit: () => {
        throw new Error('must not schedule an exit')
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /unreadable/)
})

/** A ChildProcess stand-in that records the listeners defaultSpawnHelper attaches. */
function fakeLauncher({ exitCode = 0, signal = null, hang = false, stderrText = null } = {}) {
  const handlers = {}
  const stderr = new EventEmitter()
  stderr.setEncoding = () => {}
  const child = {
    stderr,
    once(event, cb) {
      handlers[event] = cb
      return child
    },
    kill() {},
  }
  // Fire only after the caller has had a chance to attach its listeners.
  setImmediate(() => {
    if (stderrText !== null) stderr.emit('data', stderrText)
    if (!hang && handlers.exit) handlers.exit(exitCode, signal)
  })
  return child
}

/** Launch input whose paths really exist, so the guard does not short-circuit. */
function spawnInput(overrides = {}) {
  return {
    execPath: process.execPath,
    serviceJsPath: import.meta.filename,
    oldPid: 99,
    configPath: 'C:\\dsh\\dsh-autostart\\config.json',
    ...overrides,
  }
}

test('defaultSpawnHelper rejects when the helper or node is missing', async () => {
  // The existence checks must run before anything is launched, so the route can
  // answer 500 instead of exiting the host with no helper behind it. This is a
  // rejection rather than a synchronous throw because the launch is awaited now:
  // the launcher itself runs inside DSH's job, so it has to finish handing the
  // helper to the WMI service before the exit that would kill it.
  let launched = false
  const deps = {
    spawnLauncher: () => {
      launched = true
      return fakeLauncher()
    },
  }
  await assert.rejects(
    () =>
      defaultSpawnHelper(
        spawnInput({ serviceJsPath: 'C:\\definitely\\missing\\service.js' }),
        deps,
      ),
    /restart helper not found/,
  )
  await assert.rejects(
    () => defaultSpawnHelper(spawnInput({ execPath: 'C:\\definitely\\missing\\node.exe' }), deps),
    /node executable not found/,
  )
  assert.equal(launched, false, 'no launcher may start when a path is missing')
})

test('defaultSpawnHelper launches the helper through the WMI service', async () => {
  // Not a plain detached spawn: `detached` was measured to leave the helper
  // inside DSH's kill-on-close job, which is what turned "restart" into
  // "shut down".
  let captured = null
  await defaultSpawnHelper(spawnInput({ oldPid: 99 }), {
    spawnLauncher: (command, args, options) => {
      captured = { command, args, options }
      return fakeLauncher()
    },
  })
  // Absolute, not a bare 'powershell.exe': CreateProcess searches the current
  // directory first, so a planted executable would win.
  assert.match(captured.command, /powershell\.exe$/i)
  assert.match(captured.command, /^[A-Za-z]:\\/)
  // stderr is piped so a failure can name its cause.
  assert.deepEqual(captured.options.stdio, ['ignore', 'ignore', 'pipe'])
  const script = Buffer.from(
    captured.args[captured.args.indexOf('-EncodedCommand') + 1],
    'base64',
  ).toString('utf16le')
  assert.match(script, /Win32_Process/)
  assert.match(script, /restart --pid 99/)
  // The helper must be told where config.json is: the WMI boundary drops the
  // caller's environment, so it cannot be allowed to re-derive DSH_HOME.
  assert.match(script, /--config/)
  assert.match(script, /config\.json/)
})

test('defaultSpawnHelper rejects when the launcher exits non-zero', async () => {
  await assert.rejects(
    () => defaultSpawnHelper(spawnInput(), { spawnLauncher: () => fakeLauncher({ exitCode: 1 }) }),
    /code 1/,
  )
})

test('defaultSpawnHelper names the cause when the launcher fails', async () => {
  // Without this the user sees the same "code 1" for WMI disabled, a missing
  // PowerShell and access denied — WMI is now a hard dependency of restart.
  await assert.rejects(
    () =>
      defaultSpawnHelper(spawnInput(), {
        spawnLauncher: () =>
          fakeLauncher({
            exitCode: 1,
            stderrText: 'junk line\nWin32_Process.Create failed, ReturnValue=9\n',
          }),
      }),
    /ReturnValue=9/,
  )
})

test('defaultSpawnHelper reports a killed launcher instead of "code null"', async () => {
  await assert.rejects(
    () =>
      defaultSpawnHelper(spawnInput(), {
        spawnLauncher: () => fakeLauncher({ exitCode: null, signal: 'SIGTERM' }),
      }),
    /killed by signal SIGTERM/,
  )
})

test('defaultSpawnHelper rejects when the launcher cannot even be started', async () => {
  // spawnLauncher throws synchronously (EPERM/ENOENT from the OS): that must
  // become a rejection the route can answer, not an unhandled throw.
  await assert.rejects(
    () =>
      defaultSpawnHelper(spawnInput(), {
        spawnLauncher: () => {
          throw new Error('EPERM: operation not permitted')
        },
      }),
    /could not start the restart launcher.*EPERM/,
  )
})

test('defaultSpawnHelper rejects when the launcher never finishes', async () => {
  // A hung launcher must not count as success: the host would then exit while
  // the helper had never reached the WMI service.
  await assert.rejects(
    () =>
      defaultSpawnHelper(spawnInput(), {
        spawnLauncher: () => fakeLauncher({ hang: true }),
        launcherTimeoutMs: 30,
      }),
    /did not finish/,
  )
})

test('restart passes the host-resolved config path to the helper', async () => {
  // Derived from the resolved dshHome (which deps can override), never from
  // DSH_HOME — the helper is created across a boundary that drops the env.
  let seen = null
  const handlers = createHandlers(
    restartDeps({
      dshHome: 'C:\\custom home',
      spawnHelper: (input) => {
        seen = input
      },
      scheduleExit: () => {},
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(seen.configPath, 'C:\\custom home\\dsh-autostart\\config.json')
})

test('two overlapping restarts launch exactly one helper', async () => {
  // The re-entrancy flag has to be set BEFORE the await: spawnHelper is async
  // now, so setting it afterwards leaves an interleaving point where both
  // requests pass the check, two helpers launch and two exits are armed — which
  // spec §7 forbids, and which lets two DSH instances race for the port.
  let launches = 0
  let exits = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const handlers = createHandlers(
    restartDeps({
      spawnHelper: async () => {
        launches += 1
        await gate
      },
      scheduleExit: () => {
        exits += 1
      },
    }),
  )
  const first = fakeRes()
  const second = fakeRes()
  const firstCall = handlers.restart(req(), first)
  // The second request arrives while the first is still awaiting the launch.
  const secondCall = handlers.restart(req(), second)
  release()
  await Promise.all([firstCall, secondCall])
  assert.equal(first.statusCode, 202)
  assert.equal(second.statusCode, 409)
  assert.equal(launches, 1, 'only one helper may be launched')
  assert.equal(exits, 1, 'only one exit may be armed')
})

test('a failed launch clears the re-entrancy flag so the user can retry', async () => {
  let attempts = 0
  const handlers = createHandlers(
    restartDeps({
      spawnHelper: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('first launch fails')
      },
      scheduleExit: () => {},
    }),
  )
  const first = fakeRes()
  await handlers.restart(req(), first)
  assert.equal(first.statusCode, 500)
  const second = fakeRes()
  await handlers.restart(req(), second)
  assert.equal(second.statusCode, 202, 'a failed launch must not lock the button forever')
})

test('restart arms the exit only after the helper launch has completed', async () => {
  // The launcher runs inside DSH's job, so it has to have FINISHED before DSH
  // exits — otherwise the exit kills the launcher mid-call and nothing is left
  // to restart DSH. This ordering is the difference between a restart button and
  // a shutdown button.
  let helperFinished = false
  let finishedWhenExitArmed = null
  const handlers = createHandlers(
    restartDeps({
      spawnHelper: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        helperFinished = true
      },
      scheduleExit: () => {
        finishedWhenExitArmed = helperFinished
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(finishedWhenExitArmed, true, 'the exit was armed before the helper launch finished')
})

test('restart returns 500 and arms no exit when the helper rejects asynchronously', async () => {
  let exits = 0
  const handlers = createHandlers(
    restartDeps({
      spawnHelper: async () => {
        throw new Error('launcher boom')
      },
      scheduleExit: () => {
        exits += 1
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 500)
  assert.match(res.body, /launcher boom/)
  assert.equal(exits, 0, 'a failed launch must not exit the host')
})
