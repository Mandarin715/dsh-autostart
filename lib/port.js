// Port liveness via a real TCP connect.
//
// Deliberately NOT `netstat` text parsing and NOT a `:port` substring match:
// those also match TIME_WAIT sockets and client-side connections, which made a
// previous incarnation report "already running" while the service was down.
import net from 'node:net'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PROBE_TIMEOUT_MS = 700

/**
 * Whether something accepts TCP connections on the given port.
 * @returns true on a completed TCP handshake; false on refusal or timeout.
 */
export function isPortListening(port, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Poll until the port is listening or the deadline passes. Conditional polling
 * (no fixed sleep) so a fast start returns immediately.
 */
export async function waitForPort(port, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isPortListening(port, { host })) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
