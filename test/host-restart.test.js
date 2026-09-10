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

test('countRunningAgents counts only running agents', () => {
  const agents = { list: () => [{ status: 'running' }, { status: 'idle' }, { status: 'running' }] }
  assert.equal(countRunningAgents(agents), 2)
  assert.equal(countRunningAgents(undefined), 0)
  // A service object with no usable list() is "cannot be read", not "nothing is
  // running" — see the unknown-state test below. Stale pre-amendment assertion.
  assert.equal(countRunningAgents({}), null)
})

test('restart refuses while a restart is already scheduled', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    spawnHelper: () => {},
    scheduleExit: () => {},
  })
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
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    currentPid: 4321,
    spawnHelper: (deps) => calls.push(deps),
    scheduleExit: () => {
      exits += 1
    },
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].oldPid, 4321)
  assert.equal(exits, 1)
})

test('restart returns 500 and schedules no exit when the helper fails to spawn', async () => {
  let exits = 0
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    spawnHelper: () => {
      throw new Error('spawn boom')
    },
    scheduleExit: () => {
      exits += 1
    },
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 500)
  assert.equal(exits, 0)
})

test('restart blocks when agents are running and the guard is on', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    config: { blockWhenAgentsRunning: true },
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    agents: { list: () => [{ status: 'running' }] },
    spawnHelper: () => {},
    // Returning 409 already short-circuits today, but if the gate ever regressed
    // the default setTimeout(() => process.exit(0)) would arm a real exit and
    // kill the test runner — so inject a no-op.
    scheduleExit: () => {},
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /agent/i)
})

test('countRunningAgents reports unknown rather than zero when the list cannot be read', () => {
  // This backs a protection the user explicitly opted into: when the agent list
  // cannot be read the result must be "unknown", never 0 — 0 would silently lift
  // the protection, which is the unsafe direction.
  assert.equal(countRunningAgents(undefined), 0)
  assert.equal(countRunningAgents({ list: () => [] }), 0)
  assert.equal(countRunningAgents({ list: () => [{ status: 'running' }] }), 1)
  assert.equal(countRunningAgents({ list: () => { throw new Error('boom') } }), null)
  assert.equal(countRunningAgents({ list: () => 'not-an-array' }), null)
})

test('restart refuses when the agent list cannot be read and the gate is on', async () => {
  // This one guards the branch this fix wave is about: without it, reverting the
  // gate to `running > 0` would still leave the whole suite green.
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    config: { blockWhenAgentsRunning: true },
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
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
  })
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
