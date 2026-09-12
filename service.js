#!/usr/bin/env node
// dsh-autostart — detached helper.
//
// Modes:
//   start    used by bootstrap.vbs at login
//   restart  used by the plugin's restart button (waits for the old pid first)
//
// This file intentionally imports nothing from the DSH runtime: it reads
// config.json and drives the OS, so it can be run by hand for debugging:
//     node service.js start
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
// made a single probe unsafe right after a restart (see runStart).
const DEFAULT_PORT_PROBE_WINDOW_MS = 3000
const DEFAULT_PORT_PROBE_INTERVAL_MS = 250

// A start that never came up is retried this many times, with this pause, provided the
// failed child is gone by then (see runStart).
const DEFAULT_START_ATTEMPTS = 3
const DEFAULT_START_RETRY_DELAY_MS = 3000

// How long the single last-resort attempt waits before trying again (see
// scheduleSecondChance). Long enough for a slow first start, a busy antivirus scan or a
// port that is still draining to clear; short enough that a user staring at a dead page
// does not give up first.
const DEFAULT_SECOND_CHANCE_DELAY_MS = 60000

// Upper bound for --delay, so a mistyped value cannot park a process for days.
const MAX_DELAY_MS = 24 * 60 * 60 * 1000

// How long `supervise --takeover <pid>` waits for that DSH to exit before concluding it is
// not going to. See runSupervise: without the takeover shape an on-demand supervisor would
// see a busy port, stand down, and leave nobody to restart DSH when the old one exits.
const DEFAULT_TAKEOVER_EXIT_MS = 30000

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
 * The helper is created by the WMI service, which does NOT pass on the caller's
 * environment, so the replacement would otherwise start without DSH_HOME and —
 * for anyone using a non-default home — against the wrong one. The home captured
 * at enable time (config.json) is re-asserted here. When nothing was captured the
 * base environment is returned untouched, so an older config keeps working.
 */
export function dshEnv(config, base = process.env) {
  const home = config?.dshHome
  if (typeof home !== 'string' || home === '') return base
  return { ...base, DSH_HOME: home }
}

/**
 * Launch DSH attached to this process's console.
 *
 * Both flags are load-bearing and were measured, not guessed. `detached: true` is
 * DETACHED_PROCESS, which leaves the host with no console; `windowsHide: true` is
 * CREATE_NO_WINDOW, which does not set a console handle either. DSH's sandbox cannot give
 * its tool subprocesses their own hidden console under the restricted token
 * (dsh-sandbox-windows-acl: CREATE_NO_WINDOW children die with STATUS_DLL_INIT_FAILED), so
 * they must share the host's — and with no host console each of them created a fresh one
 * that Windows 11 handed to Windows Terminal: one visible window per command (F9).
 *
 * Clearing either flag makes the child die with its parent instead (measured: an attached
 * child of a WMI-created parent is gone within ~10s of that parent exiting), so this
 * function may only be called by a process that stays alive for DSH's whole lifetime —
 * the supervisor.
 *
 * Returns the ChildProcess handle, not its pid. The caller is the process that has to
 * outlive DSH, and it learns of DSH's exit from that handle's 'exit' event — the spec is
 * explicit that the host's liveness is judged by `child.on('exit')` and not by polling. A
 * pid cannot carry that: once the child is gone the pid says nothing, and a recycled one
 * would say the opposite of the truth.
 *
 * TODO(Task 7): the one-shot `start` path still calls this from a helper that exits
 * immediately, so that contract is violated by this file's own caller until the CLI is
 * moved onto the supervisor.
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
  // uncaught exception, killing this hidden login helper before it can report
  // anything. Swallow it into the log and let the port wait below surface the
  // failure as "did not come up".
  child.once('error', (error) => {
    log(`spawn error: ${error instanceof Error ? error.message : String(error)}`)
  })
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
 * Start DSH unless the port already answers. Conditional polling only.
 *
 * The probe is retried over a bounded window rather than trusted once. Measured
 * 2026-09-12 (docs/ACCEPTANCE.md, "restart race"): the outcome turns on a few milliseconds
 * after the old host is confirmed gone. On one run the single probe fired 4ms after the
 * exit, answered "busy", and the helper logged "skip start" and returned without starting
 * anything — DSH stayed down and the user saw only "reconnecting". On two later runs of the
 * same code the probe fired at +10ms and +9ms, answered "free", and the restart worked.
 *
 * What answered at +4ms was not captured (the acceptance note records what was and was not
 * observed); the practical reading is that a probe landing the instant after a process dies
 * can be answered by a socket the kernel has not released yet, and a plain connect cannot
 * tell that apart from a live foreign service. Retrying is the fix that does not depend on
 * knowing which of the two it was: a draining socket clears, while a genuinely foreign
 * listener keeps answering and the window expires exactly as before.
 */
