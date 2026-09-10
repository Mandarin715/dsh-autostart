import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { isPortListening, waitForPort } from '../lib/port.js'

/** Start a throwaway TCP server on an OS-assigned port. */
function listenOnce() {
  return new Promise((resolve) => {
    const server = net.createServer(() => {})
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('returns true for a listening port', async () => {
  const server = await listenOnce()
  const port = server.address().port
  assert.equal(await isPortListening(port), true)
  server.close()
})

test('returns false for a closed port', async () => {
  const server = await listenOnce()
  const port = server.address().port
  await new Promise((r) => server.close(r))
  assert.equal(await isPortListening(port), false)
})

test('waitForPort resolves true once the port opens', async () => {
  const server = await listenOnce()
  const port = server.address().port
  assert.equal(await waitForPort(port, { timeoutMs: 2000, intervalMs: 50 }), true)
  server.close()
})

test('waitForPort resolves false on timeout', async () => {
  const server = await listenOnce()
  const port = server.address().port
  await new Promise((r) => server.close(r))
  assert.equal(await waitForPort(port, { timeoutMs: 400, intervalMs: 50 }), false)
})
