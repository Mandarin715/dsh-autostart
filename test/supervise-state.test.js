import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readPid, writePid, clearFile, anotherSupervisorAlive,
  writeRestartRequest, consumeRestartRequest, isStopRequested,
} from '../lib/supervise-state.js'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-state-'))
}

test('readPid returns null for a missing or unparsable file', () => {
  const dir = tmp()
  try {
    assert.equal(readPid(path.join(dir, 'nope.pid')), null)
    const bad = path.join(dir, 'bad.pid')
    fs.writeFileSync(bad, 'not-a-pid', 'utf8')
    assert.equal(readPid(bad), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('anotherSupervisorAlive is true only for a live pid that is not ours', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'supervise.pid')
    assert.equal(anotherSupervisorAlive(file, () => true), false, 'no file yet')
    writePid(file, 4242)
    assert.equal(anotherSupervisorAlive(file, () => true), true)
    assert.equal(anotherSupervisorAlive(file, () => false), false, 'stale pid is not alive')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('consumeRestartRequest only consumes a request that names the child that exited', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'restart.request')
    writeRestartRequest(file, 111)
    assert.equal(consumeRestartRequest(file, 999), false, 'someone else exit')
    assert.equal(fs.existsSync(file), true, 'must not delete a request that is not ours')
    assert.equal(consumeRestartRequest(file, 111), true)
    assert.equal(fs.existsSync(file), false, 'consumed requests are removed')
    assert.equal(consumeRestartRequest(file, 111), false, 'nothing left to consume')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('isStopRequested ignores a stop aimed at another supervisor', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'supervise.stop')
    writePid(file, 500)
    assert.equal(isStopRequested(file, 700), false, 'a stale stop must not kill a new supervisor')
    assert.equal(fs.existsSync(file), true)
    assert.equal(isStopRequested(file, 500), true)
    assert.equal(fs.existsSync(file), false, 'consumed stop markers are removed')
    assert.equal(isStopRequested(file, 500), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('clearFile tolerates a file that is not there', () => {
  const dir = tmp()
  try {
    assert.doesNotThrow(() => clearFile(path.join(dir, 'missing')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
