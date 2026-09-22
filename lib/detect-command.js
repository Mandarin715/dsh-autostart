// Detect the exact command that started this DSH process, so autostart and
// restart never hardcode an install path.

/**
 * Ensure `--no-open` matches the desired browser behavior, keeping other flags.
 * @param argv - argv WITHOUT the node executable (i.e. `process.argv.slice(1)`).
 * @param options.openBrowser - true keeps the browser-opening behavior.
 */
export function normalizeArgv(argv, options = {}) {
  const openBrowser = options.openBrowser ?? false
  const kept = argv.filter((arg) => arg !== '--no-open')
  return openBrowser ? kept : [...kept, '--no-open']
}

/**
 * Build the persisted command record from the current process's launcher facts.
 * @throws when any required field is missing or empty.
 */
export function detectCommand(input) {
  const { execPath, argv, cwd, openBrowser } = input ?? {}
  if (typeof execPath !== 'string' || execPath === '') {
    throw new Error('detectCommand: execPath is required')
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('detectCommand: argv is required')
  }
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('detectCommand: cwd is required')
  }
  return { execPath, argv: normalizeArgv(argv, { openBrowser }), cwd }
}

/**
 * Fold a previously captured command together with the one detected from the live process.
 *
 * Re-enabling autostart is meant to make DSH start at login — not to redefine how it is
 * launched. So the live process only decides the entry point (`execPath` and `argv[0]`),
 * which is the one field an upgrade legitimately moves. The working directory and any flag
 * the live process was not started with are kept from the capture that already worked.
 *
 * This is not hypothetical. Enabling autostart from a DSH that had been launched out of
 * `C:\Users\asus` captured that directory as the boot working directory — the path is not one
 * of the registered workspaces, so the session list came up empty — and dropped the
 * `--trusted-host` flags that the older capture carried, breaking remote access.
 *
 * @param previous - the `command` block of an existing config.json, or null.
 * @param detected - the command detected from the live process.
 */
export function mergeDetectedCommand(previous, detected) {
  if (!previous || !Array.isArray(previous.argv) || previous.argv.length === 0) return detected
  const missing = previous.argv.slice(1).filter((arg) => !detected.argv.includes(arg))
  const cwd =
    typeof previous.cwd === 'string' && previous.cwd !== '' ? previous.cwd : detected.cwd
  return { execPath: detected.execPath, argv: [...detected.argv, ...missing], cwd }
}
