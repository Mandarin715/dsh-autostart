// The supervisor's only channel to the outside world is three pid-carrying files in
// ~/.dsh/dsh-autostart/. Every rule here exists so a *stale* file cannot cause harm:
// a request is honoured only when it names the child that just exited, a stop marker only
// when it names this supervisor, and a pid file only when its process is still alive.
import fs from 'node:fs'

/** Read a pid file. Returns null for missing, empty or unparsable content. */
export function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Write a pid file. Best effort: a failure here must never take the caller down. */
export function writePid(file, pid) {
  try {
    fs.writeFileSync(file, `${pid}\n`, 'utf8')
  } catch {
    // nothing else we can do
  }
}

/** Remove a file. Best effort. */
export function clearFile(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // nothing else we can do
  }
}

/** Whether another live supervisor already owns this dshHome. */
export function anotherSupervisorAlive(file, isAlive) {
  const pid = readPid(file)
  return pid !== null && isAlive(pid)
}

/** Ask for a restart of the DSH process with this pid. */
export function writeRestartRequest(file, pid) {
  writePid(file, pid)
}

/**
 * Consume a restart request for the child that just exited.
 * Only a matching pid is honoured and only then is the file removed: a request left behind
 * by an earlier, unrelated exit must not resurrect anything.
 */
export function consumeRestartRequest(file, childPid) {
  if (readPid(file) !== childPid) return false
  clearFile(file)
  return true
}

/** Whether this supervisor is being asked to stop. Deletes the marker when it applies. */
export function isStopRequested(file, selfPid) {
  if (readPid(file) !== selfPid) return false
  clearFile(file)
  return true
}
