#!/usr/bin/env node
// dsh-autostart — the resident supervisor.
//
// Modes:
//   supervise                    the real entry point: own DSH's lifetime
//   supervise --takeover <pid>   take over from that DSH once it exits
//   start                        an alias of `supervise` (bootstrap.vbs snapshots this name at
//                                enable time, so old installs must keep working without
//                                re-enabling autostart)
//
// Any other mode — `restart` included — is refused with exit code 2: DSH now hands a supervisor
// out of its job and writes a restart request instead.
//
// DSH is spawned attached to this process's hidden console, so this process's life is what keeps
// DSH alive: it may not exit before DSH does. That is why it stays resident instead of checking
// the port and returning.
//
// This file intentionally imports nothing from the DSH runtime: it reads
// config.json and drives the OS, so it can be run by hand for debugging:
//     node service.js supervise --config <abs path to config.json>
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isPortListening, waitForPort } from './lib/port.js'
import { parseConfigFile, resolveDshHome, configFilePath } from './lib/config.js'
import { powershellPath } from './lib/launch-helper.js'
import {
  anotherSupervisorAlive,
  readPid,
  writePid,
  clearFile,
  consumeRestartRequest,
  isStopRequested,
} from './lib/supervise-state.js'

const SERVICE_JS = fileURLToPath(import.meta.url)

// How long a port that keeps answering is re-probed before it is called another service's.
// A port can still answer for an instant after the process that owned it dies, which is what
// made a single probe unsafe right after a restart (see waitForFreePort).
const DEFAULT_PORT_PROBE_WINDOW_MS = 3000
const DEFAULT_PORT_PROBE_INTERVAL_MS = 250

// How long `supervise --takeover <pid>` waits for that DSH to exit before concluding it is
// not going to. See runSupervise: without the takeover shape an on-demand supervisor would
// see a busy port, stand down, and leave nobody to restart DSH when the old one exits.
//
// Exported because index.js's MAX_EXIT_DELAY_MS must stay below it (that clamp only exists to let
// the restart response flush, so a delay past this window would make the takeover give up and
// stand down — i.e. a restart would become a shutdown). The clamp test imports this constant
// instead of restating the number, so lowering it below MAX_EXIT_DELAY_MS fails a test.
export const DEFAULT_TAKEOVER_EXIT_MS = 30000

// The supervisor retries a start that never came up. Backoff grows 1s, 1.5s, 2.25s … and
// the whole effort is bounded so a permanently broken command cannot retry forever.
const DEFAULT_SUPERVISE_ATTEMPTS = 5
const DEFAULT_SUPERVISE_BACKOFF_MS = 1000
const DEFAULT_SUPERVISE_BACKOFF_FACTOR = 1.5
const DEFAULT_SUPERVISE_TOTAL_MS = 5 * 60 * 1000

/** Load and validate config.json. */
export function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8')
  return parseConfigFile(text)
}

/**
 * Environment for the replacement DSH instance.
 *
 * On the on-demand path the supervisor is created by the WMI service, which does
 * NOT pass on the caller's environment, so the replacement would otherwise start
 * without DSH_HOME and — for anyone using a non-default home — against the wrong
 * one. (The login path has no such boundary, but this function does not need to
 * know which one it is on.) The home captured at enable time (config.json) is
 * re-asserted here. When nothing was captured the base environment is returned
 * untouched, so an older config keeps working.
 */
export function dshEnv(config, base = process.env) {
  const home = config?.dshHome
  if (typeof home !== 'string' || home === '') return base
  return { ...base, DSH_HOME: home }
}

