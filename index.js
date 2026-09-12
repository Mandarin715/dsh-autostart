// dsh-autostart — host face.
//
// Registers the settings card's HTTP endpoints. The browser face (client.js)
// talks to these with same-origin fetch; no Typert dependency is needed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSupportedPlatform, unsupportedReason } from './lib/platform.js'
import { isPortListening } from './lib/port.js'
import {
  resolvePluginConfig,
  resolveDshHome,
  configDir,
  configFilePath,
  logPaths,
  buildConfigFile,
  restartRequestFile,
  supervisePidFile,
  superviseStopFile,
} from './lib/config.js'
import { readPid, writeRestartRequest } from './lib/supervise-state.js'
import { defaultSupervisor, isProcessAlive, writeSuperviseStop } from './lib/supervise-launch.js'
import {
  readRunValue,
  writeRunValue,
  removeRunValue,
  isOurEntry,
  registryCommand,
} from './lib/registry.js'
import { detectCommand } from './lib/detect-command.js'
import { parseLatestAccessUrl } from './lib/parse-url.js'
import { renderBootstrapVbs as renderBootstrap } from './lib/render-vbs.js'
import {
  buildHelperCommandLine,
  buildLauncherArgv,
  LAUNCH_FAILURE_PREFIX,
  LAUNCH_FAILURE_SUFFIX,
} from './lib/launch-helper.js'

const SERVICE_JS = fileURLToPath(new URL('./service.js', import.meta.url))

/**
 * Count agents that are mid-turn; used only to inform or gate a restart.
 *
 * @returns the count, or `null` meaning "unknown" when the service is absent or
 *   its list cannot be read. Never 0 on failure: `blockWhenAgentsRunning` is a
 *   protection the user explicitly opted into, and reporting 0 would silently
 *   lift it — the unsafe direction. The caller refuses the restart when the
 *   count is null. An absent service (a DSH build without `agents`) is
 *   "unknown" too: the plugin must still load and mount its routes there.
 */
