// Launch the restart helper OUTSIDE DSH's job object.
//
// Why this file exists: DSH runs its subprocesses inside a Windows Job Object
// created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. A helper started with Node's
// `spawn(..., { detached: true })` does NOT escape that job — `detached` only
// sets DETACHED_PROCESS, it does not set CREATE_BREAKAWAY_FROM_JOB — so the
// moment DSH exits, the job closes and the helper is killed with it, before it
// can start the replacement. The restart button would then silently mean
// "shut down" (verified empirically: a detached child stays inside the job, and
// a process killed on job close leaves DSH down).
//
// The reliable, flag-free escape is to have a *different* service create the
// process: Win32_Process.Create runs inside the WMI provider host, which is not
// a DSH descendant, so what it creates is not in DSH's job. It therefore
// survives DSH's exit and can start the replacement instance.
//
// Three consequences of that boundary are handled here:
//  1. WMI creates the process with the PROVIDER HOST's environment, so the
//     caller's environment (notably DSH_HOME) is NOT inherited. The helper is
//     therefore told its config path explicitly and must not re-derive it.
//  2. The provider host hands the child no standard handles, so the helper
//     self-logs to service.log; nothing here relies on inherited stdio.
//  3. Errors have to cross back as data we can read. Windows PowerShell
//     serialises its error STREAM as CLIXML when stderr is redirected, so the
//     diagnostic line is written with [Console]::Error.WriteLine (which bypasses
//     that serialization) between two sentinels, because PowerShell still appends
//     a CLIXML progress blob afterwards.
import path from 'node:path'

/** Marks the one stderr line a failed launch wants the host to surface. */
export const LAUNCH_FAILURE_PREFIX = 'dsh-autostart-launch-failed:'

/** Closes that line, so the host can ignore whatever PowerShell appends next. */
export const LAUNCH_FAILURE_SUFFIX = ':dsh-autostart-launch-failed-end'

/**
 * Quote one argument for a Windows command line (Win32 rules).
 *
 * A backslash run immediately before a quote must be doubled so the quote is
 * still read as a quote, and a trailing backslash run must be doubled so it
 * cannot escape the closing quote we add.
 */
export function quoteWinArg(value) {
  const text = String(value)
  const escaped = text.replace(/(\\*)"/g, (_, run) => `${run}${run}\\"`)
  const out = escaped.replace(/(\\+)$/, (run) => `${run}${run}`)
  return `"${out}"`
}

/** Quote one value as a PowerShell single-quoted literal (an embedded quote is doubled). */
export function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Absolute path of the Windows PowerShell host.
 *
 * Absolute on purpose: CreateProcess resolves a bare `powershell.exe` with the
 * current directory searched first, so a planted executable in DSH's cwd would
 * be run instead.
 */
export function powershellPath(deps = {}) {
  const env = deps.env ?? process.env
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * The command line that runs the helper:
 *   "<node>" "<service.js>" restart --pid <n> --config "<config.json>"
 *
 * @param input.execPath - absolute path of the node executable.
 * @param input.serviceJsPath - absolute path of this package's service.js.
 * @param input.oldPid - pid the helper must wait to exit before restarting.
 * @param input.configPath - absolute path of config.json, required. The helper
 *   must NOT re-derive the DSH home: it is created across a boundary that drops
 *   the environment, so DSH_HOME would be absent and resolveDshHome() would fall
 *   back to ~/.dsh — the helper would read the wrong config.json, exit 1, and
 *   leave DSH down. Absolute because the WMI-created process gets the provider
 *   host's working directory, so a relative path would resolve somewhere else.
 */
export function buildHelperCommandLine(input) {
  const { execPath, serviceJsPath, oldPid, configPath } = input ?? {}
  if (typeof execPath !== 'string' || execPath === '') {
    throw new Error('buildHelperCommandLine: execPath is required')
  }
  if (typeof serviceJsPath !== 'string' || serviceJsPath === '') {
    throw new Error('buildHelperCommandLine: serviceJsPath is required')
  }
  if (!Number.isInteger(oldPid) || oldPid <= 0) {
    throw new Error(`buildHelperCommandLine: oldPid must be a positive integer, got ${String(oldPid)}`)
  }
  if (typeof configPath !== 'string' || configPath === '') {
    throw new Error(
      'buildHelperCommandLine: configPath is required (the helper must not re-derive DSH_HOME)',
    )
  }
  if (!path.win32.isAbsolute(configPath)) {
    throw new Error(
      `buildHelperCommandLine: configPath must be absolute, got ${configPath} (a relative path would resolve against the helper's working directory)`,
    )
  }
  return `${quoteWinArg(execPath)} ${quoteWinArg(serviceJsPath)} restart --pid ${oldPid} --config ${quoteWinArg(configPath)}`
}

/**
 * The powershell.exe invocation that asks the WMI service to create the helper.
 *
 * The script travels via -EncodedCommand (base64 UTF-16LE) so no layer of shell
 * quoting can mangle a path containing spaces or quotes.
 *
 * Two details are load-bearing:
 *  - ProcessStartupInformation.ShowWindow = 0 (SW_HIDE). Without it CreateProcess
 *    gives the console-subsystem helper a VISIBLE console. Measured on a machine
 *    whose default terminal is Windows Terminal: a visible window appeared and did
 *    not close with the helper. Because Invoke-CimMethod refused to bind
 *    ProcessStartupInformation, the create goes through [wmiclass].
 *  - Failures arrive two ways: a non-zero exit code, which is what the host reacts
 *    to, and a sentinel-delimited stderr line carrying the WMI ReturnValue, because
 *    "exited with code 1" alone is identical for WMI disabled, a missing PowerShell
 *    and access denied.
 */
export function buildLauncherArgv(helperCommandLine, deps = {}) {
  const open = quotePowerShellLiteral(`${LAUNCH_FAILURE_PREFIX} `)
  const close = quotePowerShellLiteral(` ${LAUNCH_FAILURE_SUFFIX}`)
  // [Console]::Error.WriteLine writes straight to the handle; Write-Error would
  // be serialised into CLIXML and arrive as an XML document.
  const report = (expression) =>
    `  [Console]::Error.WriteLine(${open} + ${expression} + ${close})`
  const script = [
    'try {',
    "  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
    '  $startup.ShowWindow = 0',
    `  $r = ([wmiclass]'Win32_Process').Create(${quotePowerShellLiteral(helperCommandLine)}, $null, $startup)`,
    '  if ($null -eq $r -or $r.ReturnValue -ne 0) {',
    report('("ReturnValue=" + $r.ReturnValue)'),
    '    exit 1',
    '  }',
    '} catch {',
    report('$_.Exception.Message'),
    '  exit 1',
    '}',
  ].join('\n')
  return {
    command: powershellPath(deps),
    // Exactly these three flags. Do NOT add -Encoding: with -EncodedCommand present
    // PowerShell then treats the base64 blob as a command NAME, fails with
    // CommandNotFoundException, and our sentinel never runs (caught by the
    // real-launcher test, which is the only thing that could see it).
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  }
}
