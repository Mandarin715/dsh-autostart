import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('defaultSpawnHelper fails synchronously when the helper or node is missing', () => {
  // spawn's ENOENT arrives as an async 'error' event that try/catch cannot see;
  // these two existence checks turn the common failures into synchronous throws,
  // so the route can answer 500 instead of the host dying. Both checks throw
  // before spawn, so this test launches no process.
  assert.throws(
    () =>
      defaultSpawnHelper({
        execPath: process.execPath,
        serviceJsPath: 'C:\\definitely\\missing\\service.js',
        cwd: '.',
        oldPid: 1,
      }),
    /restart helper not found/,
  )
  assert.throws(
    () =>
      defaultSpawnHelper({
        execPath: 'C:\\definitely\\missing\\node.exe',
        serviceJsPath: import.meta.filename,
        cwd: '.',
        oldPid: 1,
      }),
    /node executable not found/,
  )
})
