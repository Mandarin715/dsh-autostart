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

/** Quote one argument for a Windows command line. */
export function quoteWinArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

/** Quote one value as a PowerShell single-quoted literal (an embedded quote is doubled). */
export function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The command line that runs the helper:
 *   "<node>" "<service.js>" restart --pid <n>
 *
 * @param input.execPath - absolute path of the node executable.
 * @param input.serviceJsPath - absolute path of this package's service.js.
 * @param input.oldPid - pid the helper must wait to exit before restarting.
 */
export function buildHelperCommandLine(input) {
  const { execPath, serviceJsPath, oldPid } = input ?? {}
  if (typeof execPath !== 'string' || execPath === '') {
    throw new Error('buildHelperCommandLine: execPath is required')
  }
  if (typeof serviceJsPath !== 'string' || serviceJsPath === '') {
    throw new Error('buildHelperCommandLine: serviceJsPath is required')
  }
  if (!Number.isInteger(oldPid) || oldPid <= 0) {
    throw new Error(`buildHelperCommandLine: oldPid must be a positive integer, got ${String(oldPid)}`)
  }
  return `${quoteWinArg(execPath)} ${quoteWinArg(serviceJsPath)} restart --pid ${oldPid}`
}

/**
 * The powershell.exe invocation that asks the WMI service to create the helper.
 *
 * The script travels via -EncodedCommand (base64 UTF-16LE) so no layer of shell
 * quoting can mangle a path containing spaces or quotes. A failed create becomes
 * exit 1, because the launch runs with stdio 'ignore' and so has no stderr to
 * report through — the exit code is the only channel left.
 */
export function buildLauncherArgv(helperCommandLine) {
  const script = [
    'try {',
    `  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShellLiteral(helperCommandLine)} } -ErrorAction Stop`,
    '  if ($null -eq $r -or $r.ReturnValue -ne 0) { exit 1 }',
    '} catch { exit 1 }',
  ].join('\n')
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  }
}
