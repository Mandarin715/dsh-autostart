// The persisted contract between the plugin and service.js, plus plugin config
// defaults. Any field added later MUST keep a default so older config.json
// files keep working.
import os from 'node:os'
import path from 'node:path'

export const SCHEMA_VERSION = 1
export const CONFIG_DIR_NAME = 'dsh-autostart'

export const PLUGIN_DEFAULTS = {
  hookScript: '',
  dshPort: 3080,
  exitDelayMs: 800,
  waitForExitMs: 30000,
  startTimeoutMs: 30000,
  openBrowserOnBoot: false,
  blockWhenAgentsRunning: false,
}

function requirePort(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config: ${field} must be an integer between 1 and 65535`)
  }
  return value
}

function requireDuration(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`config: ${field} must be a non-negative integer`)
  }
  return value
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`config: ${field} must be a boolean`)
  return value
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new Error(`config: ${field} must be a string`)
  return value
}

/** Validate and fill the plugin's own config block. */
export function resolvePluginConfig(raw = {}) {
  const input = raw ?? {}
  const merged = { ...PLUGIN_DEFAULTS, ...input }
  return {
    hookScript: requireString(merged.hookScript, 'hookScript'),
    dshPort: requirePort(merged.dshPort, 'dshPort'),
    exitDelayMs: requireDuration(merged.exitDelayMs, 'exitDelayMs'),
    waitForExitMs: requireDuration(merged.waitForExitMs, 'waitForExitMs'),
    startTimeoutMs: requireDuration(merged.startTimeoutMs, 'startTimeoutMs'),
    openBrowserOnBoot: requireBoolean(merged.openBrowserOnBoot, 'openBrowserOnBoot'),
    blockWhenAgentsRunning: requireBoolean(merged.blockWhenAgentsRunning, 'blockWhenAgentsRunning'),
  }
}

/** `${DSH_HOME}` when set, otherwise `~/.dsh`. */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const configured = env?.DSH_HOME
  return typeof configured === 'string' && configured !== ''
    ? configured
    : path.join(homedir, '.dsh')
}

export function configDir(dshHome) {
  return path.join(dshHome, CONFIG_DIR_NAME)
}

export function configFilePath(dshHome) {
  return path.join(configDir(dshHome), 'config.json')
}

export function logPaths(dshHome) {
  const dir = configDir(dshHome)
  return {
    out: path.join(dir, 'dsh-web-server.log'),
    err: path.join(dir, 'dsh-web-server.err.log'),
    service: path.join(dir, 'service.log'),
  }
}

/** Assemble the full config.json payload written when autostart is enabled. */
export function buildConfigFile(input) {
  const { command, pluginConfig, dshHome, now = new Date() } = input
  if (command === undefined || command === null) throw new Error('config: command is required')
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    command,
    dshPort: pluginConfig.dshPort,
    hookScript: pluginConfig.hookScript,
    openBrowserOnBoot: pluginConfig.openBrowserOnBoot,
    waitForExitMs: pluginConfig.waitForExitMs,
    startTimeoutMs: pluginConfig.startTimeoutMs,
    logPaths: logPaths(dshHome),
  }
}

/** Parse a config.json, filling defaults so older files still load. */
export function parseConfigFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('config: config.json is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('config: config.json must be a JSON object')
  }
  // Mirror detectCommand's write-side validation: a command missing any of its
  // three fields would reach spawn() as undefined and throw an unhandled
  // TypeError instead of the designed clean exit.
  const command = parsed.command
  if (
    command === undefined ||
    command === null ||
    Array.isArray(command) ||
    typeof command !== 'object' ||
    typeof command.execPath !== 'string' ||
    command.execPath === '' ||
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    typeof command.cwd !== 'string' ||
    command.cwd === ''
  ) {
    throw new Error('config: config.json is missing the command field')
  }
  const plugin = resolvePluginConfig({
    hookScript: parsed.hookScript ?? PLUGIN_DEFAULTS.hookScript,
    dshPort: parsed.dshPort ?? PLUGIN_DEFAULTS.dshPort,
    exitDelayMs: parsed.exitDelayMs ?? PLUGIN_DEFAULTS.exitDelayMs,
    waitForExitMs: parsed.waitForExitMs ?? PLUGIN_DEFAULTS.waitForExitMs,
    startTimeoutMs: parsed.startTimeoutMs ?? PLUGIN_DEFAULTS.startTimeoutMs,
    openBrowserOnBoot: parsed.openBrowserOnBoot ?? PLUGIN_DEFAULTS.openBrowserOnBoot,
    blockWhenAgentsRunning:
      parsed.blockWhenAgentsRunning ?? PLUGIN_DEFAULTS.blockWhenAgentsRunning,
  })
  return {
    schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
    createdAt: parsed.createdAt ?? null,
    command: parsed.command,
    ...plugin,
    logPaths: parsed.logPaths ?? {},
  }
}