export async function runStart(input) {
  const { config, log } = input
  const deps = input.deps ?? {}
  const probe = deps.isPortListening ?? isPortListening
  const wait = deps.waitForPort ?? waitForPort
  const spawnImpl = deps.spawnDsh ?? spawnDsh
  const hook = deps.runHook ?? runHook
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const isAlive = deps.isProcessAlive ?? defaultIsAlive
  const attempts = deps.startAttempts ?? DEFAULT_START_ATTEMPTS
  const retryDelayMs = deps.startRetryDelayMs ?? DEFAULT_START_RETRY_DELAY_MS
  const schedule =
    deps.scheduleSecondChance ?? (input.configPath ? scheduleSecondChance : null)

  const windowMs = deps.portProbeWindowMs ?? DEFAULT_PORT_PROBE_WINDOW_MS
  const intervalMs = deps.portProbeIntervalMs ?? DEFAULT_PORT_PROBE_INTERVAL_MS
  const deadline = now() + windowMs
  let probes = 0
  for (;;) {
    probes += 1
    if (!(await probe(config.dshPort))) break
    if (now() >= deadline) {
      log(
        `port ${config.dshPort} still answering after ${probes} probes (${windowMs}ms); ` +
          'assuming another service owns it; skip start',
      )
      // A busy port at login usually means something else is already serving DSH, and a
      // fallback would be an attempt to fight it. After a restart it means our own instance
      // just died and something is lingering, which is the case worth one more try.
      if (input.afterRestart && schedule && !input.secondChance) {
        await schedule({ configPath: input.configPath, config, log, deps })
      }
      return { started: false }
    }
    await sleep(intervalMs)
  }

  let pid = null
  let up = false
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    pid = spawnImpl(config, log, deps).pid
    log(`spawned dsh pid=${pid}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`)
    up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
    if (up) {
      log(`port ${config.dshPort} is up`)
      break
    }
    log(`WARN port ${config.dshPort} did not come up in time (attempt ${attempt}/${attempts})`)
    if (attempt === attempts) break
    // Retry only once the failed child is really gone: a live one may still bind the port a
    // moment later, and starting a competitor at that point is how you end up with two DSH
    // instances racing for the same port.
    if (isAlive(pid)) {
      log(`previous pid ${pid} is still alive; not starting a second instance`)
      break
    }
    await sleep(retryDelayMs)
  }

  if (up) {
    await hook(config, log, deps)
    return { started: true, pid, up: true }
  }
  // DSH is down and nothing is holding the port. No UI can report this — the card lives
  // inside the page that just went away — so leave one delayed attempt behind.
  if (schedule && !input.secondChance) {
    await schedule({ configPath: input.configPath, config, log, deps })
  }
  return { started: true, pid, up: false }
}

/** Wait, briefly, for the port to stop answering before spawning a replacement. */
async function waitForFreePort(probe, port, log, deps = {}) {
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
    log(`takeover: waiting for pid ${input.takeoverPid} to exit`)
    const waitExit = deps.waitForProcessExit ?? waitForProcessExit
    const gone = await waitExit(input.takeoverPid, { timeoutMs: deps.takeoverExitTimeoutMs ?? DEFAULT_TAKEOVER_EXIT_MS })
    if (!gone) {
      log(`takeover: pid ${input.takeoverPid} is still alive; standing down without starting`)
      ;(deps.clearFile ?? clearFile)(pidFile)
      return { supervised: false, reason: 'takeover-timeout' }
    }
  } else if (!(await waitForFreePort(probe, config.dshPort, log, deps))) {
    // A bare single probe cannot tell a live foreign service from a socket the kernel has not
    // released yet (measured 2026-09-12, see runStart), and standing down on a draining socket
    // would exit reporting success while DSH is down. So the port is re-probed over the whole
    // window and only a port that still answers afterwards is called someone else's.
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
      const free = await waitForFreePort(probe, config.dshPort, log, deps)
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
    log(`spawned dsh pid=${pid}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`)
    const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
    if (up) {
      log(`port ${config.dshPort} is up`)
      await hook(config, log, deps)
      return await superviseChild({ config, configPath, log, deps, pid, child, requestFile, stopFile, pidFile })
    }
    log(`WARN port ${config.dshPort} did not come up in time (attempt ${attempt}/${attempts})`)
    if (isAlive(pid)) {
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
  ;(deps.clearFile ?? clearFile)(pidFile)
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
    if (stopped(stopFile, process.pid)) {
      log('stop requested; supervisor exiting')
      clear(pidFile)
      return { supervised: false, reason: 'stopped' }
    }
    if (!consumed(requestFile, current)) {
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
      log('replacement did not come up; supervisor exiting')
      clear(pidFile)
      return { supervised: false, reason: 'restart-failed' }
    }
    current = next.pid
    currentChild = next.child
  }
}

