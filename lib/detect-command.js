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
