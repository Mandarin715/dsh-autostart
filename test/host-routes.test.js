import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sameOrigin, createHandlers, cleanupAutostart } from '../index.js'
import { defaultSupervisor, isProcessAlive } from '../lib/supervise-launch.js'
import {
  configFilePath,
  configDir,
  restartRequestFile,
  supervisePidFile,
  superviseStopFile,
} from '../lib/config.js'
import { readPid, writePid } from '../lib/supervise-state.js'
import { registryCommand } from '../lib/registry.js'

/** A dsh home that matches the `C:\\dsh` used throughout this file. */
const HOME = 'C:\\dsh'

/** A pid that is never a real process: it only ever travels through injected seams. */
const SUPERVISOR_PID = 4321

/** Make a throwable with a chosen `code`, so the ESRCH/EPERM rule can be pinned. */
function throwCode(code) {
  return () => {
    const error = new Error(code)
    error.code = code
    throw error
  }
}

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

function fakeReq(overrides = {}) {
  return { method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, ...overrides }
}

test('sameOrigin accepts a matching origin and rejects others', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), false)
  assert.equal(sameOrigin({ host: '127.0.0.1:3080' }), false)
  assert.equal(sameOrigin({}), false)
})

test('sameOrigin rejects a non-loopback Host even when Origin agrees with it', () => {
  // DNS rebinding: a page served from evil.example:<port> whose domain then
  // rebinds to 127.0.0.1:<port> presents a Host and an Origin that agree with
  // each other, so equality alone would let it write HKCU\...\Run.
  assert.equal(sameOrigin({ host: 'evil.example:3080', origin: 'http://evil.example:3080' }), false)
  // Same for any other authority that is not this machine's loopback service.
  assert.equal(sameOrigin({ host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' }), false)
})

test('sameOrigin enforces the expected port when one is given', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, 3080), true)
  assert.equal(sameOrigin({ host: 'localhost:3080', origin: 'http://localhost:3080' }, 3080), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }, 3080), false)
})

test('sameOrigin admits an explicitly trusted reverse-proxy authority, and only that one', () => {
  const allowed = ['derp.example.com']
  // A user reaching DSH through frp + auth-proxy: the proxy forwards the
  // original Host, so the browser sends the public domain rather than loopback.
  assert.equal(
    sameOrigin({ host: 'derp.example.com:3080', origin: 'http://derp.example.com:3080' }, 3080, allowed),
    true,
  )
  // Trusting one authority must not open the door to another.
  assert.equal(
    sameOrigin({ host: 'evil.example:3080', origin: 'http://evil.example:3080' }, 3080, allowed),
    false,
  )
  // The same-origin condition still binds a trusted authority.
  assert.equal(
    sameOrigin({ host: 'derp.example.com:3080', origin: 'http://other.example:3080' }, 3080, allowed),
    false,
  )
  // With no allow-list configured, the same request is refused.
  assert.equal(
    sameOrigin({ host: 'derp.example.com:3080', origin: 'http://derp.example.com:3080' }, 3080),
    false,
  )
})

test('sameOrigin admits a portless trusted authority (the HTTPS reverse-proxy case)', () => {
  // Reaching https://derp.example.com sends `Host: derp.example.com` with no
  // port at all, so requiring the local dshPort here would 403 exactly the case
  // allowedHosts exists for. The allow-list entry is an explicit per-authority
  // opt-in and the Origin/Host equality check still binds it.
  const allowed = ['derp.example.com']
  assert.equal(
    sameOrigin({ host: 'derp.example.com', origin: 'https://derp.example.com' }, 3080, allowed),
    true,
  )
  // A different port on a trusted authority is admitted too (still same-origin).
  assert.equal(
    sameOrigin({ host: 'derp.example.com:9999', origin: 'http://derp.example.com:9999' }, 3080, allowed),
    true,
  )
  // But portless is not a way in for an authority the user never listed.
  assert.equal(
    sameOrigin({ host: 'evil.example', origin: 'https://evil.example' }, 3080, allowed),
    false,
  )
  // And loopback keeps the strict port check.
  assert.equal(sameOrigin({ host: '127.0.0.1', origin: 'http://127.0.0.1' }, 3080), false)
  assert.equal(
    sameOrigin({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }, 3080, allowed),
    false,
  )
})