/**
 * The last-resort fallback: one more start attempt, later, from a process that outlives the
 * helper.
 *
 * This exists because a failed restart takes DSH down and no in-page UI can report it — the
 * card is part of the page that just disappeared. The child is detached so it survives the
 * helper (and DSH's job), runs `service.js start` again after a delay, and is marked
 * `--second-chance` so it can never schedule another one: exactly one extra attempt, never a
 * loop. It is also idempotent — runStart probes the port first — so it does nothing when
 * DSH came back on its own, or when something else owns the port.
 */
export function scheduleSecondChance(input) {
  const { configPath, log } = input
  const deps = input.deps ?? {}
  const spawnImpl = deps.spawn ?? spawn
  const delayMs = deps.secondChanceDelayMs ?? DEFAULT_SECOND_CHANCE_DELAY_MS
  try {
    const child = spawnImpl(
      process.execPath,
      [SERVICE_JS, 'start', '--config', configPath, '--second-chance', '--delay', String(delayMs)],
      { detached: true, windowsHide: true, stdio: 'ignore' },
    )
    child.unref()
    log(`scheduled one more start attempt in ${delayMs}ms (pid=${child.pid})`)
    return child.pid
  } catch (error) {
    log(`could not schedule the fallback start attempt: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Whether a pid is still alive on this OS.
 *
 * Only ESRCH means "gone". Any other error — notably EPERM, for a live process
 * this user may not signal — must report ALIVE: a false "gone" would skip
 * runRestart's abort and spawn a second instance while the old one may still
 * hold the port, which is the exact failure mode this path exists to avoid.
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

/**
 * Full restart: wait for the old process to exit, then start DSH again.
 * Aborting (rather than starting a second instance) is the safe failure mode.
 */
export async function runRestart(input) {
  const { config, oldPid, log } = input
  const deps = input.deps ?? {}
  const waitExit = deps.waitForProcessExit ?? waitForProcessExit
  const exited = await waitExit(oldPid, { timeoutMs: config.waitForExitMs })
  if (!exited) {
    log(`WARN old process ${oldPid} still alive after ${config.waitForExitMs}ms; aborting restart`)
    return { restarted: false }
  }
  log(`old process ${oldPid} exited; starting a new instance`)
  const started = await runStart({
    config,
    log,
    deps,
    configPath: input.configPath,
    secondChance: input.secondChance,
    afterRestart: true,
  })
  return { restarted: true, ...started }
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
  // An explicit --config is how the restart helper is told where config.json is:
  // WMI creates it with the provider host's environment, so DSH_HOME is absent
  // and resolveDshHome() would point at the wrong home entirely.
  const configFlag = argv.indexOf('--config')
  const named = configFlag === -1 ? null : argv[configFlag + 1]
  if (configFlag !== -1 && (typeof named !== 'string' || named === '' || named.startsWith('-'))) {
    // Present but unusable — including the `--config --pid 5` slip, where the
    // next flag would otherwise be read as a path. Falling back silently would
    // reintroduce exactly the wrong-home failure this flag exists to prevent, so
    // refuse instead.
    return 2
  }
  const configPath = deps.configPath ?? named ?? configFilePath(resolveDshHome())
  // `--second-chance` marks the single fallback attempt scheduleSecondChance creates. It is
  // forbidden from creating another, so a permanent failure cannot become a retry loop.
  const secondChance = argv.includes('--second-chance')
  // `--delay <ms>` lets that fallback wait before it runs, without a second script.
  const delayFlag = argv.indexOf('--delay')
  const delayRaw = delayFlag === -1 ? null : argv[delayFlag + 1]
  const delayMs = delayRaw === null ? 0 : Number(delayRaw)
  if (delayRaw !== null && (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS)) {
    return 2
  }
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
  try {
    if (delayMs > 0) {
      const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      log(`waiting ${delayMs}ms before the fallback attempt`)
      await sleep(delayMs)
    }
    if (mode === 'start') {
      await runStart({ config, log, deps, configPath, secondChance })
      return 0
    }
    if (mode === 'restart') {
      const pidFlag = argv.indexOf('--pid')
      const oldPid = pidFlag === -1 ? Number.NaN : Number(argv[pidFlag + 1])
      if (!Number.isInteger(oldPid) || oldPid <= 0) {
        log('restart requires --pid <number>')
        return 2
      }
      await runRestart({ config, oldPid, log, deps, configPath, secondChance })
      return 0
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
