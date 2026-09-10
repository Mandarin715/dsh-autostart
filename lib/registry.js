// HKCU Run autostart entry. The `exec` seam keeps every test off the real
// registry; production passes nothing and gets reg.exe.
import { execFileSync } from 'node:child_process'

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const RUN_VALUE_NAME = 'DSH autostart'

/** The exact command string stored in the registry. */
export function registryCommand(vbsPath) {
  return `wscript.exe "${vbsPath}"`
}

/** Whether a stored value is ours (so we never delete someone else's entry). */
export function isOurEntry(value, vbsPath) {
  if (typeof value !== 'string' || typeof vbsPath !== 'string') return false
  return value.toLowerCase() === registryCommand(vbsPath).toLowerCase()
}

function defaultExec(args) {
  return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true })
}

/**
 * Read the stored autostart command.
 * @returns the value, or null when the entry does not exist.
 */
export function readRunValue(exec = defaultExec) {
  let output
  try {
    output = exec(['query', RUN_KEY, '/v', RUN_VALUE_NAME])
  } catch {
    return null
  }
  if (typeof output !== 'string') return null
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(RUN_VALUE_NAME)) continue
    const parts = line.trim().split(/\s{2,}/)
    const value = parts.at(-1)
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** Create or overwrite the autostart entry. */
export function writeRunValue(vbsPath, exec = defaultExec) {
  exec(['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', registryCommand(vbsPath), '/f'])
}

/** Delete the autostart entry; a missing entry is not an error. */
export function removeRunValue(exec = defaultExec) {
  try {
    exec(['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f'])
  } catch {
    // already absent
  }
}
