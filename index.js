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
} from './lib/config.js'
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
import { buildHelperCommandLine, buildLauncherArgv } from './lib/launch-helper.js'

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

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

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
    // The last non-empty stderr line is the actionable one (the launcher writes
    // the WMI ReturnValue there).
    const detail = () => {
      const line = stderrTail
        .split(/\r?\n/)
        .filter((text) => text.trim() !== '')
        .pop()
      return line === undefined ? '' : `: ${line.trim()}`
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
    child.once('exit', (code, signal) => {
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

/** Build the four route handlers with injectable seams for tests. */
export function createHandlers(deps) {
  const platform = deps.platform ?? process.platform
  const dshHome = deps.dshHome ?? resolveDshHome()
  const pluginConfig = resolvePluginConfig(deps.config ?? {})
  const registry = deps.registry ?? { readRunValue, writeRunValue, removeRunValue }
  const fsImpl = deps.fs ?? fs
  const probe = deps.isPortListening ?? isPortListening
  const spawnHelper = deps.spawnHelper ?? defaultSpawnHelper
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
          `\uFEFF${renderBootstrap({ execPath: command.execPath, serviceJsPath: deps.serviceJsPath ?? SERVICE_JS })}`,
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
      // The detach helper exists only once autostart has been enabled: `enable`
      // is what writes config.json, and service.js restart exits 1 without it.
      // Spawning anyway would exit this host and leave nothing behind, i.e.
      // "restart" would silently mean "shut down". §7 has a row for this
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
      // The flag is set BEFORE the await, not after. spawnHelper is async now, so
      // setting it afterwards would leave an interleaving point where two
      // overlapping POSTs both pass the check above, launch two helpers, and arm
      // two exits — which spec §7 forbids ("a restart is already scheduled").
      restarting = true
      try {
        // Awaited on purpose: the launcher runs inside DSH's job, so it must
        // finish handing the helper to the WMI service BEFORE this host exits.
        // Fire-and-forget would let the exit kill the launcher mid-call, leaving
        // nothing behind to bring DSH back.
        //
        // configPath is passed explicitly rather than left to the helper: the WMI
        // boundary drops this process's environment, so DSH_HOME would be absent
        // and the helper would fall back to ~/.dsh and read the wrong config.
        // Derived from the resolved dshHome, so a deps.dshHome override is honoured.
        await spawnHelper({
          execPath: deps.execPath ?? process.execPath,
          serviceJsPath: deps.serviceJsPath ?? SERVICE_JS,
          oldPid: deps.currentPid ?? process.pid,
          configPath: configFilePath(dshHome),
        })
      } catch (error) {
        // Clear the flag so the user can retry: nothing was started, and the host
        // is still alive to serve the next request.
        restarting = false
        send(res, 500, { error: `could not start the restart helper: ${messageOf(error)}` })
        return
      }
      send(res, 202, { accepted: true, runningAgents: running })
      const scheduleExit = deps.scheduleExit ?? ((fn, ms) => setTimeout(fn, ms))
      scheduleExit(() => process.exit(0), pluginConfig.exitDelayMs)
    },
  }
}

/**
 * Remove the autostart entry on plugin unload — but only if it is still ours,
 * so an unrelated entry can never be deleted by accident.
 */
export function cleanupAutostart(deps) {
  const dshHome = deps.dshHome ?? resolveDshHome()
  const registry = deps.registry ?? { readRunValue, removeRunValue }
  const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
  let stored
  try {
    stored = registry.readRunValue()
  } catch {
    return
  }
  if (stored === null || !isOurEntry(stored, vbsPath)) return
  try {
    registry.removeRunValue()
  } catch {
    // best effort on unload
  }
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
      cleanupAutostart({})
    }
  }, 'dsh-autostart: routes')
}
