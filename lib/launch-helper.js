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
// Two consequences of that boundary are handled here:
//  1. WMI creates the process with the PROVIDER HOST's environment, so the
//     caller's environment (notably DSH_HOME) is NOT inherited. The helper must
//     therefore be told its config path explicitly — see configPath below —
//     rather than re-deriving the DSH home from the environment.
//  2. The provider host does not hand the child any standard handles, so the
//     helper self-logs to service.log; nothing here relies on inherited stdio.

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
 *   leave DSH down. Pass the configFilePath(dshHome) the host actually used.
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
  return `${quoteWinArg(execPath)} ${quoteWinArg(serviceJsPath)} restart --pid ${oldPid} --config ${quoteWinArg(configPath)}`
}

/**
 * The powershell.exe invocation that asks the WMI service to create the helper.
 *
 * The script travels via -EncodedCommand (base64 UTF-16LE) so no layer of shell
 * quoting can mangle a path containing spaces or quotes.
 *
 * Failures must arrive two ways: a non-zero exit code, because that is what the
 * host reacts to (and the only channel that survives any stdio choice), and a
 * Write-Error carrying the WMI ReturnValue, because "exited with code 1" alone
 * is the same message for WMI disabled, a missing PowerShell, and access denied.
 */
export function buildLauncherArgv(helperCommandLine, deps = {}) {
  const script = [
    'try {',
    `  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShellLiteral(helperCommandLine)} } -ErrorAction Stop`,
    '  if ($null -eq $r -or $r.ReturnValue -ne 0) {',
    '    Write-Error ("Win32_Process.Create failed, ReturnValue=" + $r.ReturnValue)',
    '    exit 1',
    '  }',
    '} catch {',
    '  Write-Error ("Win32_Process.Create threw: " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n')
  return {
    command: powershellPath(deps),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}
