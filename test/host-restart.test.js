import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandlers, countRunningAgents } from '../index.js'

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
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    currentPid: 4321,
    spawnHelper: (deps) => calls.push(deps),
    scheduleExit: () => {},
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].oldPid, 4321)
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
