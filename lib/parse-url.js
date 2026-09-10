// Parse the authenticated access URL that `dsh web` prints at startup.
// DSH mints a fresh launch token per process, so the newest line in the
// captured stdout is the only valid URL after a restart.

const ACCESS_URL = /dsh web:\s*(https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+)/g

/**
 * @param logText - the captured stdout of the DSH web process.
 * @returns the most recent access URL, or null when none is present yet.
 */
export function parseLatestAccessUrl(logText) {
  if (typeof logText !== 'string' || logText === '') return null
  let latest = null
  for (const match of logText.matchAll(ACCESS_URL)) {
    latest = match[1]
  }
  return latest
}
