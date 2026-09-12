// Start a resident supervisor out of DSH's job object, and ask one to stop.
//
// The restart route must never let this host die with nobody to take over. This module is the
// two halves of that: `isAlive()` answers "is a supervisor already watching this home?", and
// `start(selfPid)` launches one through the existing WMI relay (lib/launch-helper.js) and
// WAITS, bounded, until `supervise.pid` names a live process. Only once that returns does the
// route write `restart.request` and schedule this host's exit.
import { fileURLToPath } from 'node:url'
import { configFilePath, supervisePidFile } from './config.js'
import { readPid, writePid } from './supervise-state.js'
import { defaultIsAlive } from '../service.js'

/** How long start() waits for supervise.pid to name a live pid before giving up. */
const DEFAULT_START_TIMEOUT_MS = 10000

/** How often that wait re-reads the pid file. */
const DEFAULT_POLL_INTERVAL_MS = 250

/** This package's service.js, the entry point the launcher is told to run. */
const SERVICE_JS = fileURLToPath(new URL('../service.js', import.meta.url))

/**
 * The codebase's liveness rule, reused — not re-implemented.
 *
 * Only ESRCH means "gone". Any other error, notably EPERM for a live process this user may not
 * signal, must report ALIVE: a false "gone" would let a second supervisor start over a live one
 * and race it for the port. Re-exported here so the plugin's callers have one name for it.
 */
export const isProcessAlive = defaultIsAlive

/**
 * Write the stop marker naming a supervisor.
 *
 * The pid written MUST be the supervisor's (the one in `supervise.pid`), never this host's:
 * `isStopRequested` honours a marker only when it names the supervisor itself, so a marker
 * carrying DSH's pid is inert.
 *
 * Nothing here waits for the supervisor to exit, and that is deliberate. The supervisor reads
 * this marker only AFTER its child (DSH) exits, so writing it while DSH is alive does not make
 * the supervisor exit now — disabling autostart must not close the user's running DSH. Do not
 * "fix" that by polling for the supervisor's death: a resident timer is exactly what this
 * design removed. The marker is named for the moment DSH does go away.
 */
export function writeSuperviseStop(file, pid) {
  writePid(file, pid)
}

/**
 * A handle on the supervisor for one dsh home.
 *
 * @param dshHome - the resolved DSH home; the three state files are derived from it.
 * @param deps.spawnHelper - required. The WMI relay (index.js defaultSpawnHelper) that creates
 *   the supervisor outside DSH's job object.
 * @param deps.execPath, deps.serviceJsPath, deps.configPath - what the relay is told to run.
 *   `configPath` defaults to `configFilePath(dshHome)`; handing the supervisor any other
 *   config.json would put its state files in a directory this host does not write to.
 * @param deps.readPid, deps.isAlive, deps.now, deps.sleep - seams. Tests inject all four so
 *   the wait is deterministic and never spends real seconds or signals a real process.
 * @param deps.timeoutMs, deps.intervalMs - the bound on that wait.
 */
export function defaultSupervisor(dshHome, deps = {}) {
  // The pid file path is not a seam: `supervisePidFile(dshHome)` is the single source shared
  // with the route (lib/config.js), and tests inject `readPid` instead of relocating the file.
  const pidFile = supervisePidFile(dshHome)
  const read = deps.readPid ?? readPid
  const alive = deps.isAlive ?? isProcessAlive
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const spawnHelper = deps.spawnHelper
  const execPath = deps.execPath ?? process.execPath
  const serviceJsPath = deps.serviceJsPath ?? SERVICE_JS
  const configPath = deps.configPath ?? configFilePath(dshHome)

  const livePid = () => {
    const pid = read(pidFile)
    return pid !== null && alive(pid) ? pid : null
  }

  return {
    /** Whether a supervisor is already watching this home. */
    isAlive() {
      return livePid() !== null
    },

    /**
     * Launch a supervisor that will take over from `selfPid`, and wait for it to claim
     * `supervise.pid`.
     *
     * @returns the supervisor's pid, or throws a diagnosable error: the caller must NOT let
     *   this host exit when no supervisor came up.
     */
    async start(selfPid) {
      if (typeof spawnHelper !== 'function') {
        throw new Error('defaultSupervisor: spawnHelper is required to start a supervisor')
      }
      // The relay's key is `takeoverPid`: it names the DSH that is about to exit so the
      // supervisor waits for it and then starts the replacement.
      await spawnHelper({ execPath, serviceJsPath, takeoverPid: selfPid, configPath })
      const deadline = now() + timeoutMs
      // Bounded twice on purpose: by the injected clock AND by a poll count. A clock that
      // never advances (a test double, a machine resumed from suspend) must not be able to
      // turn this wait into a hang, because the route is holding a user's request.
      const maxPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs))) + 1
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const pid = livePid()
        if (pid !== null) return pid
        if (now() >= deadline) break
        await sleep(intervalMs)
      }
      // Say what was seen: "did not come up" alone cannot distinguish a supervisor that never
      // wrote its pid from one that wrote a pid nothing is listening on.
      const seen = read(pidFile)
      const detail = seen === null ? 'supervise.pid was not written' : `supervise.pid names pid ${seen}, which is not alive`
      throw new Error(`the supervisor did not come up within ${timeoutMs}ms (${detail})`)
    },
  }
}