test('enable refuses on an unsupported platform', async () => {
  const handlers = createHandlers({
    platform: 'linux',
    config: {},
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    // Throwing doubles: if the guard ever stops short-circuiting before the
    // side effects, this test must fail loudly rather than write to the real
    // registry or the real ~/.dsh.
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body, /Windows/)
})

test('enable refuses cross-origin POSTs', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    // Same throwing-double protection as the unsupported-platform test: this
    // test exists to prove the guard refuses, so a broken guard must not be
    // able to reach the real system.
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), res)
  assert.equal(res.statusCode, 403)
})

test('enable refuses a rebinding-style request whose Host and Origin agree off-loopback', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    config: {},
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(
    fakeReq({ headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } }),
    res,
  )
  assert.equal(res.statusCode, 403)
})

test('enable writes config, vbs and the registry entry', async () => {
  const written = {}
  const registryCalls = []
  const handlers = createHandlers({
    platform: 'win32',
    config: { dshPort: 3080 },
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (file, data) => {
        written[file] = data
      },
    },
    registry: {
      writeRunValue: (vbsPath) => registryCalls.push(vbsPath),
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, true)
  // §5.1 step 7 lists registryValue in the 200 response.
  assert.equal(payload.registryValue, 'wscript.exe "C:\\dsh\\dsh-autostart\\bootstrap.vbs"')
  assert.ok(written['C:\\dsh\\dsh-autostart\\config.json'].includes('"dshPort": 3080'))
  assert.ok(written['C:\\dsh\\dsh-autostart\\bootstrap.vbs'].includes('Generated by dsh-autostart'))
  assert.deepEqual(registryCalls, ['C:\\dsh\\dsh-autostart\\bootstrap.vbs'])
})

test('enable reports a registry write failure with the security-software hint', async () => {
  // §7 row 2: the registry-write failure message must name the likely cause.
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: { mkdirSync: () => {}, writeFileSync: () => {} },
    registry: {
      writeRunValue: () => {
        // The real reg.exe would fail here rather than writing the registry.
        throw new Error('registry write failed: access denied')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 500)
  assert.match(res.body, /security software/)
})

test('enable writes the vbs as UTF-16LE with a BOM so non-ASCII paths survive wscript', async () => {
  const calls = []
  const handlers = createHandlers({
    platform: 'win32',
    config: {},
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (file, data, encoding) => {
        calls.push({ file, data, encoding })
      },
    },
    registry: { writeRunValue: () => {} },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const vbs = calls.find((call) => call.file.endsWith('bootstrap.vbs'))
  assert.equal(vbs.encoding, 'utf16le')
  assert.equal(vbs.data.charCodeAt(0), 0xfeff)
})

test('disable removes only our own registry entry', async () => {
  const removed = []
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    // disable now also asks the supervisor to stop. This test is about the registry entry, so
    // the pid read is doubled: without it the stop check reads the literal
    // C:\dsh\dsh-autostart\supervise.pid on the real filesystem (a silent ENOENT — the same
    // hermeticity class the write side was fixed for).
    readPid: () => null,
    registry: {
      readRunValue: () => 'wscript.exe "C:\\dsh\\dsh-autostart\\bootstrap.vbs"',
      removeRunValue: () => removed.push('removed'),
    },
  })
  const res = fakeRes()
  await handlers.disable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(removed, ['removed'])
})

test('disable leaves a foreign registry entry alone', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => '"C:\\other\\thing.exe"',
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
  })
  const res = fakeRes()
  await handlers.disable(fakeReq(), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, true)
  assert.equal(payload.foreignEntry, true)
})