export function countRunningAgents(agentsService) {
  if (agentsService === undefined || agentsService === null) return null
  let list
  try {
    list = agentsService.list?.()
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  return list.filter((agent) => agent?.status === 'running').length
}

/** How long to wait for the WMI launcher to finish creating the helper. */
const DEFAULT_LAUNCHER_TIMEOUT_MS = 15000

/** Bounded tail of the launcher's stderr kept for diagnosing a launch failure. */
const DEFAULT_LAUNCHER_STDERR_TAIL = 2000

/** Longest diagnostic sentence passed on to the user. */
const LAUNCH_DETAIL_MAX = 200

/**
 * Upper bound on the exit delay a restart may schedule.
 *
 * The delay exists only to let the 202 response flush before this process exits. It must stay
 * well inside the window a freshly started supervisor waits for this pid to exit:
 * DEFAULT_TAKEOVER_EXIT_MS = 30000 in service.js. Past that window the supervisor concludes the
 * takeover is not happening, stands down, and the restart becomes a shutdown. Clamped at the
 * use site rather than in lib/config.js, so an existing config.json with a larger value still
 * loads (and README's advertised knob still exists).
 */
const MAX_EXIT_DELAY_MS = 5000

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Pull the launcher's one diagnostic sentence out of its stderr.
 *
 * Searching for the sentinel — rather than taking the last line — is required:
 * with stderr redirected, Windows PowerShell appends a CLIXML blob AFTER anything
 * we write, so "the last non-empty line" is an XML document (measured: ~1.4KB of
 * <Objs> plus mojibake, which would otherwise be rendered into the settings card).
 * Falls back to the last line for an older launcher, or a failure raised before
 * our script ran.
 */
export function extractLaunchDetail(stderrTail, max = LAUNCH_DETAIL_MAX) {
  const from = stderrTail.lastIndexOf(LAUNCH_FAILURE_PREFIX)
  let text
  if (from === -1) {
    text = stderrTail
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .pop()
  } else {
    const rest = stderrTail.slice(from + LAUNCH_FAILURE_PREFIX.length)
    const to = rest.indexOf(LAUNCH_FAILURE_SUFFIX)
    text = to === -1 ? rest : rest.slice(0, to)
  }
  if (text === undefined) return ''
  // Collapse whitespace and clamp: nothing from the launcher may reach the user as
  // an unbounded or multi-line blob.
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Start the detached helper that waits for this process to exit and then
 * restarts DSH — created OUTSIDE this process's Windows job object.
 *
 * Node's `spawn(..., { detached: true })` is NOT sufficient: `detached` sets
 * DETACHED_PROCESS but not CREATE_BREAKAWAY_FROM_JOB, so the helper stays a
 * member of DSH's job object, which is created kill-on-close. DSH exiting would
 * then kill the helper before it could start the replacement — i.e. "restart"
 * would silently mean "shut down". (Measured on a real DSH: a detached child is
 * still listed in the job's pid list, and killing the job kills it.)
 *
 * So the helper is created by the WMI service instead, which is not a DSH
 * descendant; what it creates is outside the job and survives DSH's exit.
 *
 * The launch is AWAITED because the launcher itself runs inside the job: it has
 * to have completed the WMI call before the caller exits. Every failure path is
 * a rejection, so the route can answer 500 and — critically — not exit.
 */
export async function defaultSpawnHelper(input, deps = {}) {
  // The existence checks stay first, so nothing is launched when a path is bad:
  // a missing path would otherwise surface only as an async CreateProcess error.
  if (!fs.existsSync(input.serviceJsPath)) {
    throw new Error(`restart helper not found: ${input.serviceJsPath}`)
  }
  if (!fs.existsSync(input.execPath)) {
    throw new Error(`node executable not found: ${input.execPath}`)
  }
  const commandLine = buildHelperCommandLine(input)
  const { command, args } = buildLauncherArgv(commandLine, { env: deps.env })
  const spawnLauncher = deps.spawnLauncher ?? ((cmd, argv, options) => spawn(cmd, argv, options))
  const timeoutMs = deps.launcherTimeoutMs ?? DEFAULT_LAUNCHER_TIMEOUT_MS
  const stderrTailMax = deps.stderrTailMax ?? DEFAULT_LAUNCHER_STDERR_TAIL

  await new Promise((resolve, reject) => {
    let child
    try {
      // stderr is piped (not ignored) so a failure can name its cause: the exit
      // code alone is identical for WMI disabled, a missing PowerShell and
      // access denied, and WMI is now a hard dependency of this feature.
      child = spawnLauncher(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`could not start the restart launcher: ${messageOf(error)}`))
      return
    }
    let stderrTail = ''
    if (child.stderr !== undefined && child.stderr !== null) {
      child.stderr.setEncoding?.('utf8')
      child.stderr.on('data', (chunk) => {
        // Bounded: a hostile or broken launcher must not grow this without limit.
        stderrTail = (stderrTail + chunk).slice(-stderrTailMax)
      })
    }
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    const detail = () => {
      const flat = extractLaunchDetail(stderrTail)
      return flat === '' ? '' : `: ${flat}`
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // best effort: the timeout is already being reported
      }
      finish(reject, new Error(`the restart launcher did not finish within ${timeoutMs}ms`))
    }, timeoutMs)
    // An 'error' with no listener is rethrown by Node and would kill the host.
    child.once('error', (error) =>
      finish(reject, new Error(`restart launcher failed: ${messageOf(error)}`)),
    )
    // 'close' rather than 'exit': it fires once stdio has been fully drained, so
    // the stderr tail above cannot be read half-written. The timeout still bounds
    // the case where the stream never closes.
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish(resolve)
        return
      }
      // A killed launcher reports code null; saying "code null" would hide why.
      const how = code === null ? `was killed by signal ${signal}` : `exited with code ${code}`
      finish(reject, new Error(`the restart launcher ${how}${detail()}`))
    })
  })
}

