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

const SERVICE_JS = fileURLToPath(import.meta.url)

/** Load and validate config.json. */
export function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8')
  return parseConfigFile(text)
}

/** Launch DSH detached, with stdout/stderr appended to the log files. */
export function spawnDsh(config, log = () => {}) {
  // parseConfigFile does not validate logPaths (it cannot — it never receives
  // dshHome), so guard it here: an unguarded openSync would throw a TypeError
  // that escapes main's contract of returning an exit code.
  if (typeof config?.logPaths?.out !== 'string' || typeof config?.logPaths?.err !== 'string') {
    throw new Error('config: logPaths.out and logPaths.err are required to capture DSH output')
  }
  const out = fs.openSync(config.logPaths.out, 'a')
  const err = fs.openSync(config.logPaths.err, 'a')
  const child = spawn(config.command.execPath, config.command.argv, {
    cwd: config.command.cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  })
  // A bad execPath emits 'error'; with no listener Node rethrows it as an
  // uncaught exception, killing this hidden login helper before it can report
  // anything. Swallow it into the log and let the port wait below surface the
  // failure as "did not come up".
  child.once('error', (error) => {
    log(`spawn error: ${error instanceof Error ? error.message : String(error)}`)
  })
  child.unref()
  return child.pid
}

/** Pick the interpreter for a hook script by extension. */
function hookInvocation(script) {
  const ext = path.extname(script).toLowerCase()
  if (ext === '.ps1') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
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
 */
export async function runStart(input) {
  const { config, log } = input
  const deps = input.deps ?? {}
  const probe = deps.isPortListening ?? isPortListening
  const wait = deps.waitForPort ?? waitForPort
  const spawnImpl = deps.spawnDsh ?? spawnDsh
  const hook = deps.runHook ?? runHook

  if (await probe(config.dshPort)) {
    log(`port ${config.dshPort} already running; skip start`)
    return { started: false }
  }
  const pid = spawnImpl(config, log)
  log(`spawned dsh pid=${pid}`)
  const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
  log(up ? `port ${config.dshPort} is up` : `WARN port ${config.dshPort} did not come up in time`)
  await hook(config, log, deps)
  return { started: true, pid, up }
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
  const started = await runStart({ config, log, deps })
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
  const configPath = deps.configPath ?? configFilePath(resolveDshHome())
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
    if (mode === 'start') {
      await runStart({ config, log, deps })
      return 0
    }
    if (mode === 'restart') {
      const pidFlag = argv.indexOf('--pid')
      const oldPid = pidFlag === -1 ? Number.NaN : Number(argv[pidFlag + 1])
      if (!Number.isInteger(oldPid) || oldPid <= 0) {
        log('restart requires --pid <number>')
        return 2
      }
      await runRestart({ config, oldPid, log, deps })
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