// ------------------------------------------------------- restart: hand over first

/**
 * Handler deps for the restart route: config.json reports present and every dangerous seam is
 * doubled. `spawnHelper` throws, so a test that reaches it proves a seam it expected to be
 * used was not.
 *
 * `writeRestartRequest`/`readRestartRequest` are a matched in-memory restart.request: the write
 * records the pid, the read-back returns it. Without the pair the route would write, and read
 * back, the literal `C:\dsh\...` path on the real filesystem — writePid swallows the ENOENT, so
 * the read-back would then (correctly) refuse and the test would pass or fail by accident.
 */
function restartRouteDeps(overrides = {}) {
  let requestOnDisk = null
  return {
    platform: 'win32',
    dshHome: HOME,
    fs: { existsSync: () => true },
    spawnHelper: () => {
      throw new Error('must not launch a real helper in this test')
    },
    scheduleExit: () => {},
    writeRestartRequest: (file, pid) => {
      requestOnDisk = pid
    },
    readRestartRequest: () => requestOnDisk,
    ...overrides,
  }
}

test('restart refuses and stays alive when no supervisor can be started', async () => {
  // The whole point of the new order: nothing may exit before a supervisor is confirmed,
  // because an exit with nobody to restart DSH is the exact failure this design removes.
  const written = []
  const exits = []
  const handlers = createHandlers(
    restartRouteDeps({
      currentPid: 1234,
      supervisor: {
        isAlive: () => false,
        start: async () => {
          throw new Error('launcher exited 1')
        },
      },
      writeRestartRequest: (file, pid) => written.push([file, pid]),
      scheduleExit: (fn) => exits.push(fn),
    }),
  )
  const res = fakeRes()
  await handlers.restart(fakeReq(), res)
  assert.equal(res.statusCode, 500)
  assert.match(res.body, /could not start the supervisor/)
  assert.deepEqual(written, [], 'no request may be written when nobody will take over')
  assert.deepEqual(exits, [], 'DSH must not be asked to exit when nothing will take over')
})

test('restart writes a request naming this process and only then arms the exit', async () => {
  const order = []
  let requestOnDisk = null
  const handlers = createHandlers(
    restartRouteDeps({
      currentPid: 4321,
      supervisor: {
        isAlive: () => true,
        start: async () => {
          order.push('start')
        },
      },
      writeRestartRequest: (file, pid) => {
        requestOnDisk = pid
        order.push(['request', file, pid])
      },
      readRestartRequest: () => requestOnDisk,
      scheduleExit: () => order.push('exit'),
    }),
  )
  const res = fakeRes()
  await handlers.restart(fakeReq(), res)
  assert.equal(res.statusCode, 202)
  // One assertion, three pins: nothing started a second supervisor, the request names THIS
  // pid (the supervisor honours only a request naming the child it saw exit), it lands on the
  // path the supervisor itself derives, and the exit comes last.
  assert.deepEqual(order, [['request', restartRequestFile(HOME), 4321], 'exit'])
})

test('restart starts a supervisor that is not alive, naming this process as the takeover pid', async () => {
  const started = []
  const handlers = createHandlers(
    restartRouteDeps({
      currentPid: 4321,
      supervisor: {
        isAlive: () => false,
        start: async (pid) => started.push(pid),
      },
    }),
  )
  const res = fakeRes()
  await handlers.restart(fakeReq(), res)
  assert.equal(res.statusCode, 202)
  assert.deepEqual(started, [4321], 'the supervisor is told which DSH it must take over from')
})

