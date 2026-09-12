import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  buildHelperCommandLine,
  buildLauncherArgv,
  powershellPath,
  quoteWinArg,
} from '../lib/launch-helper.js'

const CONFIG_PATH = 'C:\\Users\\a b\\.dsh\\dsh-autostart\\config.json'

test('buildHelperCommandLine quotes each path and appends the supervise arguments', () => {
  const line = buildHelperCommandLine({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    serviceJsPath: 'C:\\Users\\a b\\dsh-autostart\\service.js',
    takeoverPid: 4321,
    configPath: CONFIG_PATH,
  })
  assert.equal(
    line,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\dsh-autostart\\service.js" supervise --config "C:\\Users\\a b\\.dsh\\dsh-autostart\\config.json" --takeover 4321',
  )
})

test('buildHelperCommandLine refuses a pid that is not a positive integer', () => {
  // The pid is interpolated into a command line handed to the OS: a non-numeric
  // value must never reach it.
  for (const takeoverPid of [Number.NaN, -1, 0, 1.5, '4321']) {
    assert.throws(
      () =>
        buildHelperCommandLine({
          execPath: 'node.exe',
          serviceJsPath: 'service.js',
          takeoverPid,
          configPath: CONFIG_PATH,
        }),
      /takeoverPid/,
      `expected takeoverPid ${String(takeoverPid)} to be refused`,
    )
  }
})

test('buildHelperCommandLine requires an explicit config path', () => {
  // The helper must never re-derive the DSH home. WMI creates the process with
  // the provider host's environment, so the caller's DSH_HOME is absent and
  // resolveDshHome() silently falls back to ~/.dsh: the helper would read a
  // different config.json, exit 1, and leave DSH down. Passing the path
  // explicitly removes that whole class of failure.
  for (const configPath of [undefined, null, '']) {
    assert.throws(
      () =>
        buildHelperCommandLine({ execPath: 'node.exe', serviceJsPath: 's.js', takeoverPid: 1, configPath }),
      /configPath/,
      `expected configPath ${String(configPath)} to be refused`,
    )
  }
})

test('quoteWinArg doubles a backslash run before the closing quote', () => {
  // `"C:\dir\"` would let the closing quote be read as an escaped literal,
  // merging the following argument into this one.
  assert.equal(quoteWinArg('C:\\dir\\'), '"C:\\dir\\\\"')
  assert.equal(quoteWinArg('plain'), '"plain"')
  assert.equal(quoteWinArg('C:\\a b\\c'), '"C:\\a b\\c"')
})

test('powershellPath is absolute, so CreateProcess cannot run a local impostor', () => {
  // A bare 'powershell.exe' is resolved with the current directory searched
  // first, so a planted executable in cwd would be run instead.
  assert.equal(
    powershellPath({ env: { SystemRoot: 'C:\\Win' } }),
    'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.match(powershellPath({ env: {} }), /^[A-Za-z]:\\/)
})

test('buildLauncherArgv asks WMI for a HIDDEN window', () => {
  // Win32_Process.Create gives a console-subsystem program a VISIBLE console by
  // default. Measured on a machine whose default terminal is Windows Terminal:
  // without startup information a visible CASCADIA_HOSTING_WINDOW_CLASS window
  // appeared (and the terminal window does not close with the child, so it
  // lingers); with ProcessStartupInformation.ShowWindow = 0 the console window is
  // created hidden. "No console window at any point" is this plugin's headline
  // promise, so this assertion is load-bearing, not cosmetic.
  const { args } = buildLauncherArgv('"C:\\node.exe" "C:\\svc.js" restart --pid 7')
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.match(script, /Win32_ProcessStartup/)
  assert.match(script, /ShowWindow\s*=\s*0/)
  assert.match(script, /\.Create\(/)
})

test('buildLauncherArgv asks the WMI service to create the helper process', () => {
  const helperLine = '"C:\\node.exe" "C:\\svc.js" restart --pid 7'
  const { command, args } = buildLauncherArgv(helperLine)

  assert.match(command, /powershell\.exe$/i)
  assert.ok(args.includes('-NoProfile'), 'must not read the user profile')
  assert.ok(args.includes('-EncodedCommand'), 'the script must be passed encoded, not quoted inline')

  const encoded = args[args.indexOf('-EncodedCommand') + 1]
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  // [wmiclass] rather than Invoke-CimMethod: the CIM cmdlet could not bind
  // ProcessStartupInformation ("类型不匹配"), and the startup information is what
  // suppresses the console window.
  assert.match(script, /wmiclass/)
  assert.match(script, /Win32_Process/)
  assert.ok(script.includes('Win32_ProcessStartup'), 'the startup information must be requested')
  // The helper command line has to survive as data, single-quoted for PowerShell.
  assert.ok(script.includes(`'${helperLine}'`), `script did not carry the helper line: ${script}`)
})

test('buildHelperCommandLine requires an absolute config path', () => {
  // A relative path would be resolved against whatever cwd the WMI-created
  // helper happens to get (system32), reopening the wrong-config class this
  // parameter exists to close. Refusing is the fail-closed answer.
  assert.throws(
    () =>
      buildHelperCommandLine({
        execPath: 'node.exe',
        serviceJsPath: 's.js',
        takeoverPid: 1,
        configPath: 'relative\\config.json',
      }),
    /absolute/,
  )
})

test('buildLauncherArgv makes a failed WMI create both visible and diagnosable', () => {
  // The exit code is what the host reacts to, but "exited with code 1" alone is
  // the same message for WMI disabled, a missing PowerShell, and Access denied.
  //
  // The reason must NOT go through Write-Error: with stderr redirected, Windows
  // PowerShell serialises the error stream as CLIXML, so the host would receive
  // an XML document instead of a sentence. [Console]::Error.WriteLine bypasses
  // that, and the sentinel pair lets the host find the line even though
  // PowerShell still appends a CLIXML progress blob after it.
  const { args } = buildLauncherArgv('"C:\\node.exe" "C:\\svc.js" restart --pid 7')
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.match(script, /ReturnValue/)
  assert.match(script, /\[Console\]::Error\.WriteLine/)
  assert.doesNotMatch(script, /Write-Error/)
  assert.match(script, /dsh-autostart-launch-failed/)
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

test(
  'the real launcher exits non-zero when Win32_Process.Create cannot start the target',
  { skip: process.platform === 'win32' ? false : 'Windows only' },
  async () => {
    // Pins the real failure channel end to end instead of asserting on script
    // text: a command line whose executable does not exist must produce a
    // non-zero exit that the host turns into a 500 without exiting itself.
    const { command, args } = buildLauncherArgv('"C:\\definitely\\missing\\no-such-exe.exe"')
    const code = await new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
      child.once('exit', resolve)
      child.once('error', (error) => resolve(`spawn-error: ${error.code ?? error.message}`))
    })
    // Exactly 1: a spawn failure (no PowerShell) or a 0 would both mean the
    // failure channel is broken, and `!== 0` would let the former pass.
    assert.equal(code, 1)
  },
)
