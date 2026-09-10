import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHelperCommandLine, buildLauncherArgv } from '../lib/launch-helper.js'

test('buildHelperCommandLine quotes each path and appends the restart arguments', () => {
  const line = buildHelperCommandLine({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    serviceJsPath: 'C:\\Users\\a b\\dsh-autostart\\service.js',
    oldPid: 4321,
  })
  assert.equal(
    line,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\dsh-autostart\\service.js" restart --pid 4321',
  )
})

test('buildHelperCommandLine refuses a pid that is not a positive integer', () => {
  // The pid is interpolated into a command line handed to the OS: a non-numeric
  // value must never reach it.
  for (const oldPid of [Number.NaN, -1, 0, 1.5, '4321']) {
    assert.throws(
      () => buildHelperCommandLine({ execPath: 'node.exe', serviceJsPath: 'service.js', oldPid }),
      /oldPid/,
      `expected oldPid ${String(oldPid)} to be refused`,
    )
  }
})

test('buildLauncherArgv asks the WMI service to create the helper process', () => {
  const helperLine = '"C:\\node.exe" "C:\\svc.js" restart --pid 7'
  const { command, args } = buildLauncherArgv(helperLine)

  assert.equal(command, 'powershell.exe')
  assert.ok(args.includes('-NoProfile'), 'must not read the user profile')
  assert.ok(args.includes('-EncodedCommand'), 'the script must be passed encoded, not quoted inline')

  const encoded = args[args.indexOf('-EncodedCommand') + 1]
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /Invoke-CimMethod/)
  assert.match(script, /Win32_Process/)
  assert.match(script, /-MethodName Create/)
  // The helper command line has to survive as data, single-quoted for PowerShell.
  assert.ok(script.includes(`'${helperLine}'`), `script did not carry the helper line: ${script}`)
})

test('buildLauncherArgv makes a failed WMI create visible in the exit code', () => {
  // stderr cannot be read back (the launch uses stdio 'ignore'), so a failed
  // Win32_Process.Create must surface as a non-zero exit instead of a silent 0 —
  // otherwise the host would exit believing a helper is on its way.
  const { args } = buildLauncherArgv('"C:\\node.exe" "C:\\svc.js" restart --pid 7')
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.match(script, /ReturnValue/)
  assert.match(script, /exit 1/)
})

test('buildLauncherArgv escapes an apostrophe so a path cannot break out of the literal', () => {
  // "O'Brien" is a legal Windows user name; an unescaped quote would end the
  // PowerShell string early and turn the rest of the path into script code.
  const { args } = buildLauncherArgv(`"C:\\node.exe" "C:\\Users\\O'Brien\\svc.js" restart --pid 7`)
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.match(script, /O''Brien/)
  assert.doesNotMatch(script, /O'Brien/)
})