test('restart refuses and stays up when the handover signal is not on disk', async () => {
  // The write cannot report failure: writeRestartRequest is writePid, which wraps
  // fs.writeFileSync in a bare catch ("best effort: a failure here must never take the caller
  // down"). So a 202 here would mean this host exits while the supervisor, finding no request
  // naming the child it just saw exit, logs "exited without a restart request; nothing to do"
  // and stands down — DSH stays down. The read-back is what makes the signal verified.
  const exits = []
  let attempts = 0
  let requestOnDisk = null
  const handlers = createHandlers(
    restartRouteDeps({
      currentPid: 4321,
      supervisor: { isAlive: () => true, start: async () => {} },
      // The first write lands nowhere, exactly as a failed writeFileSync would (and the closed
      // writePid would swallow). The read-back is an explicit null, not a read of a literal
      // path that happens not to exist on this machine.
      writeRestartRequest: () => {
        attempts += 1
        if (attempts > 1) requestOnDisk = 4321
      },
      readRestartRequest: () => requestOnDisk,
      scheduleExit: (fn) => exits.push(fn),
    }),
  )
  const first = fakeRes()
  await handlers.restart(fakeReq(), first)
  assert.equal(first.statusCode, 500)
  // Its own label: this failure is not a launcher failure, and client.js renders the text.
  assert.match(first.body, /could not write the restart request/)
  assert.doesNotMatch(first.body, /could not start the supervisor/)
  assert.deepEqual(exits, [], 'nothing may exit while the handover signal is missing')
  const second = fakeRes()
  await handlers.restart(fakeReq(), second)
  assert.equal(second.statusCode, 202, 'a failed handover must not lock the button forever')
  assert.equal(exits.length, 1, 'the retry that wrote a confirmed request may arm the exit')
})