/**
 * Launch DSH attached to this process's console.
 *
 * The two flags below are there for different reasons, and they were not measured the same way.
 *
 * `windowsHide: false` is what keeps the child sharing this process's console instead of being
 * given CREATE_NO_WINDOW: DSH's sandbox cannot give its tool subprocesses their own hidden
 * console under the restricted token (dsh-sandbox-windows-acl: CREATE_NO_WINDOW children die
 * with STATUS_DLL_INIT_FAILED), so they must share the host's — and a host with no console made
 * each of them create a fresh one that Windows 11 handed to Windows Terminal: one visible window
 * per command (F9).
 *
 * `detached: false` is what keeps the child attached to that console, and its consequence is
 * about the child's LIFE, not the window. The A/B test in docs/ACCEPTANCE.md (F9) varied
 * `detached` alone, with a WMI-created parent that exited immediately, and measured an attached
 * child gone within ~1.4s of its parent (1.37s at 1s resolution, Task 1) versus >2.5 minutes for
 * a detached one. So this function may only be called by a process that stays alive for DSH's
 * whole lifetime — the supervisor. `windowsHide` was held constant in that test and has not been
 * isolated on its own.
 *
 * Returns the ChildProcess handle, not its pid. The caller is the process that has to
 * outlive DSH, and it learns of DSH's exit from that handle's 'exit' event — the spec is
 * explicit that the host's liveness is judged by `child.on('exit')` and not by polling. A
 * pid cannot carry that: once the child is gone the pid says nothing, and a recycled one
 * would say the opposite of the truth.
 */
export function spawnDsh(config, log = () => {}, deps = {}) {
  // parseConfigFile does not validate logPaths (it cannot — it never receives
  // dshHome), so guard it here: an unguarded openSync would throw a TypeError
  // that escapes main's contract of returning an exit code.
  if (typeof config?.logPaths?.out !== 'string' || typeof config?.logPaths?.err !== 'string') {
    throw new Error('config: logPaths.out and logPaths.err are required to capture DSH output')
  }
  const out = fs.openSync(config.logPaths.out, 'a')
  const err = fs.openSync(config.logPaths.err, 'a')
  const spawnImpl = deps.spawn ?? spawn
  const child = spawnImpl(config.command.execPath, config.command.argv, {
    cwd: config.command.cwd,
    detached: false,
    windowsHide: false,
    stdio: ['ignore', out, err],
    env: dshEnv(config, deps.baseEnv ?? process.env),
  })
  // A bad execPath emits 'error'; with no listener Node rethrows it as an
  // uncaught exception, killing this hidden login supervisor before it can report
  // anything. Swallow it into the log and let the port wait below surface the
  // failure as "did not come up".
  child.once('error', (error) => {
    log(`spawn error: ${error instanceof Error ? error.message : String(error)}`)
  })
  // Close this process's copies of the two log handles. `spawn` has already handed them to the
  // child, which holds its own; keeping ours open leaked two descriptors per spawn — per retry
  // and per re-entrant restart — which was harmless while the helper was one-shot but is
  // unbounded now that the supervisor is resident. Closing them cannot truncate the child's
  // output: it writes through its own descriptors.
  fs.closeSync(out)
  fs.closeSync(err)
  // Deliberately NOT child.unref(): with `detached: false` the child's life is governed by
  // the console it is attached to, not by this handle, so unref would be inert — and its
  // old "the child outlives us" meaning is exactly what the contract above forbids.
  //
  // The handle is returned, not `child.pid`, because the supervisor must learn that DSH exited
  // from the handle's 'exit' event rather than by polling the pid (spec §"判断宿主死活用
  // child.on('exit')，不轮询"). Holding the handle is what makes that possible; the pid alone
  // cannot distinguish "still running" from "exited and recycled".
  return child
}

