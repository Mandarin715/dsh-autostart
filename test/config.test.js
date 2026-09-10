import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_DEFAULTS,
  resolvePluginConfig,
  resolveDshHome,
  configDir,
  configFilePath,
  logPaths,
  buildConfigFile,
  parseConfigFile,
} from '../lib/config.js'

test('resolvePluginConfig fills every default', () => {
  assert.deepEqual(resolvePluginConfig(), PLUGIN_DEFAULTS)
  assert.deepEqual(resolvePluginConfig({}), PLUGIN_DEFAULTS)
})

test('resolvePluginConfig honors provided values', () => {
  const cfg = resolvePluginConfig({ dshPort: 8080, hookScript: 'C:\\hook.ps1', exitDelayMs: 100 })
  assert.equal(cfg.dshPort, 8080)
  assert.equal(cfg.hookScript, 'C:\\hook.ps1')
  assert.equal(cfg.exitDelayMs, 100)
  assert.equal(cfg.waitForExitMs, PLUGIN_DEFAULTS.waitForExitMs)
})

test('resolvePluginConfig rejects bad types and ranges', () => {
  assert.throws(() => resolvePluginConfig({ dshPort: 'nope' }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ dshPort: 0 }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ dshPort: 70000 }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ waitForExitMs: -1 }), /waitForExitMs/)
  assert.throws(() => resolvePluginConfig({ hookScript: 42 }), /hookScript/)
  assert.throws(() => resolvePluginConfig({ openBrowserOnBoot: 'yes' }), /openBrowserOnBoot/)
})

test('resolveDshHome prefers DSH_HOME then the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\dsh' }, 'C:\\Users\\me'), 'D:\\dsh')
  assert.equal(resolveDshHome({}, 'C:\\Users\\me'), 'C:\\Users\\me\\.dsh')
})

test('path helpers hang off the dsh home', () => {
  const home = 'C:\\Users\\me\\.dsh'
  assert.equal(configDir(home), 'C:\\Users\\me\\.dsh\\dsh-autostart')
  assert.equal(configFilePath(home), 'C:\\Users\\me\\.dsh\\dsh-autostart\\config.json')
  assert.deepEqual(logPaths(home), {
    out: 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.log',
    err: 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.err.log',
    service: 'C:\\Users\\me\\.dsh\\dsh-autostart\\service.log',
  })
})

test('buildConfigFile assembles the persisted contract', () => {
  const file = buildConfigFile({
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    pluginConfig: resolvePluginConfig({ dshPort: 4000 }),
    dshHome: 'C:\\Users\\me\\.dsh',
    now: new Date('2026-09-10T00:00:00.000Z'),
  })
  assert.equal(file.schemaVersion, 1)
  assert.equal(file.createdAt, '2026-09-10T00:00:00.000Z')
  assert.equal(file.dshPort, 4000)
  assert.deepEqual(file.command.argv, ['bin.js', 'web', '--no-open'])
  assert.equal(file.logPaths.out, 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.log')
})

test('parseConfigFile restores defaults for fields missing from an older file', () => {
  const old = JSON.stringify({
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web'], cwd: 'C:\\work' },
    dshPort: 3080,
  })
  const parsed = parseConfigFile(old)
  assert.equal(parsed.startTimeoutMs, PLUGIN_DEFAULTS.startTimeoutMs)
  assert.equal(parsed.hookScript, '')
  assert.equal(parsed.command.execPath, 'node.exe')
})

test('parseConfigFile rejects malformed input', () => {
  assert.throws(() => parseConfigFile('not json'), /config/)
  assert.throws(() => parseConfigFile('{}'), /command/)
})

test('parseConfigFile rejects a null or array command instead of passing it through', () => {
  // typeof null === 'object', so without an explicit check a hand-edited
  // config.json would hand service.js a null command and it would throw an
  // unhandled TypeError inside spawn() rather than the designed clean exit.
  assert.throws(() => parseConfigFile('{"command":null}'), /command/)
  assert.throws(() => parseConfigFile('{"command":[]}'), /command/)
})

test('parseConfigFile rejects a command missing its own fields', () => {
  assert.throws(() => parseConfigFile('{"command":{}}'), /command/)
  assert.throws(() => parseConfigFile('{"command":{"execPath":"n","argv":["b"],"cwd":""}}'), /command/)
  assert.throws(() => parseConfigFile('{"command":{"execPath":"n","argv":[],"cwd":"c"}}'), /command/)
})
