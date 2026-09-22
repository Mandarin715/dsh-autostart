import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArgv, detectCommand, mergeDetectedCommand } from '../lib/detect-command.js'

test('normalizeArgv appends --no-open when the browser must stay closed', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web'], { openBrowser: false }), [
    'bin.js',
    'web',
    '--no-open',
  ])
})

test('normalizeArgv keeps an existing --no-open exactly once', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web', '--no-open'], { openBrowser: false }), [
    'bin.js',
    'web',
    '--no-open',
  ])
})

test('normalizeArgv removes --no-open when the browser should open', () => {
  assert.deepEqual(normalizeArgv(['bin.js', 'web', '--no-open'], { openBrowser: true }), [
    'bin.js',
    'web',
  ])
})

test('normalizeArgv preserves unrelated flags', () => {
  assert.deepEqual(
    normalizeArgv(['bin.js', 'web', '--trusted-host', 'example.com'], { openBrowser: false }),
    ['bin.js', 'web', '--trusted-host', 'example.com', '--no-open'],
  )
})

test('detectCommand returns the normalized triple', () => {
  const command = detectCommand({
    execPath: 'C:\\node.exe',
    argv: ['C:\\bin.js', 'web'],
    cwd: 'C:\\work',
    openBrowser: false,
  })
  assert.deepEqual(command, {
    execPath: 'C:\\node.exe',
    argv: ['C:\\bin.js', 'web', '--no-open'],
    cwd: 'C:\\work',
  })
})

test('detectCommand rejects incomplete input', () => {
  assert.throws(() => detectCommand({ argv: ['a'], cwd: 'c' }), /execPath/)
  assert.throws(() => detectCommand({ execPath: 'a', cwd: 'c' }), /argv/)
  assert.throws(() => detectCommand({ execPath: 'a', argv: ['b'] }), /cwd/)
})

/** The command the live process would report, for the merge cases below. */
function detectedCommand(argv, cwd = 'C:\\live') {
  return detectCommand({ execPath: 'C:\\node.exe', argv, cwd, openBrowser: false })
}

test('mergeDetectedCommand returns the detected command when nothing was captured before', () => {
  const detected = detectedCommand(['C:\\new\\bin.js', 'web'])
  assert.deepEqual(mergeDetectedCommand(null, detected), detected)
})

test('mergeDetectedCommand refreshes the entry point from the live process', () => {
  const previous = {
    execPath: 'C:\\node.exe',
    argv: ['C:\\old\\bin.js', 'web', '--no-open'],
    cwd: 'C:\\work',
  }
  const merged = mergeDetectedCommand(previous, detectedCommand(['C:\\new\\bin.js', 'web']))
  assert.equal(merged.argv[0], 'C:\\new\\bin.js')
  assert.equal(merged.execPath, 'C:\\node.exe')
})

test('mergeDetectedCommand keeps the captured working directory over the live one', () => {
  const previous = { execPath: 'C:\\node.exe', argv: ['C:\\old\\bin.js', 'web'], cwd: 'C:\\work' }
  assert.equal(mergeDetectedCommand(previous, detectedCommand(['C:\\new\\bin.js', 'web'])).cwd, 'C:\\work')
})

test('mergeDetectedCommand keeps flags the live process was not started with', () => {
  const previous = {
    execPath: 'C:\\node.exe',
    argv: ['C:\\old\\bin.js', 'web', '--trusted-host', 'example.com', '--no-open'],
    cwd: 'C:\\work',
  }
  assert.deepEqual(mergeDetectedCommand(previous, detectedCommand(['C:\\new\\bin.js', 'web'])).argv, [
    'C:\\new\\bin.js',
    'web',
    '--no-open',
    '--trusted-host',
    'example.com',
  ])
})

test('mergeDetectedCommand does not duplicate a flag both sides carry', () => {
  const previous = {
    execPath: 'C:\\node.exe',
    argv: ['C:\\old\\bin.js', 'web', '--no-open'],
    cwd: 'C:\\work',
  }
  assert.deepEqual(
    mergeDetectedCommand(previous, detectedCommand(['C:\\new\\bin.js', 'web', '--no-open'])).argv,
    ['C:\\new\\bin.js', 'web', '--no-open'],
  )
})

test('mergeDetectedCommand ignores a previous capture with no usable argv', () => {
  const detected = detectedCommand(['C:\\new\\bin.js', 'web'])
  assert.deepEqual(mergeDetectedCommand({ argv: [] }, detected), detected)
})

test('mergeDetectedCommand falls back to the live directory when the capture has none', () => {
  const previous = { execPath: 'C:\\node.exe', argv: ['C:\\old\\bin.js', 'web'], cwd: '' }
  assert.equal(mergeDetectedCommand(previous, detectedCommand(['C:\\new\\bin.js', 'web'])).cwd, 'C:\\live')
})
