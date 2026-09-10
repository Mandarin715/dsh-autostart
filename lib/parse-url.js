// Parse the authenticated access URL that `dsh web` prints at startup.
// DSH mints a fresh launch token per process, so the newest line in the
// captured stdout is the only valid URL after a restart.

const ACCESS_URL = /dsh web:\s*(https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+)/

/**
 * @param logText - the captured stdout of the DSH web process.
 * @returns the most recent access URL, or null when none is present yet.
 */
export function parseLatestAccessUrl(logText) {
  if (typeof logText !== 'string' || logText === '') return null
  // Only newline-terminated lines are eligible. The log is captured while DSH
  // writes it, and a token read mid-write is a truncated — i.e. wrong — URL.
  // Anything after the final newline is dropped: either the normal empty
  // segment of a flushed line, or a half-written line.
  const lines = logText.split(/\r?\n/)
  const trailing = lines.pop()
  if (trailing !== '') return null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === '') continue
    const match = ACCESS_URL.exec(lines[index])
    return match === null ? null : match[1]
  }
  return null
}
