// dsh-autostart — host face.
//
// Registers the settings card's HTTP endpoints. The browser face (client.js)
// talks to these with same-origin fetch; no Typert dependency is needed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSupportedPlatform, unsupportedReason } from './lib/platform.js'
import { isPortListening } from './lib/port.js'
import {
  PLUGIN_DEFAULTS,
  resolvePluginConfig,
  resolveDshHome,
  configDir,
  configFilePath,
  logPaths,
  buildConfigFile,
} from './lib/config.js'
import {
  RUN_VALUE_NAME,
  readRunValue,
  writeRunValue,
  removeRunValue,
  isOurEntry,
} from './lib/registry.js'
import { detectCommand } from './lib/detect-command.js'
import { parseLatestAccessUrl } from './lib/parse-url.js'
import { renderBootstrapVbs as renderBootstrap } from './lib/render-vbs.js'

const SERVICE_JS = fileURLToPath(new URL('./service.js', import.meta.url))

/** Replaced in Task 11 with the real detached spawn. */
function defaultSpawnHelper() {
  throw new Error('restart is not implemented yet')
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
 * @param expectedPort - the plugin's configured dshPort; when given, the Host
 *   must name exactly it.
 * @param allowedHosts - extra authorities the user explicitly trusts, for
 *   reaching DSH through a reverse proxy (frp + auth-proxy forwards the
 *   original Host, so the browser sends the public domain, not loopback).
 *   The port and same-origin checks still apply to these.
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
  const trusted = Array.isArray(allowedHosts)
    ? allowedHosts.some((entry) => {
        // The plan documents entries as bare hostnames (['derp.example.com'])
        // while the listing compares them as full authorities; accept both so a
        // user following either form is admitted. The port and same-origin
        // checks below still bind whichever form matched.
        const configured = String(entry).toLowerCase()
        return configured === hostUrl.host.toLowerCase() || configured === hostUrl.hostname.toLowerCase()
      })
    : false
  if (!LOOPBACK_HOSTNAMES.has(hostUrl.hostname) && !trusted) return false
  if (Number.isInteger(expectedPort) && hostUrl.port !== String(expectedPort)) return false
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
        send(res, 200, { enabled: true, configPath: configFilePath(dshHome), vbsPath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 500, { error: `enable failed: ${message}` })
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

    // Task 11 replaces this with the real restart implementation.
    async restart(req, res) {
      if (!guard(req, res)) return
      send(res, 501, { error: 'not implemented yet' })
    },
  }
}

/** Cordis row entry: mount the four routes on the web server. */
export const inject = ['webServer']

export function apply(ctx, config) {
  const handlers = createHandlers({ config })
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
    }
  }, 'dsh-autostart: routes')
}