/**
 * Loopback hostnames the DSH web server is legitimately reachable at.
 * A request whose Host is anything else is not addressed to this machine's own
 * loopback service, regardless of what its Origin claims.
 */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Whether a write request comes from this service's own page.
 *
 * Comparing `Origin` with `Host` alone proves nothing: both headers come from
 * the caller, and under DNS rebinding they agree by construction — a page
 * served from evil.example:<port> whose domain then rebinds to 127.0.0.1:<port>
 * presents `Host: evil.example:<port>` with a matching Origin. So require the
 * Host itself to be a loopback authority, and the port to be the one this
 * plugin actually serves, before comparing the two.
 *
 * @param expectedPort - the plugin's configured dshPort; when given, a loopback
 *   Host must name exactly it.
 * @param allowedHosts - extra authorities the user explicitly trusts, for
 *   reaching DSH through a reverse proxy (frp + auth-proxy forwards the
 *   original Host, so the browser sends the public domain, not loopback).
 *   For these the port-equality check is skipped: a browser reaching
 *   `https://derp.example.com` sends `Host: derp.example.com` with no port at
 *   all, so demanding the local `dshPort` would 403 the very case this option
 *   exists for. The allow-list entry is already an explicit per-authority
 *   opt-in, and the same-origin check still binds it. Loopback keeps the strict
 *   port check.
 */