test('restart writes a real request file that the read-back confirms', async () => {
  // The read-back must agree with the REAL writer and the REAL path derivation, not only with a
  // test double: this runs the default write against a temp home and reads it back from
  // restartRequestFile(home).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-request-'))
  try {
    fs.mkdirSync(configDir(dir), { recursive: true })
    const handlers = createHandlers({
      platform: 'win32',
      dshHome: dir,
      fs: { existsSync: () => true },
      currentPid: SUPERVISOR_PID,
      supervisor: { isAlive: () => true, start: async () => {} },
      scheduleExit: () => {},
    })
    const res = fakeRes()
    await handlers.restart(fakeReq(), res)
    assert.equal(res.statusCode, 202)
    assert.equal(
      readPid(restartRequestFile(dir)),
      SUPERVISOR_PID,
      'the real write must satisfy the real read-back',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the scheduled exit delay is clamped below the supervisor takeover window', async () => {
  const delays = []
  const run = async (exitDelayMs) => {
    const handlers = createHandlers(
      restartRouteDeps({
        config: { exitDelayMs },
        currentPid: 4321,
        supervisor: { isAlive: () => true, start: async () => {} },
        scheduleExit: (fn, ms) => delays.push(ms),
      }),
    )
    const res = fakeRes()
    await handlers.restart(fakeReq(), res)
    assert.equal(res.statusCode, 202)
  }
  // A freshly started supervisor waits only DEFAULT_TAKEOVER_EXIT_MS (service.js, 30s) for this
  // pid to exit. A user-set delay past that window makes the takeover give up and stand down,
  // which turns a restart into a shutdown.
  await run(60000)
  assert.deepEqual(delays, [5000], 'a delay above the cap must be clamped')
  assert.ok(delays[0] < 30000, 'the clamp must stay inside the supervisor takeover window')
  await run(200)
  assert.deepEqual(delays, [5000, 200], 'a delay below the cap is honoured as configured')
})

test('the three state files are derived from the directory config.json lives in', () => {
  // R2, the silent failure this pins down: the supervisor computes its three files as
  // path.dirname(configPath) from the --config path it is handed. If the route's idea of that
  // directory drifts, restart.request lands in a file nobody watches and the restart simply
  // never happens — no error anywhere. The cross-file agreement (the route's request path vs
  // the config path the launcher is handed) is pinned in host-restart.test.js's custom-home
  // test, where both values come from the production code.
  const dir = path.dirname(configFilePath(HOME))
  assert.equal(restartRequestFile(HOME), path.join(dir, 'restart.request'))
  assert.equal(supervisePidFile(HOME), path.join(dir, 'supervise.pid'))
  assert.equal(superviseStopFile(HOME), path.join(dir, 'supervise.stop'))
})

// ------------------------------------------------------- supervisor launcher

test('defaultSupervisor.isAlive is true only for a live pid in supervise.pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup-alive-'))
  try {
    fs.mkdirSync(configDir(dir), { recursive: true })
    // No pid file at all: nothing to take over from.
    assert.equal(defaultSupervisor(dir, { isAlive: () => true }).isAlive(), false)
    // The pid is read from the real file the supervisor writes; liveness is injected so no
    // real process is ever signalled.
    writePid(supervisePidFile(dir), SUPERVISOR_PID)
    assert.equal(defaultSupervisor(dir, { isAlive: () => false }).isAlive(), false)
    assert.equal(
      defaultSupervisor(dir, { isAlive: (pid) => pid === SUPERVISOR_PID }).isAlive(),
      true,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'starting a supervisor waits, on the injected clock, for a live supervise.pid',
  { timeout: 1000 },
  async () => {
    // The budget is the point: this test must fail rather than hang if the wait regresses
    // into a real poll of a real clock.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-start-'))
    try {
      let ticks = 0
      let launched = null
      const supervisor = defaultSupervisor(dir, {
        spawnHelper: (input) => {
          launched = input
        },
        // The launch is what makes the pid appear: the first check sees nothing, the poll
        // after the launch sees a live pid. No filesystem, no real process, no real seconds.
        readPid: () => (ticks === 0 ? null : SUPERVISOR_PID),
        isAlive: () => true,
        now: () => ticks,
        sleep: async () => {
          ticks += 1
        },
        timeoutMs: 10,
        intervalMs: 1,
      })
      assert.equal(supervisor.isAlive(), false)
      assert.equal(await supervisor.start(4321), SUPERVISOR_PID)
      assert.equal(ticks, 1, 'the wait must poll once and then find the pid, not sleep a fixed wait')
      assert.equal(launched.takeoverPid, 4321, 'the helper key is takeoverPid, not oldPid')
      assert.equal(launched.configPath, configFilePath(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'starting a supervisor times out with an error that says what it saw',
  { timeout: 1000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-start-timeout-'))
    try {
      const advancingClock = () => {
        let tick = 0
        return () => (tick += 1000)
      }
      const never = defaultSupervisor(dir, {
        spawnHelper: () => {},
        readPid: () => null,
        isAlive: () => true,
        now: advancingClock(),
        sleep: async () => {},
        timeoutMs: 10000,
      })
      await assert.rejects(
        () => never.start(4321),
        (error) => {
          assert.match(error.message, /did not come up within 10000ms/)
          assert.match(error.message, /supervise\.pid was not written/, 'the error must name what it saw')
          return true
        },
      )
      const dead = defaultSupervisor(dir, {
        spawnHelper: () => {},
        readPid: () => SUPERVISOR_PID,
        isAlive: () => false,
        now: advancingClock(),
        sleep: async () => {},
        timeoutMs: 10000,
      })
      await assert.rejects(
        () => dead.start(4321),
        (error) => {
          assert.match(error.message, new RegExp(`supervise\\.pid names pid ${SUPERVISOR_PID}`))
          assert.match(error.message, /not alive/)
          return true
        },
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('the supervisor liveness rule is the codebase rule: only ESRCH means gone', () => {
  // Same function the supervisor uses (service.js defaultIsAlive), pinned here because the
  // restart route relies on it too. A false "gone" would let a second supervisor start over a
  // live one.
  assert.equal(isProcessAlive(SUPERVISOR_PID, () => {}), true)
  assert.equal(isProcessAlive(SUPERVISOR_PID, throwCode('EPERM')), true, 'EPERM is a live process we may not signal')
  assert.equal(isProcessAlive(SUPERVISOR_PID, throwCode('ESRCH')), false)
})

// ------------------------------------------------------- stop marker

test('disable writes supervise.stop naming the live supervisor, without waiting for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-stop-'))
  try {
    fs.mkdirSync(configDir(dir), { recursive: true })
    const vbsPath = path.join(configDir(dir), 'bootstrap.vbs')
    const removed = []
    writePid(supervisePidFile(dir), SUPERVISOR_PID)
    const handlers = createHandlers({
      platform: 'win32',
      dshHome: dir,
      registry: {
        readRunValue: () => registryCommand(vbsPath),
        removeRunValue: () => removed.push('removed'),
      },
      isProcessAlive: (pid) => pid === SUPERVISOR_PID,
    })
    const res = fakeRes()
    // Deliberately NOT awaited. The supervisor reads this marker only after its child exits,
    // so the route must write it and move on: an `await` before the write (a poll for the
    // supervisor's death, say) would leave the marker unwritten here, and a marker poll is
    // the resident timer this design removed.
    const pending = handlers.disable(fakeReq(), res)
    assert.equal(readPid(superviseStopFile(dir)), SUPERVISOR_PID)
    assert.notEqual(readPid(superviseStopFile(dir)), process.pid, 'never the host pid')
    assert.deepEqual(removed, ['removed'], 'the registry entry is still removed')
    await pending
    assert.equal(res.statusCode, 200)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('disable writes no stop marker when the pid file names nothing alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-stop-none-'))
  try {
    fs.mkdirSync(configDir(dir), { recursive: true })
    const vbsPath = path.join(configDir(dir), 'bootstrap.vbs')
    const registry = {
      readRunValue: () => registryCommand(vbsPath),
      removeRunValue: () => {},
    }
    // No supervise.pid: nothing to stop.
    const noPid = createHandlers({ platform: 'win32', dshHome: dir, registry })
    await noPid.disable(fakeReq(), fakeRes())
    assert.equal(fs.existsSync(superviseStopFile(dir)), false)
    // A pid file naming a process that is not alive: leaving it a marker would be litter.
    writePid(supervisePidFile(dir), SUPERVISOR_PID)
    const dead = createHandlers({
      platform: 'win32',
      dshHome: dir,
      registry,
      isProcessAlive: () => false,
    })
    await dead.disable(fakeReq(), fakeRes())
    assert.equal(fs.existsSync(superviseStopFile(dir)), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupAutostart stops a live supervisor only on a real uninstall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-stop-uninstall-'))
  try {
    fs.mkdirSync(configDir(dir), { recursive: true })
    const vbsPath = path.join(configDir(dir), 'bootstrap.vbs')
    const installed = path.join(dir, 'installed', 'service.js')
    fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.writeFileSync(installed, '', 'utf8')
    writePid(supervisePidFile(dir), SUPERVISOR_PID)
    const removed = []
    const deps = {
      dshHome: dir,
      serviceJsPath: installed,
      registry: {
        readRunValue: () => registryCommand(vbsPath),
        removeRunValue: () => removed.push('removed'),
      },
      isProcessAlive: (pid) => pid === SUPERVISOR_PID,
    }
    // Still installed: disposal is a reload, not an uninstall. The entry AND the supervisor
    // must both survive, or every plugin reload kills the user's DSH.
    cleanupAutostart(deps)
    assert.deepEqual(removed, [], 'a reload must not remove the entry')
    assert.equal(fs.existsSync(superviseStopFile(dir)), false, 'a reload must not stop the supervisor')
    // Really uninstalled: our service.js is gone.
    fs.rmSync(installed, { force: true })
    cleanupAutostart(deps)
    assert.deepEqual(removed, ['removed'])
    assert.equal(readPid(superviseStopFile(dir)), SUPERVISOR_PID)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
