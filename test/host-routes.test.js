import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameOrigin, createHandlers } from '../index.js'

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) {
      this.statusCode = code
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeReq(overrides = {}) {
  return { method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, ...overrides }
}

test('sameOrigin accepts a matching origin and rejects others', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), false)
  assert.equal(sameOrigin({ host: '127.0.0.1:3080' }), false)
  assert.equal(sameOrigin({}), false)
})

test('sameOrigin rejects a non-loopback Host even when Origin agrees with it', () => {
  // DNS rebinding: a page served from evil.example:<port> whose domain then
  // rebinds to 127.0.0.1:<port> presents a Host and an Origin that agree with
  // each other, so equality alone would let it write HKCU\...\Run.
  assert.equal(sameOrigin({ host: 'evil.example:3080', origin: 'http://evil.example:3080' }), false)
  // Same for any other authority that is not this machine's loopback service.
  assert.equal(sameOrigin({ host: '192.168.1.5:3080', origin: 'http://192.168.1.5:3080' }), false)
})

test('sameOrigin enforces the expected port when one is given', () => {
  assert.equal(sameOrigin({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, 3080), true)
  assert.equal(sameOrigin({ host: 'localhost:3080', origin: 'http://localhost:3080' }, 3080), true)
  assert.equal(sameOrigin({ host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }, 3080), false)
})

test('enable refuses on an unsupported platform', async () => {
  const handlers = createHandlers({
    platform: 'linux',
    config: {},
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    // Throwing doubles: if the guard ever stops short-circuiting before the
    // side effects, this test must fail loudly rather than write to the real
    // registry or the real ~/.dsh.
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body, /Windows/)
})

test('enable refuses cross-origin POSTs', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    // Same throwing-double protection as the unsupported-platform test: this
    // test exists to prove the guard refuses, so a broken guard must not be
    // able to reach the real system.
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), res)
  assert.equal(res.statusCode, 403)
})

test('enable refuses a rebinding-style request whose Host and Origin agree off-loopback', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    config: {},
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {
        throw new Error('must not touch the filesystem')
      },
      writeFileSync: () => {
        throw new Error('must not touch the filesystem')
      },
    },
    registry: {
      writeRunValue: () => {
        throw new Error('must not touch the registry')
      },
      removeRunValue: () => {
        throw new Error('must not touch the registry')
      },
    },
  })
  const res = fakeRes()
  await handlers.enable(
    fakeReq({ headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } }),
    res,
  )
  assert.equal(res.statusCode, 403)
})

test('enable writes config, vbs and the registry entry', async () => {
  const written = {}
  const registryCalls = []
  const handlers = createHandlers({
    platform: 'win32',
    config: { dshPort: 3080 },
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (file, data) => {
        written[file] = data
      },
    },
    registry: {
      writeRunValue: (vbsPath) => registryCalls.push(vbsPath),
    },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, true)
  assert.ok(written['C:\\dsh\\dsh-autostart\\config.json'].includes('"dshPort": 3080'))
  assert.ok(written['C:\\dsh\\dsh-autostart\\bootstrap.vbs'].includes('Generated by dsh-autostart'))
  assert.deepEqual(registryCalls, ['C:\\dsh\\dsh-autostart\\bootstrap.vbs'])
})

test('enable writes the vbs as UTF-16LE with a BOM so non-ASCII paths survive wscript', async () => {
  const calls = []
  const handlers = createHandlers({
    platform: 'win32',
    config: {},
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (file, data, encoding) => {
        calls.push({ file, data, encoding })
      },
    },
    registry: { writeRunValue: () => {} },
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  const vbs = calls.find((call) => call.file.endsWith('bootstrap.vbs'))
  assert.equal(vbs.encoding, 'utf16le')
  assert.equal(vbs.data.charCodeAt(0), 0xfeff)
})

test('disable removes only our own registry entry', async () => {
  const removed = []
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => 'wscript.exe "C:\\dsh\\dsh-autostart\\bootstrap.vbs"',
      removeRunValue: () => removed.push('removed'),
    },
  })
  const res = fakeRes()
  await handlers.disable(fakeReq(), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(removed, ['removed'])
})

test('disable leaves a foreign registry entry alone', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => '"C:\\other\\thing.exe"',
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
  })
  const res = fakeRes()
  await handlers.disable(fakeReq(), res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.enabled, true)
  assert.equal(payload.foreignEntry, true)
})