/** Pick the interpreter for a hook script by extension. */
function hookInvocation(script) {
  const ext = path.extname(script).toLowerCase()
  if (ext === '.ps1') {
    // Absolute for the same reason the launcher is: a bare name is resolved with
    // the current directory searched first.
    return [powershellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
  }
  if (ext === '.cmd' || ext === '.bat') return ['cmd.exe', ['/c', script]]
  return [script, []]
}

/**
 * Run the optional hook script. A hook failure NEVER blocks DSH startup.
 *
 * stderr is piped (not ignored) and appended to the log: §7 requires the exit
 * code AND stderr to be recorded, and "hook exited code=1" on its own tells the
 * user nothing about why their hook failed.
 */
export function runHook(config, log, deps = {}) {
  const script = config.hookScript
  if (typeof script !== 'string' || script === '') return Promise.resolve({ ran: false })
  const exists = deps.exists ?? fs.existsSync
  if (!exists(script)) {
    log(`hook not found: ${script}`)
    return Promise.resolve({ ran: false, missing: true })
  }
  const spawnHook =
    deps.spawnHook ??
    ((cmd, args, options = {}) =>
      spawn(cmd, args, { windowsHide: true, stdio: options.stdio ?? ['ignore', 'ignore', 'pipe'] }))
  const [cmd, args] = hookInvocation(script)
  return new Promise((resolve) => {
    let child
    try {
      child = spawnHook(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      log(`hook spawn error: ${error.message}`)
      resolve({ ran: true, failed: true })
      return
    }
    child.once('error', (error) => {
      log(`hook error: ${error.message}`)
      resolve({ ran: true, failed: true })
    })
    // Attach before 'close' resolves, so no stderr chunk is lost to the race
    // between the stream ending and the process being reported closed.
    let stderrText = ''
    if (child.stderr !== undefined && child.stderr !== null) {
      child.stderr.setEncoding?.('utf8')
      child.stderr.on('data', (chunk) => {
        stderrText += chunk
      })
    }
    child.once('close', (code) => {
      log(`hook exited code=${code}`)
      // A failing hook must stay visible in the log without being able to break
      // startup, so each non-empty line is logged separately and any error in
      // the reading itself is swallowed.
      try {
        for (const line of stderrText.split(/\r?\n/)) {
          if (line !== '') log(`hook stderr: ${line}`)
        }
      } catch {
        // best effort: the hook failure is already recorded above
      }
      resolve({ ran: true, code })
    })
  })
}

/**
 * Wait, briefly, for the port to stop answering before spawning a replacement.
 *
 * The probe is retried over a bounded window rather than trusted once. Measured
 * 2026-09-12 (docs/ACCEPTANCE.md, "restart race"): the outcome turns on a few milliseconds
 * after the old host is confirmed gone. On one run a single probe fired 4ms after the exit,
 * answered "busy", and the then-current one-shot path logged "skip start" and returned without
 * starting anything — DSH stayed down and the user saw only "reconnecting". On two later runs of
 * the same code the probe fired at +10ms and +9ms, answered "free", and the restart worked.
 *
 * What answered at +4ms was not captured (the acceptance note records what was and was not
 * observed); the practical reading is that a probe landing the instant after a process dies
 * can be answered by a socket the kernel has not released yet, and a plain connect cannot
 * tell that apart from a live foreign service. Retrying is the fix that does not depend on
 * knowing which of the two it was: a draining socket clears, while a genuinely foreign
 * listener keeps answering and the window expires exactly as before.
 */
async function waitForFreePort(probe, port, deps = {}) {
  const windowMs = deps.takeoverPortWindowMs ?? DEFAULT_PORT_PROBE_WINDOW_MS
  const intervalMs = deps.portProbeIntervalMs ?? DEFAULT_PORT_PROBE_INTERVAL_MS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + windowMs
  for (;;) {
    if (!(await probe(port))) return true
    if (now() >= deadline) return false
    await sleep(intervalMs)
  }
}

/**
 * Own DSH's lifetime: start it attached to this process's console and stay alive.
 *
 * Kept alive on purpose — see spawnDsh. Two startup shapes share this function:
 *   - plain `supervise`: start DSH if the port is free; if something else already serves
 *     it, stand down (nothing to supervise);
 *   - `supervise --takeover <pid>`: that `pid` is a DSH which is about to exit, so wait for
 *     it and then start ours. Without this shape an on-demand supervisor would see a busy
 *     port, stand down, and leave nobody to restart DSH when the old one exits.
 *
 * This function covers the start phase (guard, takeover wait, probe, bounded retry, hook) and,
 * once DSH is up, hands the running child to superviseChild — the supervision loop that decides
 * what happens when it exits. A successful return therefore means either that the port was busy
 * and this process stood down, or that a supervised DSH has since exited and the story ended.
 */
export async function runSupervise(input) {
  const { config, configPath, log } = input
  const deps = input.deps ?? {}
  const probe = deps.isPortListening ?? isPortListening
  const wait = deps.waitForPort ?? waitForPort
  const spawnImpl = deps.spawnDsh ?? spawnDsh
  const hook = deps.runHook ?? runHook
  const isAlive = deps.isProcessAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // R2: the state files live beside config.json, which is the same directory Task 8's route
  // computes as configDir(dshHome). Derived from configPath on purpose — never configDir.
  const dir = path.dirname(configPath)
  const pidFile = path.join(dir, 'supervise.pid')
  const requestFile = path.join(dir, 'restart.request')
  const stopFile = path.join(dir, 'supervise.stop')

  // Load-bearing order: anotherSupervisorAlive only tests liveness — it cannot tell
  // "another" from "ours" — so the guard must run before this process writes its own pid.
  const guard = deps.anotherSupervisorAlive ?? anotherSupervisorAlive
  if (guard(pidFile, isAlive)) {
    // The pid is logged because this line is the only diagnostic: a stale pid file naming a
    // pid that has since been reused by an unrelated live process would otherwise block
    // startup with no explanation anywhere, and service.log is the user's only window in.
    log(`another supervisor is already running (${readPid(pidFile)}); standing down`)
    return { supervised: false, reason: 'already-running' }
  }
  const writePidImpl = deps.writePid ?? writePid
  writePidImpl(pidFile, process.pid)
  log(`supervisor pid=${process.pid} watching ${config.dshPort}`)

  if (input.takeoverPid) {
    // Stated as the precondition, not as an action, because service.log is the only diagnostic
    // the user gets and the two shapes differ: a real `--takeover` genuinely waits here, while
    // the re-entrant restart path short-circuits this wait (its child's 'exit' event already
    // proved that pid is gone). "waiting for pid N to exit" would be false on that path.
    log(`takeover: pid ${input.takeoverPid} must be gone before we start`)
    const waitExit = deps.waitForProcessExit ?? waitForProcessExit
    try {
      const gone = await waitExit(input.takeoverPid, { timeoutMs: deps.takeoverExitTimeoutMs ?? DEFAULT_TAKEOVER_EXIT_MS })
      if (!gone) {
        log(`takeover: pid ${input.takeoverPid} is still alive; standing down without starting`)
        ;(deps.clearFile ?? clearFile)(pidFile)
        return { supervised: false, reason: 'takeover-timeout' }
      }
    } catch (error) {
      // Catch, never `finally`: this process wrote pidFile before entering the wait, so a wait
      // that throws must not leave it pointing at a supervisor that is exiting. A `finally`
      // would also clear it on the success path below, where this process has just become the
      // owner and the single-instance guard depends on it. The timeout path clears explicitly.
      ;(deps.clearFile ?? clearFile)(pidFile)
      throw error
    }
  } else if (!(await waitForFreePort(probe, config.dshPort, deps))) {
    // A bare single probe cannot tell a live foreign service from a socket the kernel has not
    // released yet (measured 2026-09-12, docs/ACCEPTANCE.md F8 "restart race"), and standing
    // down on a draining socket would exit reporting success while DSH is down. So the port is
    // re-probed over the whole window — waitForFreePort, above — and only a port that still
    // answers afterwards is called someone else's.
    log(`port ${config.dshPort} is served by something else after waiting ${deps.takeoverPortWindowMs ?? DEFAULT_PORT_PROBE_WINDOW_MS}ms; standing down`)
    ;(deps.clearFile ?? clearFile)(pidFile)
    return { supervised: false, reason: 'port-busy' }
  }

  const attempts = deps.superviseAttempts ?? DEFAULT_SUPERVISE_ATTEMPTS
  const startedAt = (deps.now ?? Date.now)()
  let delayMs = deps.superviseBackoffMs ?? DEFAULT_SUPERVISE_BACKOFF_MS
  let pid = null
  // Counts the attempts actually made, so the give-up line below reports the truth. Printing
  // the configured cap there contradicts the "(attempt n/N)" line that precedes it whenever the
  // loop breaks early — and service.log is the only diagnostic the user has.
  let spawned = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A previous child may still hold the port.
    if (attempt > 1 || input.takeoverPid) {
      const free = await waitForFreePort(probe, config.dshPort, deps)
      if (!free) {
        // Reachable from an ordinary retry as well as from a takeover, so the wording must not
        // claim a takeover happened.
        log(`port ${config.dshPort} still answers after waiting for it to drain; standing down`)
        break
      }
    }
    const child = spawnImpl(config, log, deps)
    pid = child.pid
    spawned = attempt
    // A failed spawn — ENOENT on a stale absolute path, the failure README §7 calls the most
    // likely real one — yields a handle with no pid. Do not claim one.
    log(
      `spawned dsh${pid === undefined ? '' : ` pid=${pid}`}` +
        (attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''),
    )
    const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
    if (up) {
      log(`port ${config.dshPort} is up`)
      await hook(config, log, deps)
      return await superviseChild({ config, configPath, log, deps, pid, child, requestFile, stopFile, pidFile })
    }
    log(`WARN port ${config.dshPort} did not come up in time (attempt ${attempt}/${attempts})`)
    // A pid-less child must never be treated as "still alive", and the guard below is what makes
    // that true — it is not obvious. Without it, defaultIsAlive(undefined) calls
    // process.kill(undefined, 0), which throws a TypeError whose code is not ESRCH, so the
    // liveness rule answers ALIVE (measured 2026-09-12). The loop would then break after one
    // attempt while logging "still alive" about a process that does not exist — collapsing the
    // documented retry and lying in the user's only diagnostic.
    if (pid !== undefined && isAlive(pid)) {
      log(`previous pid ${pid} is still alive; not starting a second instance`)
      break
    }
    if ((deps.now ?? Date.now)() - startedAt + delayMs > (deps.superviseTotalMs ?? DEFAULT_SUPERVISE_TOTAL_MS)) {
      break
    }
    await sleep(delayMs)
    delayMs = Math.round(delayMs * (deps.superviseBackoffFactor ?? DEFAULT_SUPERVISE_BACKOFF_FACTOR))
  }
  log(`giving up: DSH did not come up after ${spawned} attempt(s); supervisor exiting`)
  // Only clear a pid file that is still ours. This process writes its own pid before the start
  // loop, but two launches in the same millisecond can both pass the guard, and an unconditional
  // clear would then delete the WINNER's pid file — disarming the single-instance guard for
  // whoever comes next. On every normal path the file holds this process's pid, so this changes
  // nothing there.
  if (readPid(pidFile) === process.pid) (deps.clearFile ?? clearFile)(pidFile)
  return { supervised: false, reason: 'start-failed' }
}

/**
 * Supervise one running DSH and, when it exits, decide what happens next.
 *
 * The decision is deliberately narrow: only an exit that was *asked for* — a
 * `restart.request` naming this child — gets a replacement. A user closing DSH, or a crash,
 * ends the story; resurrecting those would be a watchdog, and a process the user cannot
 * stop is worse than a service that occasionally does not come back.
 */
async function superviseChild(input) {
  const { config, configPath, log, pid, child, requestFile, stopFile, pidFile } = input
  const deps = input.deps ?? {}
  const waitExit = deps.waitForChildExit ?? ((childPid, childHandle) => new Promise((resolve) => {
    // The handle, not the pid: an exit event cannot be confused by a recycled pid.
    // The exitCode/signalCode guard is load-bearing. This listener is attached only after
    // runSupervise finished its port wait and the hook, so a child that died in that window
    // has already emitted 'exit'; Node does not replay events, so a listener attached
    // afterwards would never fire and the supervisor would wait forever on a dead child.
    if (childHandle.exitCode !== null || childHandle.signalCode !== null) {
      resolve(childPid)
      return
    }
    childHandle.once('exit', () => resolve(childPid))
  }))
  const consumed = deps.consumeRestartRequest ?? consumeRestartRequest
  const stopped = deps.isStopRequested ?? isStopRequested
  const clear = deps.clearFile ?? clearFile

  let current = pid
  let currentChild = child
  for (;;) {
    await waitExit(current, currentChild)
    // The request is checked BEFORE the stop marker, and the order is load-bearing. Both files
    // can be pending at once and they are about different processes: the request names the child
    // that just exited, the stop marker names this supervisor. `isStopRequested` DELETES the
    // marker when it matches, so checking it first would abandon the request (and leave it on
    // disk) and report `stopped` — turning a restart the user asked for into a shutdown with DSH
    // down. It is reachable from the card: index.js writes the marker on every Disable while a
    // supervisor is live, nothing there retracts it, and the restart button stays enabled.
    //
    // A stop that is pending while a restart IS requested must not be consumed here: it names
    // this supervisor, not the child, so it has to survive the restart and govern the next exit.
    if (!consumed(requestFile, current)) {
      if (stopped(stopFile, process.pid)) {
        log('stop requested; supervisor exiting')
        clear(pidFile)
        return { supervised: false, reason: 'stopped' }
      }
      log(`dsh pid=${current} exited without a restart request; nothing to do`)
      clear(pidFile)
      return { supervised: true, pid: current, child: currentChild }
    }
    log(`restart requested for pid=${current}; starting a replacement`)
    // Re-run the start phase for one attempt; runSupervise's own guard is skipped because
    // we already own the pid file.
    //
    // The takeover wait is short-circuited because we are here only after this very child's
    // 'exit' event fired, while still holding its handle — proof it is gone. Leaving it to
    // waitForProcessExit would poll the pid instead: if the pid still reports alive (reuse, or
    // EPERM, which defaultIsAlive counts as alive) the replacement stalls for the whole 30s
    // takeover timeout, then reports restart-failed — after the restart request was already
    // consumed and deleted. That would abandon a user-requested restart silently, with DSH
    // down. R18's rule applies to this wait exactly as it does to the loop's own.
    const next = await runSupervise({
      config,
      configPath,
      log,
      deps: { ...deps, anotherSupervisorAlive: () => false, waitForProcessExit: async () => true },
      takeoverPid: current,
    })
    if (!next.supervised || !next.pid) {
      // Do not read this from `!next.supervised` alone. The start recurses into superviseChild, so
      // the frame that supervised the replacement and then ended it also returns `supervised:false`
      // here — with `reason: 'stopped'`. Calling that "did not come up" would print a false line
      // directly under the true `stop requested` one, about a replacement that demonstrably did
      // start (the `spawned dsh` and `port is up` lines above it), in the user's only diagnostic.
      // The nested reason is what tells the two apart, so it is propagated, not overwritten.
      const reason = next.reason ?? 'restart-failed'
      // These four are the reasons `runSupervise` can return when no child ever reached the
      // supervision loop. Everything else describes an end that came after a successful start —
      // with one known exception a reviewer reproduced: a `start-failed` propagated up from a
      // nested frame (three generations plus a failing start) reaches this test too, so the outer
      // frame prints "did not come up" about a replacement that did start. The outcome is
      // identical either way; only that word is wrong.
      const startFailed = ['start-failed', 'takeover-timeout', 'port-busy', 'already-running'].includes(reason)
      log(startFailed ? 'replacement did not come up; supervisor exiting' : `replacement ${reason}; supervisor exiting`)
      clear(pidFile)
      return { supervised: false, reason }
    }
    current = next.pid
    currentChild = next.child
  }
}

/**
 * Whether a pid is still alive on this OS.
 *
 * Only ESRCH means "gone". Any other error — notably EPERM, for a live process
 * this user may not signal — must report ALIVE: a false "gone" would let the
 * supervisor start a second instance while the old one may still hold the port,
 * which is the exact failure mode the takeover wait exists to avoid.
 * The `kill` seam exists so this is testable without touching a real process.
 */
export function defaultIsAlive(pid, kill = (target, signal) => process.kill(target, signal)) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * Poll until the pid disappears. Never a fixed sleep: a fast exit returns fast.
 * @returns true when the process is gone, false when the deadline passed first.
 */
export async function waitForProcessExit(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 250
  const isAlive = options.isAlive ?? defaultIsAlive
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isAlive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Log to service.log, creating the directory first. */
function makeLogger(config) {
  const target = config?.logPaths?.service
  if (typeof target !== 'string' || target === '') return () => {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  return (line) => {
    fs.appendFileSync(target, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  }
}

/**
 * CLI entry. Returns a process exit code.
 * @param argv - full `process.argv` shaped array.
 */
export async function main(argv, deps = {}) {
  const mode = argv[2]
  // An explicit --config is how the on-demand supervisor is told where config.json is:
  // WMI creates it with the provider host's environment, so DSH_HOME is absent
  // and resolveDshHome() would point at the wrong home entirely.
  const configFlag = argv.indexOf('--config')
  const named = configFlag === -1 ? null : argv[configFlag + 1]
  if (configFlag !== -1 && (typeof named !== 'string' || named === '' || named.startsWith('-'))) {
    // Present but unusable — including the `--config --takeover 5` slip, where the
    // next flag would otherwise be read as a path. Falling back silently would
    // reintroduce exactly the wrong-home failure this flag exists to prevent, so
    // refuse instead.
    return 2
  }
  const configPath = deps.configPath ?? named ?? configFilePath(resolveDshHome())
  let config
  try {
    config = readConfig(configPath)
  } catch (error) {
    // At login there is no UI to report to: log and exit quietly. The log must
    // sit next to the config file (not at a path derived by rewriting the file
    // name: for a config.json under any other name that rewrite is a no-op and
    // would append the error into the config file itself).
    try {
      const logPath = path.join(path.dirname(configPath), 'service.log')
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] cannot read config: ${error.message}\n`,
        'utf8',
      )
    } catch {
      // nothing else we can do
    }
    return 1
  }
  const log = makeLogger(config)
  // The mode dispatch runs inside a guard: spawnDsh and the logger touch the
  // filesystem, and this function's contract is to RETURN an exit code. An
  // unguarded throw would become an unhandled rejection in a hidden login
  // process, which is invisible to the user.
  const runSuperviseImpl = deps.runSupervise ?? runSupervise
  try {
    // `start` is kept as an alias: bootstrap.vbs is written at enable time and says
    // `service.js start --config …`, so old installs must keep working without the user
    // re-enabling autostart. `supervise` is the real entry point.
    if (mode === 'start' || mode === 'supervise') {
      const takeoverFlag = argv.indexOf('--takeover')
      const takeoverRaw = takeoverFlag === -1 ? null : argv[takeoverFlag + 1]
      const takeoverPid = takeoverRaw === null ? null : Number(takeoverRaw)
      if (takeoverRaw !== null && (!Number.isInteger(takeoverPid) || takeoverPid <= 0)) return 2
      // `deps` here is main's own parameter, not the seam bag the mode implementation wants —
      // this function's argument IS the options object, so the bag has to be handed over under
      // its own key explicitly. A `{ …, deps }` shorthand would bind to the parameter and the
      // supervisor would silently lose every injected seam.
      const modeDeps = deps.deps ?? {}
      await runSuperviseImpl({ config, log, deps: modeDeps, configPath, takeoverPid })
      return 0
    }
    if (mode === 'restart') {
      // The mode is gone: DSH now hands the supervisor out of its job and writes a
      // restart request instead. Refuse loudly — a silent 0 here would tell the caller
      // DSH is coming back when nothing is going to start it.
      log('restart is no longer a mode; use supervise --takeover <pid>')
      return 2
    }
    return 2
  } catch (error) {
    log(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === path.resolve(SERVICE_JS)) {
  process.exitCode = await main(process.argv)
}