export function sameOrigin(headers, expectedPort, allowedHosts = []) {
  const host = headers?.host
  const origin = headers?.origin
  if (typeof host !== 'string' || typeof origin !== 'string') return false
  let hostUrl
  let originUrl
  try {
    hostUrl = new URL(`http://${host}`)
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const loopback = LOOPBACK_HOSTNAMES.has(hostUrl.hostname)
  const trusted = Array.isArray(allowedHosts)
    ? allowedHosts.some((entry) => {
        // The plan documents entries as bare hostnames (['derp.example.com'])
        // while the listing compares them as full authorities; accept both so a
        // user following either form is admitted. The same-origin check below
        // still binds whichever form matched.
        const configured = String(entry).toLowerCase()
        return configured === hostUrl.host.toLowerCase() || configured === hostUrl.hostname.toLowerCase()
      })
    : false
  if (!loopback && !trusted) return false
  if (loopback && Number.isInteger(expectedPort) && hostUrl.port !== String(expectedPort)) return false
  // Portless only ever comes from a non-loopback authority (the loopback check
  // above already rejected a portless loopback Host), so there is nothing to
  // exempt here.
  return originUrl.host === hostUrl.host
}

/** Read the newest access URL out of the captured stdout, if any. */
function readAccessUrl(paths) {
  try {
    return parseLatestAccessUrl(fs.readFileSync(paths.out, 'utf8'))
  } catch {
    return null
  }
}

/** Aggregate everything the settings card shows, from live probes only. */
export async function buildState(deps) {
  const { platform = process.platform, dshHome, pluginConfig, registry } = deps
  const supported = isSupportedPlatform(platform)
  const paths = logPaths(dshHome)
  const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
  const hookScript = pluginConfig.hookScript
  const base = {
    supported,
    platform,
    dshPort: pluginConfig.dshPort,
    accessUrl: readAccessUrl(paths),
    hookScript,
    hookExists: hookScript === '' ? false : fs.existsSync(hookScript),
    configPath: configFilePath(dshHome),
    // What the restart route actually requires. The card used to gate its Restart
    // button on `autostartEnabled` while the route only needs this file, so with
    // autostart off but config.json present the button was greyed and the hint
    // named a file that exists.
    configExists: fs.existsSync(configFilePath(dshHome)),
    vbsPath,
    logPath: paths.service,
  }
  if (!supported) return { ...base, reason: unsupportedReason(platform) }
  const stored = registry.readRunValue()
  return {
    ...base,
    serviceRunning: await isPortListening(pluginConfig.dshPort),
    autostartEnabled: stored !== null,
    registryValue: stored,
    registryMatchesOurs: isOurEntry(stored, vbsPath),
  }
}

/**
 * Ask a live supervisor to stop — best effort, synchronously, and without waiting for it.
 *
 * Only a live pid is named: leaving a stop marker for a pid that is gone would be litter that a
 * later supervisor might read. The pid written is the SUPERVISOR's, never this host's: the
 * supervisor honours a stop marker only when it names itself (`isStopRequested`).
 *
 * Nothing here waits for the supervisor to exit, and that is deliberate. The supervisor reads
 * the marker only AFTER its child (DSH) exits, so writing it while DSH is alive does not make
 * the supervisor exit now — disabling autostart must not close the user's running DSH. Do not
 * "fix" that by polling for the supervisor's death: a resident timer is exactly what this
 * design removed. The marker is named for the moment DSH does go away.
 */
function stopLiveSupervisor({ dshHome, isAlive, read, write }) {
  try {
    const pid = read(supervisePidFile(dshHome))
    if (pid === null || !isAlive(pid)) return null
    write(superviseStopFile(dshHome), pid)
    return pid
  } catch {
    // Best effort: a stop marker that could not be written must not fail a disable or an
    // uninstall, both of which have already done their real work.
    return null
  }
}

/** Build the four route handlers with injectable seams for tests. */
export function createHandlers(deps) {
  const platform = deps.platform ?? process.platform
  const dshHome = deps.dshHome ?? resolveDshHome()
  const pluginConfig = resolvePluginConfig(deps.config ?? {})
  const registry = deps.registry ?? { readRunValue, writeRunValue, removeRunValue }
  const fsImpl = deps.fs ?? fs
  const probe = deps.isPortListening ?? isPortListening
  const spawnHelper = deps.spawnHelper ?? defaultSpawnHelper
  const readPidImpl = deps.readPid ?? readPid
  const isProcessAliveImpl = deps.isProcessAlive ?? isProcessAlive
  const writeSuperviseStopImpl = deps.writeSuperviseStop ?? writeSuperviseStop
  const writeRestartRequestImpl = deps.writeRestartRequest ?? writeRestartRequest
  // The read-back needs its own seam for the same reason the write does: there is no injectable
  // "did it land" anywhere, and writePid cannot report a failure.
  const readRestartRequestImpl = deps.readRestartRequest ?? readPid
  // The supervisor is one per dsh home. Its pid-wait seams live in a bag of their own so a test
  // can make the launch wait deterministic without spelling out every unrelated handler seam.
  const supervisor =
    deps.supervisor ??
    defaultSupervisor(dshHome, {
      execPath: deps.execPath ?? process.execPath,
      serviceJsPath: deps.serviceJsPath ?? SERVICE_JS,
      configPath: configFilePath(dshHome),
      spawnHelper,
      ...(deps.supervise ?? {}),
    })
  let restarting = false

  const send = (res, code, payload) => {
    res.writeHead(code)
    res.end(JSON.stringify(payload))
  }
  const guard = (req, res) => {
    if (!isSupportedPlatform(platform)) {
      send(res, 400, { error: unsupportedReason(platform) })
      return false
    }
    if (!sameOrigin(req.headers, pluginConfig.dshPort, pluginConfig.allowedHosts)) {
      send(res, 403, { error: 'same-origin request required' })
      return false
    }
    return true
  }

  return {
    async state(_req, res) {
      const state = await buildState({
        platform,
        dshHome,
        pluginConfig,
        registry,
      })
      send(res, 200, state)
    },

    async enable(req, res) {
      if (!guard(req, res)) return
      try {
        const command = detectCommand({
          execPath: deps.execPath ?? process.execPath,
          argv: deps.argv ?? process.argv.slice(1),
          cwd: deps.cwd ?? process.cwd(),
          openBrowser: pluginConfig.openBrowserOnBoot,
        })
        const dir = configDir(dshHome)
        fsImpl.mkdirSync(dir, { recursive: true })
        const configFile = buildConfigFile({ command, pluginConfig, dshHome })
        fsImpl.writeFileSync(configFilePath(dshHome), JSON.stringify(configFile, null, 2), 'utf8')
        const vbsPath = path.join(dir, 'bootstrap.vbs')
        // wscript.exe reads a BOM-less file as ANSI, so a non-ASCII path (a Chinese user
        // profile, a non-ASCII DSH_HOME) would silently corrupt the login command.
        // UTF-16LE with a BOM is what WSH parses as Unicode.
        fsImpl.writeFileSync(
          vbsPath,
          `\uFEFF${renderBootstrap({
            execPath: command.execPath,
            serviceJsPath: deps.serviceJsPath ?? SERVICE_JS,
            // Same reason as the restart path: the login helper must not re-derive
            // the DSH home from an environment it may not have inherited.
            configPath: configFilePath(dshHome),
          })}`,
          'utf16le',
        )
        registry.writeRunValue(vbsPath)
        // §5.1 step 7 returns the stored registry value too, so the user can
        // confirm what will run at login.
        send(res, 200, {
          enabled: true,
          registryValue: registryCommand(vbsPath),
          configPath: configFilePath(dshHome),
          vbsPath,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // §7 row 2: the likely cause is security software blocking the write,
        // which is not something the message alone can reveal.
        send(res, 500, {
          error: `enable failed: ${message} (security software may be blocking the registry write)`,
        })
      }
    },

    async disable(req, res) {
      if (!guard(req, res)) return
      try {
        const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
        const stored = registry.readRunValue()
        if (stored !== null && !isOurEntry(stored, vbsPath)) {
          send(res, 200, { enabled: true, foreignEntry: true, registryValue: stored })
          return
        }
        registry.removeRunValue()
        // The supervisor reads this marker only after its child exits, so writing it does not
        // close the running DSH now (see stopLiveSupervisor). It stops a supervisor started by
        // "restart" from lingering forever after its child is gone. Never awaited.
        stopLiveSupervisor({
          dshHome,
          isAlive: isProcessAliveImpl,
          read: readPidImpl,
          write: writeSuperviseStopImpl,
        })
        send(res, 200, { enabled: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 500, { error: `disable failed: ${message}` })
      }
    },

    async restart(req, res) {
      if (!guard(req, res)) return
      if (restarting) {
        send(res, 409, { error: 'a restart is already scheduled' })
        return
      }
      // The supervisor is what restarts DSH now, and it reads config.json to learn the launch
      // command. Without the file it can only exit 1, leaving nothing to bring DSH back, so a
      // restart that exits this host would silently mean "shut down". §7 has a row for this
      // ("请先启用自启"); the card also disables the button, this is the backstop.
      if (!fsImpl.existsSync(configFilePath(dshHome))) {
        send(res, 400, { error: 'enable autostart first: config.json is missing' })
        return
      }
      const running = countRunningAgents(deps.agents)
      if (pluginConfig.blockWhenAgentsRunning && (running === null || running > 0)) {
        // null = the list could not be read. Refuse rather than assume zero:
        // this gate is the user's explicit protection.
        const detail = running === null ? 'the agent list is unreadable' : `${running} agent(s) are running`
        send(res, 409, { error: `refusing to restart: ${detail}` })
        return
      }
      // The flag is set BEFORE the await, not after. `start` and the request write are async,
      // so setting it afterwards would leave an interleaving point where two overlapping POSTs
      // both pass the check above, launch two supervisors, and arm two exits — which spec §7
      // forbids ("a restart is already scheduled").
      restarting = true
      const selfPid = deps.currentPid ?? process.pid
      try {
        // The order is the whole point: make sure something will take over BEFORE this host
        // goes away. If no supervisor can be started, the catch below refuses with 500 and the
        // host stays up — an exit with nobody to restart us is exactly the failure this design
        // exists to remove.
        //
        // Assumes one DSH per dshHome and that a live supervisor is watching THIS child. A
        // supervisor watching a different child cannot be told apart from ours here: start()
        // would read that already-live pid and report success. The request below names this
        // process, and a supervisor honours a request only for the child it saw exit, so the
        // deeper case is a known limit of this check rather than something it can fix.
        if (!supervisor.isAlive()) {
          // Bounded inside (10s): it throws rather than waiting forever, and the launcher it
          // runs is awaited on purpose — the relay runs inside DSH's job, so it has to finish
          // handing the supervisor out of that job BEFORE the exit that would kill it.
          await supervisor.start(selfPid)
        }
      } catch (error) {
        // Clear the flag so the user can retry: nothing was started, and the host is still
        // alive to serve the next request.
        restarting = false
        send(res, 500, { error: `could not start the supervisor: ${messageOf(error)}` })
        return
      }
      try {
        // Only now, with a live supervisor confirmed, is the request written. It names THIS
        // process: the supervisor honours a request only for the child it just saw exit, and
        // that child is this pid. Same path source as the supervisor's own derivation, so the
        // request cannot land in a file nobody watches (lib/config.js restartRequestFile).
        const requestFile = restartRequestFile(dshHome)
        writeRestartRequestImpl(requestFile, selfPid)
        // Read it back. writeRestartRequest is writePid, which wraps fs.writeFileSync in a bare
        // catch ("best effort: a failure here must never take the caller down"), so the write
        // CANNOT report a failure itself. Without this check a failed write still answers 202
        // and exits, and the supervisor — finding no request naming the child it just saw exit
        // — logs "exited without a restart request; nothing to do" and stands down: DSH stays
        // down. That is the exact failure this whole design exists to remove.
        if (readRestartRequestImpl(requestFile) !== selfPid) {
          throw new Error(
            `the request naming pid ${selfPid} was not confirmed on disk at ${requestFile}`,
          )
        }
      } catch (error) {
        // Its own label, deliberately not "could not start the supervisor": the supervisor did
        // start, and client.js renders this text — pointing the user at the WMI/launcher path
        // here would misdirect the diagnosis.
        restarting = false
        send(res, 500, { error: `could not write the restart request: ${messageOf(error)}` })
        return
      }
      send(res, 202, { accepted: true, runningAgents: running })
      const scheduleExit = deps.scheduleExit ?? ((fn, ms) => setTimeout(fn, ms))
      // Clamped at the use site, not in lib/config.js, so an existing config.json with a larger
      // value still loads. The delay only exists to let the 202 flush before this process exits,
      // and it must stay well inside the window a freshly started supervisor waits for this pid
      // to exit (DEFAULT_TAKEOVER_EXIT_MS = 30000 in service.js). A delay past that window makes
      // the takeover give up and stand down, i.e. a restart would become a shutdown.
      scheduleExit(() => process.exit(0), Math.min(pluginConfig.exitDelayMs, MAX_EXIT_DELAY_MS))
    },
  }
}

/**
 * Remove the autostart entry — but ONLY on a real uninstall, and only if the entry
 * is still ours.
 *
 * Disposal is not uninstallation: cordis tears a plugin row down on reload and on a
 * failed load as well. Removing the entry then silently defeats the feature — the
 * user enables autostart, something reloads, and the next login starts nothing.
 * That was observed on a real machine after a failed load.
 *
 * Our own service.js being gone is the evidence of an actual uninstall. The
 * generated bootstrap.vbs and config.json live outside node_modules, so without
 * this check an uninstalled plugin would also leave a dangling entry pointing at a
 * script that no longer exists.
 */
export function cleanupAutostart(deps) {
  const dshHome = deps.dshHome ?? resolveDshHome()
  const registry = deps.registry ?? { readRunValue, removeRunValue }
  const exists = deps.exists ?? fs.existsSync
  const serviceJsPath = deps.serviceJsPath ?? SERVICE_JS
  const readPidImpl = deps.readPid ?? readPid
  const isProcessAliveImpl = deps.isProcessAlive ?? isProcessAlive
  const writeSuperviseStopImpl = deps.writeSuperviseStop ?? writeSuperviseStop
  const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
  let stored
  try {
    stored = registry.readRunValue()
  } catch {
    return
  }
  if (stored === null || !isOurEntry(stored, vbsPath)) return
  if (exists(serviceJsPath)) return
  try {
    registry.removeRunValue()
  } catch {
    // best effort on unload
  }
  // A real uninstall: the entry is gone, so the supervisor that was started on demand should
  // not outlive its purpose. Same "write it and move on" rule as disable — the marker carries
  // the supervisor's pid and is read only after its child exits (see stopLiveSupervisor).
  stopLiveSupervisor({
    dshHome,
    isAlive: isProcessAliveImpl,
    read: readPidImpl,
    write: writeSuperviseStopImpl,
  })
}

/** Cordis row entry: mount the four routes on the web server. */
// Only `webServer` is required. `agents` is read optionally in apply(): making
// it a hard injection would make the whole plugin contingent on a service some
// DSH builds do not have — cordis would never resolve it, this row would never
// apply, no route would mount, and the card could only report "cannot read
// state". countRunningAgents treats the absent service as "unknown", so the
// blockWhenAgentsRunning gate still refuses rather than silently passing.
export const inject = ['webServer']

export function apply(ctx, config) {
  const handlers = createHandlers({ config, agents: ctx.get('agents') })
  ctx.effect(() => {
    const dispose = [
      ctx.webServer.register({ kind: 'exact', path: '/dsh-autostart/state', handler: handlers.state }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-autostart/autostart/enable',
        handler: handlers.enable,
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-autostart/autostart/disable',
        handler: handlers.disable,
      }),
      ctx.webServer.register({ kind: 'exact', path: '/dsh-autostart/restart', handler: handlers.restart }),
    ]
    return () => {
      for (const fn of dispose) fn()
      cleanupAutostart({ serviceJsPath: SERVICE_JS })
    }
  }, 'dsh-autostart: routes')
}
