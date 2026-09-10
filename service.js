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
import os from 'node:os'
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
export function spawnDsh(config) {
  const out = fs.openSync(config.logPaths.out, 'a')
  const err = fs.openSync(config.logPaths.err, 'a')
  const child = spawn(config.command.execPath, config.command.argv, {
    cwd: config.command.cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
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
 */
export function runHook(config, log, deps = {}) {
  const script = config.hookScript
  if (typeof script !== 'string' || script === '') return Promise.resolve({ ran: false })
  const exists = deps.exists ?? fs.existsSync
  if (!exists(script)) {
    log(`hook not found: ${script}`)
    return Promise.resolve({ ran: false, missing: true })
  }
  const spawnHook = deps.spawnHook ?? ((cmd, args) => spawn(cmd, args, { windowsHide: true, stdio: 'ignore' }))
  const [cmd, args] = hookInvocation(script)
  return new Promise((resolve) => {
    let child
    try {
      child = spawnHook(cmd, args)
    } catch (error) {
      log(`hook spawn error: ${error.message}`)
      resolve({ ran: true, failed: true })
      return
    }
    child.once('error', (error) => {
      log(`hook error: ${error.message}`)
      resolve({ ran: true, failed: true })
    })
    child.once('close', (code) => {
      log(`hook exited code=${code}`)
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
  const pid = spawnImpl(config)
  log(`spawned dsh pid=${pid}`)
  const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
  log(up ? `port ${config.dshPort} is up` : `WARN port ${config.dshPort} did not come up in time`)
  await hook(config, log, deps)
  return { started: true, pid, up }
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
    // At login there is no UI to report to: log and exit quietly.
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.appendFileSync(
        configPath.replace(/config\.json$/, 'service.log'),
        `[${new Date().toISOString()}] cannot read config: ${error.message}\n`,
        'utf8',
      )
    } catch {
      // nothing else we can do
    }
    return 1
  }
  const log = makeLogger(config)
  if (mode === 'start') {
    await runStart({ config, log, deps })
    return 0
  }
  return 2
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === path.resolve(SERVICE_JS)) {
  process.exitCode = await main(process.argv)
}
