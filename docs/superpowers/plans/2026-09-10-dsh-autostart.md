# dsh-autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个 Windows 专用的 DSH 插件,让用户能在设置页一键启用「开机自动启动 DSH 服务」并一键重启该服务,且全程无控制台窗口。

**Architecture:** 插件由两个部件构成 —— (1) 插件本体(`index.js` host 侧 + `client.js` 浏览器侧)负责状态聚合、注册表读写、生成 `config.json`/`bootstrap.vbs`、以及重启调度;(2) 独立 Node 助手 `service.js` 负责真正启动/重启 DSH(因为宿主调用 `process.exit(0)` 后自身无法继续)。所有等待一律用**条件轮询**,不用固定 sleep;所有进程一律 **detached**,不依赖宿主进程树。

**Tech Stack:** Node.js ≥ 20(ESM,零运行时依赖)· `node:test` 做测试 · DSH Cordis 插件机制(`ctx.webServer.register` + `ctx.slots.register`)· Windows `reg.exe` 读写注册表 · `wscript.exe` 无窗口启动

**Spec:** `docs/superpowers/specs/2026-09-10-dsh-autostart-design.md`

## Global Constraints

- **平台**:仅 Windows(`process.platform === 'win32'`);非 Windows 必须显式拒绝,不做跨平台分支
- **Node**:≥ 20;测试用内置 `node:test`,运行命令 `node --test`
- **零新增运行时依赖**:`package.json` 的 `dependencies` 必须为空;不使用第三方 npm 包
- **不使用 PowerShell 实现插件逻辑**(仅 `bootstrap.vbs` 负责无窗口启动;用户钩子脚本可由用户自行提供 `.ps1`)
- **等待一律条件轮询**(`intervalMs` 轮询 + 超时),禁止 `setTimeout(固定时长)` 式的固定 sleep
- **端口判定只允许 TCP 连接探测**(`lib/port.js`);禁止 `netstat` 文本解析、禁止 `:port` 子串匹配
- **所有写操作 POST 必须做 same-origin 校验**,不通过返回 403
- **配置目录**:`${process.env.DSH_HOME ?? os.homedir() + '/.dsh'}/dsh-autostart/`
- **注册表值名**:`DSH autostart`,位于 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- **`service.js` 不依赖 DSH 运行时**:它只读 `config.json`,可脱离 DSH 单独运行
- **README(中英双份)必须在显著位置包含 spec §0 的免责声明**
- **重启按钮二次确认文案必须含**:「可能中断正在进行的任务,未落盘的对话可能丢失」
- **许可证**:MIT

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 包元数据、`dsh.bundle.patch`、`dsh.client` 声明、`test`/`check` 脚本 |
| `cordis.patch.yml` | 把 host 行 `dsh-autostart` 插入 loader 树 |
| `lib/platform.js` | 平台门控(纯函数) |
| `lib/port.js` | TCP 端口探测 + 条件轮询等待(纯逻辑,可测) |
| `lib/detect-command.js` | 探测当前 DSH 启动命令 + argv 规范化(纯函数) |
| `lib/parse-url.js` | 从 DSH 日志解析最新带 token 访问地址(纯函数) |
| `lib/render-vbs.js` | 渲染 `bootstrap.vbs`(纯函数) |
| `lib/config.js` | 插件配置默认值/校验 + `config.json` 读写契约(纯函数 + 一层 fs) |
| `lib/registry.js` | `HKCU Run` 读写(执行器可注入,便于测试) |
| `service.js` | Node 助手:`start` / `restart` 两个模式 + 钩子执行 |
| `index.js` | host 侧:Cordis 行、HTTP 路由、状态聚合、重启调度 |
| `client.js` | 浏览器侧:`settings.general.item` 插槽里的卡片 UI |
| `test/*.test.js` | `node:test` 单测 |
| `README.md` / `README.zh.md` | 英文/中文文档(含免责声明) |
| `LICENSE` | MIT |

---

## Task 1: 仓库骨架 + 平台门控

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `LICENSE`, `lib/platform.js`, `test/platform.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isSupportedPlatform(platform?: string): boolean`
  - `unsupportedReason(platform?: string): string`

- [ ] **Step 1: 写失败测试**

`test/platform.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedPlatform, unsupportedReason } from '../lib/platform.js'

test('win32 is supported', () => {
  assert.equal(isSupportedPlatform('win32'), true)
})

test('other platforms are not supported', () => {
  for (const p of ['darwin', 'linux', 'freebsd']) {
    assert.equal(isSupportedPlatform(p), false)
  }
})

test('unsupportedReason names the current platform', () => {
  const reason = unsupportedReason('linux')
  assert.match(reason, /Windows/)
  assert.match(reason, /linux/)
})

test('defaults to the real platform', () => {
  assert.equal(isSupportedPlatform(), process.platform === 'win32')
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/platform.test.js`
Expected: FAIL —— `Cannot find module '../lib/platform.js'`

- [ ] **Step 3: 写最小实现**

`lib/platform.js`:

```js
// Platform gate. dsh-autostart is Windows-only by design (HKCU Run + wscript.exe).

/**
 * Whether the plugin's mechanisms exist on this platform.
 * @param platform - a `process.platform` value; defaults to the real one.
 */
export function isSupportedPlatform(platform = process.platform) {
  return platform === 'win32'
}

/**
 * Human-readable refusal reason for unsupported platforms.
 * @param platform - a `process.platform` value; defaults to the real one.
 */
export function unsupportedReason(platform = process.platform) {
  return `dsh-autostart only supports Windows; the current platform is "${platform}".`
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/platform.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 写包骨架**

`package.json`(注意:`dsh.client.inject` 的包列表**照抄**已验证可用的同款插件 `dsh-setting-restart`,避免漏注入导致前端加载失败):

```json
{
  "name": "dsh-autostart",
  "version": "0.1.0",
  "description": "Windows-only DSH plugin: boot autostart and one-click restart for the DSH service.",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "client.js",
    "service.js",
    "lib/",
    "cordis.patch.yml",
    "README.md",
    "README.zh.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node --test",
    "check": "node --check index.js && node --check client.js && node --check service.js"
  },
  "keywords": [
    "dsh",
    "dsh-plugin",
    "deepseek-harness",
    "autostart",
    "restart",
    "windows"
  ],
  "engines": {
    "node": ">=20"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-settings-general"
      ]
    }
  },
  "license": "MIT"
}
```

`cordis.patch.yml`:

```yaml
# dsh-autostart bundle patch: one host row over the web profile.
- insert:
    - id: dsh-autostart
      name: dsh-autostart
```

`LICENSE`(MIT 正文,年份 2026,版权人 `Mandarin715`):

```
MIT License

Copyright (c) 2026 Mandarin715

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: 提交**

```bash
git add package.json cordis.patch.yml LICENSE lib/platform.js test/platform.test.js
git commit -m "feat: add package skeleton and platform gate"
```

---

## Task 2: 端口探测与条件轮询等待

**Files:**
- Create: `lib/port.js`, `test/port.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `isPortListening(port: number, options?: { host?: string, timeoutMs?: number }): Promise<boolean>`
  - `waitForPort(port: number, options?: { host?: string, timeoutMs?: number, intervalMs?: number }): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

`test/port.test.js`(用本进程真实监听一个端口做断言,不用 mock):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { isPortListening, waitForPort } from '../lib/port.js'

/** Start a throwaway TCP server on an OS-assigned port. */
function listenOnce() {
  return new Promise((resolve) => {
    const server = net.createServer(() => {})
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('returns true for a listening port', async () => {
  const server = await listenOnce()
  const port = server.address().port
  assert.equal(await isPortListening(port), true)
  await new Promise((r) => server.close(r))
})

test('returns false for a closed port', async () => {
  const server = await listenOnce()
  const port = server.address().port
  await new Promise((r) => server.close(r))
  assert.equal(await isPortListening(port), false)
})

test('waitForPort resolves true once the port opens', async () => {
  const server = await listenOnce()
  const port = server.address().port
  assert.equal(await waitForPort(port, { timeoutMs: 2000, intervalMs: 50 }), true)
  await new Promise((r) => server.close(r))
})

test('waitForPort resolves false on timeout', async () => {
  const server = await listenOnce()
  const port = server.address().port
  await new Promise((r) => server.close(r))
  assert.equal(await waitForPort(port, { timeoutMs: 400, intervalMs: 50 }), false)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/port.test.js`
Expected: FAIL —— `Cannot find module '../lib/port.js'`

- [ ] **Step 3: 写最小实现**

`lib/port.js`:

```js
// Port liveness via a real TCP connect.
//
// Deliberately NOT `netstat` text parsing and NOT a `:port` substring match:
// those also match TIME_WAIT sockets and client-side connections, which made a
// previous incarnation report "already running" while the service was down.
import net from 'node:net'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PROBE_TIMEOUT_MS = 700

/**
 * Whether something accepts TCP connections on the given port.
 * @returns true on a completed TCP handshake; false on refusal or timeout.
 */
export function isPortListening(port, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Poll until the port is listening or the deadline passes. Conditional polling
 * (no fixed sleep) so a fast start returns immediately.
 */
export async function waitForPort(port, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isPortListening(port, { host })) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/port.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/port.js test/port.test.js
git commit -m "feat: add TCP port probe with conditional polling"
```

---

## Task 3: DSH 启动命令探测与 argv 规范化

**Files:**
- Create: `lib/detect-command.js`, `test/detect-command.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `normalizeArgv(argv: string[], options?: { openBrowser?: boolean }): string[]`
  - `detectCommand(input: { execPath: string, argv: string[], cwd: string, openBrowser?: boolean }): { execPath: string, argv: string[], cwd: string }`

- [ ] **Step 1: 写失败测试**

`test/detect-command.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArgv, detectCommand } from '../lib/detect-command.js'

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
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/detect-command.test.js`
Expected: FAIL —— `Cannot find module '../lib/detect-command.js'`

- [ ] **Step 3: 写最小实现**

`lib/detect-command.js`:

```js
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
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/detect-command.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/detect-command.js test/detect-command.test.js
git commit -m "feat: detect the running DSH command and normalize argv"
```

---

## Task 4: 从日志解析最新访问地址

**Files:**
- Create: `lib/parse-url.js`, `test/parse-url.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `parseLatestAccessUrl(logText: string): string | null`

- [ ] **Step 1: 写失败测试**

`test/parse-url.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLatestAccessUrl } from '../lib/parse-url.js'

test('extracts the token URL', () => {
  const log = 'dsh web: http://127.0.0.1:3080/?token=abcDEF_123-xyz\n'
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=abcDEF_123-xyz')
})

test('returns the LAST url when the log holds several runs', () => {
  const log = [
    'dsh web: http://127.0.0.1:3080/?token=first',
    'starting up',
    'dsh web: http://127.0.0.1:3080/?token=second',
    '',
  ].join('\r\n')
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=second')
})

test('stops at the LAN suffix that follows the url', () => {
  const log = 'dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.5:3080/?token=def)\n'
  assert.equal(parseLatestAccessUrl(log), 'http://127.0.0.1:3080/?token=abc')
})

test('returns null when there is no match', () => {
  assert.equal(parseLatestAccessUrl('nothing here'), null)
  assert.equal(parseLatestAccessUrl(''), null)
  assert.equal(parseLatestAccessUrl(undefined), null)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/parse-url.test.js`
Expected: FAIL —— `Cannot find module '../lib/parse-url.js'`

- [ ] **Step 3: 写最小实现**

`lib/parse-url.js`:

```js
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
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/parse-url.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/parse-url.js test/parse-url.test.js
git commit -m "feat: parse the latest DSH access URL from captured stdout"
```

---

## Task 5: 渲染 bootstrap.vbs

**Files:**
- Create: `lib/render-vbs.js`, `test/render-vbs.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `renderBootstrapVbs(input: { execPath: string, serviceJsPath: string }): string`

- [ ] **Step 1: 写失败测试**

`test/render-vbs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBootstrapVbs } from '../lib/render-vbs.js'

test('quotes both paths and passes the start mode', () => {
  const vbs = renderBootstrapVbs({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    serviceJsPath: 'C:\\Users\\me\\.dsh\\profiles\\web\\node_modules\\dsh-autostart\\service.js',
  })
  assert.match(
    vbs,
    /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\me\\\.dsh\\profiles\\web\\node_modules\\dsh-autostart\\service\.js"" start", 0, False/,
  )
})

test('uses a hidden window and does not wait', () => {
  const vbs = renderBootstrapVbs({ execPath: 'a.exe', serviceJsPath: 'b.js' })
  assert.match(vbs, /, 0, False$/)
})

test('carries a do-not-edit banner', () => {
  const vbs = renderBootstrapVbs({ execPath: 'a.exe', serviceJsPath: 'b.js' })
  assert.match(vbs, /Generated by dsh-autostart/)
})

test('rejects missing input', () => {
  assert.throws(() => renderBootstrapVbs({ serviceJsPath: 'b.js' }), /execPath/)
  assert.throws(() => renderBootstrapVbs({ execPath: 'a.exe' }), /serviceJsPath/)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/render-vbs.test.js`
Expected: FAIL —— `Cannot find module '../lib/render-vbs.js'`

- [ ] **Step 3: 写最小实现**

`lib/render-vbs.js`:

```js
// Render the windowless boot entry point.
//
// wscript.exe creates no console window, which is the whole reason this file
// exists: `powershell -WindowStyle Hidden` on a long-running script still
// produced a visible empty console window.
const CRLF = '\r\n'

/** Quote one argument for a VBS string literal (embedded quotes are doubled). */
function quoteForVbs(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * @param input.execPath - absolute path of the node executable.
 * @param input.serviceJsPath - absolute path of this package's service.js.
 * @returns the full bootstrap.vbs content.
 */
export function renderBootstrapVbs(input) {
  const { execPath, serviceJsPath } = input ?? {}
  if (typeof execPath !== 'string' || execPath === '') {
    throw new Error('renderBootstrapVbs: execPath is required')
  }
  if (typeof serviceJsPath !== 'string' || serviceJsPath === '') {
    throw new Error('renderBootstrapVbs: serviceJsPath is required')
  }
  const command = `${quoteForVbs(execPath)} ${quoteForVbs(serviceJsPath)} start`
  return [
    "' Generated by dsh-autostart. Do not edit by hand.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run ${quoteForVbs(command)}, 0, False`,
  ].join(CRLF)
}
```

> 说明:`quoteForVbs(command)` 会把 command 里已有的引号再翻倍一次,因此最终文本形如 `"""path"" ""path"" start"`,即 VBS 字符串 `"path" "path" start`。

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/render-vbs.test.js`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/render-vbs.js test/render-vbs.test.js
git commit -m "feat: render the windowless bootstrap.vbs"
```

---

## Task 6: 配置契约(默认值 / 校验 / config.json 读写)

**Files:**
- Create: `lib/config.js`, `test/config.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `PLUGIN_DEFAULTS: { hookScript: string, dshPort: number, exitDelayMs: number, waitForExitMs: number, startTimeoutMs: number, openBrowserOnBoot: boolean, blockWhenAgentsRunning: boolean }`
  - `resolvePluginConfig(raw?: object): typeof PLUGIN_DEFAULTS`
  - `resolveDshHome(env?: object, homedir?: string): string`
  - `configDir(dshHome: string): string`
  - `configFilePath(dshHome: string): string`
  - `logPaths(dshHome: string): { out: string, err: string, service: string }`
  - `buildConfigFile(input: { command: object, pluginConfig: object, dshHome: string, now?: Date }): object`
  - `parseConfigFile(text: string): object`(缺失字段用默认值补齐)

- [ ] **Step 1: 写失败测试**

`test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_DEFAULTS,
  resolvePluginConfig,
  resolveDshHome,
  configDir,
  configFilePath,
  logPaths,
  buildConfigFile,
  parseConfigFile,
} from '../lib/config.js'

test('resolvePluginConfig fills every default', () => {
  assert.deepEqual(resolvePluginConfig(), PLUGIN_DEFAULTS)
  assert.deepEqual(resolvePluginConfig({}), PLUGIN_DEFAULTS)
})

test('resolvePluginConfig honors provided values', () => {
  const cfg = resolvePluginConfig({ dshPort: 8080, hookScript: 'C:\\hook.ps1', exitDelayMs: 100 })
  assert.equal(cfg.dshPort, 8080)
  assert.equal(cfg.hookScript, 'C:\\hook.ps1')
  assert.equal(cfg.exitDelayMs, 100)
  assert.equal(cfg.waitForExitMs, PLUGIN_DEFAULTS.waitForExitMs)
})

test('resolvePluginConfig rejects bad types and ranges', () => {
  assert.throws(() => resolvePluginConfig({ dshPort: 'nope' }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ dshPort: 0 }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ dshPort: 70000 }), /dshPort/)
  assert.throws(() => resolvePluginConfig({ waitForExitMs: -1 }), /waitForExitMs/)
  assert.throws(() => resolvePluginConfig({ hookScript: 42 }), /hookScript/)
  assert.throws(() => resolvePluginConfig({ openBrowserOnBoot: 'yes' }), /openBrowserOnBoot/)
})

test('resolveDshHome prefers DSH_HOME then the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\dsh' }, 'C:\\Users\\me'), 'D:\\dsh')
  assert.equal(resolveDshHome({}, 'C:\\Users\\me'), 'C:\\Users\\me\\.dsh')
})

test('path helpers hang off the dsh home', () => {
  const home = 'C:\\Users\\me\\.dsh'
  assert.equal(configDir(home), 'C:\\Users\\me\\.dsh\\dsh-autostart')
  assert.equal(configFilePath(home), 'C:\\Users\\me\\.dsh\\dsh-autostart\\config.json')
  assert.deepEqual(logPaths(home), {
    out: 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.log',
    err: 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.err.log',
    service: 'C:\\Users\\me\\.dsh\\dsh-autostart\\service.log',
  })
})

test('buildConfigFile assembles the persisted contract', () => {
  const file = buildConfigFile({
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    pluginConfig: resolvePluginConfig({ dshPort: 4000 }),
    dshHome: 'C:\\Users\\me\\.dsh',
    now: new Date('2026-09-10T00:00:00.000Z'),
  })
  assert.equal(file.schemaVersion, 1)
  assert.equal(file.createdAt, '2026-09-10T00:00:00.000Z')
  assert.equal(file.dshPort, 4000)
  assert.deepEqual(file.command.argv, ['bin.js', 'web', '--no-open'])
  assert.equal(file.logPaths.out, 'C:\\Users\\me\\.dsh\\dsh-autostart\\dsh-web-server.log')
})

test('parseConfigFile restores defaults for fields missing from an older file', () => {
  const old = JSON.stringify({
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web'], cwd: 'C:\\work' },
    dshPort: 3080,
  })
  const parsed = parseConfigFile(old)
  assert.equal(parsed.startTimeoutMs, PLUGIN_DEFAULTS.startTimeoutMs)
  assert.equal(parsed.hookScript, '')
  assert.equal(parsed.command.execPath, 'node.exe')
})

test('parseConfigFile rejects malformed input', () => {
  assert.throws(() => parseConfigFile('not json'), /config/)
  assert.throws(() => parseConfigFile('{}'), /command/)
})

test('parseConfigFile rejects a null or array command instead of passing it through', () => {
  // typeof null === 'object', so without an explicit check a hand-edited
  // config.json would hand service.js a null command and it would throw an
  // unhandled TypeError inside spawn() rather than the designed clean exit.
  assert.throws(() => parseConfigFile('{"command":null}'), /command/)
  assert.throws(() => parseConfigFile('{"command":[]}'), /command/)
})

test('parseConfigFile rejects a command missing its own fields', () => {
  assert.throws(() => parseConfigFile('{"command":{}}'), /command/)
  assert.throws(() => parseConfigFile('{"command":{"execPath":"n","argv":["b"],"cwd":""}}'), /command/)
  assert.throws(() => parseConfigFile('{"command":{"execPath":"n","argv":[],"cwd":"c"}}'), /command/)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL —— `Cannot find module '../lib/config.js'`

- [ ] **Step 3: 写最小实现**

`lib/config.js`:

```js
// The persisted contract between the plugin and service.js, plus plugin config
// defaults. Any field added later MUST keep a default so older config.json
// files keep working.
import os from 'node:os'
import path from 'node:path'

export const SCHEMA_VERSION = 1
export const CONFIG_DIR_NAME = 'dsh-autostart'

export const PLUGIN_DEFAULTS = {
  hookScript: '',
  dshPort: 3080,
  exitDelayMs: 800,
  waitForExitMs: 30000,
  startTimeoutMs: 30000,
  openBrowserOnBoot: false,
  blockWhenAgentsRunning: false,
}

function requirePort(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config: ${field} must be an integer between 1 and 65535`)
  }
  return value
}

function requireDuration(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`config: ${field} must be a non-negative integer`)
  }
  return value
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`config: ${field} must be a boolean`)
  return value
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new Error(`config: ${field} must be a string`)
  return value
}

/** Validate and fill the plugin's own config block. */
export function resolvePluginConfig(raw = {}) {
  const input = raw ?? {}
  const merged = { ...PLUGIN_DEFAULTS, ...input }
  return {
    hookScript: requireString(merged.hookScript, 'hookScript'),
    dshPort: requirePort(merged.dshPort, 'dshPort'),
    exitDelayMs: requireDuration(merged.exitDelayMs, 'exitDelayMs'),
    waitForExitMs: requireDuration(merged.waitForExitMs, 'waitForExitMs'),
    startTimeoutMs: requireDuration(merged.startTimeoutMs, 'startTimeoutMs'),
    openBrowserOnBoot: requireBoolean(merged.openBrowserOnBoot, 'openBrowserOnBoot'),
    blockWhenAgentsRunning: requireBoolean(merged.blockWhenAgentsRunning, 'blockWhenAgentsRunning'),
  }
}

/** `${DSH_HOME}` when set, otherwise `~/.dsh`. */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const configured = env?.DSH_HOME
  return typeof configured === 'string' && configured !== ''
    ? configured
    : path.join(homedir, '.dsh')
}

export function configDir(dshHome) {
  return path.join(dshHome, CONFIG_DIR_NAME)
}

export function configFilePath(dshHome) {
  return path.join(configDir(dshHome), 'config.json')
}

export function logPaths(dshHome) {
  const dir = configDir(dshHome)
  return {
    out: path.join(dir, 'dsh-web-server.log'),
    err: path.join(dir, 'dsh-web-server.err.log'),
    service: path.join(dir, 'service.log'),
  }
}

/** Assemble the full config.json payload written when autostart is enabled. */
export function buildConfigFile(input) {
  const { command, pluginConfig, dshHome, now = new Date() } = input
  if (command === undefined || command === null) throw new Error('config: command is required')
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    command,
    dshPort: pluginConfig.dshPort,
    hookScript: pluginConfig.hookScript,
    openBrowserOnBoot: pluginConfig.openBrowserOnBoot,
    waitForExitMs: pluginConfig.waitForExitMs,
    startTimeoutMs: pluginConfig.startTimeoutMs,
    logPaths: logPaths(dshHome),
  }
}

/** Parse a config.json, filling defaults so older files still load. */
export function parseConfigFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('config: config.json is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('config: config.json must be a JSON object')
  }
  // Mirror detectCommand's write-side validation: a command missing any of its
  // three fields would reach spawn() as undefined and throw an unhandled
  // TypeError instead of the designed clean exit.
  const command = parsed.command
  if (
    command === undefined ||
    command === null ||
    Array.isArray(command) ||
    typeof command !== 'object' ||
    typeof command.execPath !== 'string' ||
    command.execPath === '' ||
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    typeof command.cwd !== 'string' ||
    command.cwd === ''
  ) {
    throw new Error('config: config.json is missing the command field')
  }
  const plugin = resolvePluginConfig({
    hookScript: parsed.hookScript ?? PLUGIN_DEFAULTS.hookScript,
    dshPort: parsed.dshPort ?? PLUGIN_DEFAULTS.dshPort,
    exitDelayMs: parsed.exitDelayMs ?? PLUGIN_DEFAULTS.exitDelayMs,
    waitForExitMs: parsed.waitForExitMs ?? PLUGIN_DEFAULTS.waitForExitMs,
    startTimeoutMs: parsed.startTimeoutMs ?? PLUGIN_DEFAULTS.startTimeoutMs,
    openBrowserOnBoot: parsed.openBrowserOnBoot ?? PLUGIN_DEFAULTS.openBrowserOnBoot,
    blockWhenAgentsRunning:
      parsed.blockWhenAgentsRunning ?? PLUGIN_DEFAULTS.blockWhenAgentsRunning,
  })
  return {
    schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
    createdAt: parsed.createdAt ?? null,
    command: parsed.command,
    ...plugin,
    logPaths: parsed.logPaths ?? {},
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/config.test.js`
Expected: PASS(8 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/config.js test/config.test.js
git commit -m "feat: add config contract with defaults and validation"
```

---

## Task 7: 注册表读写(执行器可注入)

**Files:**
- Create: `lib/registry.js`, `test/registry.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `RUN_KEY`, `RUN_VALUE_NAME`
  - `registryCommand(vbsPath: string): string`
  - `isOurEntry(value: string | null, vbsPath: string): boolean`
  - `readRunValue(exec?: Function): string | null`
  - `writeRunValue(vbsPath: string, exec?: Function): void`
  - `removeRunValue(exec?: Function): void`

> `exec` 约定:`(args: string[]) => string`(stdout)。默认实现用 `reg.exe`。测试一律注入假执行器,**绝不触碰真实注册表**。

- [ ] **Step 1: 写失败测试**

`test/registry.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_KEY,
  RUN_VALUE_NAME,
  registryCommand,
  isOurEntry,
  readRunValue,
  writeRunValue,
  removeRunValue,
} from '../lib/registry.js'

test('registryCommand points wscript at the generated vbs', () => {
  assert.equal(
    registryCommand('C:\\Users\\me\\.dsh\\dsh-autostart\\bootstrap.vbs'),
    'wscript.exe "C:\\Users\\me\\.dsh\\dsh-autostart\\bootstrap.vbs"',
  )
})

test('isOurEntry only accepts our own vbs path', () => {
  const vbs = 'C:\\a\\bootstrap.vbs'
  assert.equal(isOurEntry(registryCommand(vbs), vbs), true)
  assert.equal(isOurEntry('wscript.exe "C:\\other\\bootstrap.vbs"', vbs), false)
  assert.equal(isOurEntry('"C:\\somewhere\\else.exe"', vbs), false)
  assert.equal(isOurEntry(null, vbs), false)
})

test('isOurEntry is case insensitive about the path', () => {
  const vbs = 'C:\\A\\Bootstrap.vbs'
  assert.equal(isOurEntry('wscript.exe "c:\\a\\bootstrap.VBS"', vbs), true)
})

test('readRunValue returns the value and tolerates a missing entry', () => {
  const present = () => 'HKEY_CURRENT_USER\\...\\Run\r\n    DSH autostart    REG_SZ    wscript.exe "C:\\a\\bootstrap.vbs"\r\n\r\n'
  const absent = () => {
    const error = new Error('reg exited 1')
    throw error
  }
  assert.equal(readRunValue(present), 'wscript.exe "C:\\a\\bootstrap.vbs"')
  assert.equal(readRunValue(absent), null)
})

test('writeRunValue issues reg add with the right key, name and data', () => {
  const calls = []
  writeRunValue('C:\\a\\bootstrap.vbs', (args) => {
    calls.push(args)
    return ''
  })
  assert.deepEqual(calls, [
    ['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', 'wscript.exe "C:\\a\\bootstrap.vbs"', '/f'],
  ])
})

test('removeRunValue issues reg delete', () => {
  const calls = []
  removeRunValue((args) => {
    calls.push(args)
    return ''
  })
  assert.deepEqual(calls, [['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f']])
})

test('removeRunValue tolerates a missing entry', () => {
  assert.doesNotThrow(() =>
    removeRunValue(() => {
      throw new Error('reg exited 1')
    }),
  )
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/registry.test.js`
Expected: FAIL —— `Cannot find module '../lib/registry.js'`

- [ ] **Step 3: 写最小实现**

`lib/registry.js`:

```js
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
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/registry.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add lib/registry.js test/registry.test.js
git commit -m "feat: add HKCU Run registry access with an injectable executor"
```

---

## Task 8: `service.js` — `start` 模式

**Files:**
- Create: `service.js`, `test/service-start.test.js`, `test/fixtures/config.json`

**Interfaces:**
- Consumes: `lib/config.js`(`parseConfigFile`)、`lib/port.js`(`isPortListening`, `waitForPort`)
- Produces:
  - `readConfig(configPath: string): object`
  - `spawnDsh(config: object, deps?: object): number` → 子进程 pid
  - `runHook(config: object, log: Function, deps?: object): Promise<{ ran: boolean, code?: number, missing?: boolean }>`
  - `runStart(input: { config, log, deps? }): Promise<{ started: boolean, pid?: number, up?: boolean }>`
  - `main(argv: string[], deps?: object): Promise<number>`

- [ ] **Step 1: 写失败测试**

`test/service-start.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runStart, runHook, main } from '../service.js'

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    dshPort: 3080,
    hookScript: '',
    startTimeoutMs: 1000,
    waitForExitMs: 1000,
    logPaths: { out: 'out.log', err: 'err.log', service: 'service.log' },
    ...overrides,
  }
}

test('runStart skips when the port is already listening', async () => {
  const lines = []
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => true,
      waitForPort: async () => true,
      spawnDsh: () => {
        throw new Error('must not spawn')
      },
      runHook: async () => ({ ran: false }),
    },
  })
  assert.deepEqual(result, { started: false })
  assert.match(lines.join('\n'), /already running/)
})

test('runStart spawns, waits for the port, then runs the hook', async () => {
  const order = []
  const result = await runStart({
    config: baseConfig(),
    log: () => {},
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => {
        order.push('waitForPort')
        return true
      },
      spawnDsh: () => {
        order.push('spawn')
        return 4242
      },
      runHook: async () => {
        order.push('hook')
        return { ran: true, code: 0 }
      },
    },
  })
  assert.deepEqual(order, ['spawn', 'waitForPort', 'hook'])
  assert.deepEqual(result, { started: true, pid: 4242, up: true })
})

test('runStart reports a failed port wait without throwing', async () => {
  const lines = []
  const result = await runStart({
    config: baseConfig(),
    log: (line) => lines.push(line),
    deps: {
      isPortListening: async () => false,
      waitForPort: async () => false,
      spawnDsh: () => 7,
      runHook: async () => ({ ran: false }),
    },
  })
  assert.equal(result.up, false)
  assert.match(lines.join('\n'), /did not come up/)
})

test('runHook is a no-op without a hookScript', async () => {
  const result = await runHook(baseConfig(), () => {}, {})
  assert.deepEqual(result, { ran: false })
})

test('runHook reports a missing script without throwing', async () => {
  const lines = []
  const result = await runHook(
    baseConfig({ hookScript: 'C:\\missing\\hook.ps1' }),
    (line) => lines.push(line),
    { exists: () => false },
  )
  assert.deepEqual(result, { ran: false, missing: true })
  assert.match(lines.join('\n'), /hook not found/)
})

test('runHook maps .ps1/.cmd/.bat to their interpreters', async () => {
  const seen = []
  const spawnHook = (cmd, args) => {
    seen.push([cmd, args])
    return { once(event, handler) { if (event === 'close') setImmediate(() => handler(0)) } }
  }
  await runHook(baseConfig({ hookScript: 'C:\\h\\a.ps1' }), () => {}, { exists: () => true, spawnHook })
  await runHook(baseConfig({ hookScript: 'C:\\h\\b.cmd' }), () => {}, { exists: () => true, spawnHook })
  await runHook(baseConfig({ hookScript: 'C:\\h\\c.exe' }), () => {}, { exists: () => true, spawnHook })
  assert.deepEqual(seen[0], ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\h\\a.ps1']])
  assert.deepEqual(seen[1], ['cmd.exe', ['/c', 'C:\\h\\b.cmd']])
  assert.deepEqual(seen[2], ['C:\\h\\c.exe', []])
})

test('main rejects an unknown mode', async () => {
  // 必须传 configPath:不传的话 main 会去读真实用户 home 的 config.json,
  // 既拿不到测试期望的返回码,还会在用户真实 ~/.dsh 下写一个 service.log。
  const code = await main(['node', 'service.js', 'bogus'], {
    configPath: 'test/fixtures/config.json',
  })
  assert.equal(code, 2)
})
```

`test/fixtures/config.json`(本任务创建;Task 9 复用它,不重复创建):

```json
{
  "schemaVersion": 1,
  "command": { "execPath": "node.exe", "argv": ["bin.js", "web", "--no-open"], "cwd": "." },
  "dshPort": 3080,
  "hookScript": "",
  "startTimeoutMs": 1000,
  "waitForExitMs": 1000,
  "logPaths": { "out": "out.log", "err": "err.log", "service": "test/fixtures/service.log" }
}
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL —— `Cannot find module '../service.js'`

- [ ] **Step 3: 写最小实现**

`service.js`:

```js
#!/usr/bin/env node
// dsh-autostart — detached helper.
//
// Modes:
//   start    used by bootstrap.vbs at login
//   restart  used by the plugin's restart button (waits for the old pid first)
//
// This file intentionally imports nothing from the DSH runtime: it reads
// config.json and drives the OS, so it can be run by hand for debugging:
//     node service.js start
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isPortListening, waitForPort } from './lib/port.js'
import { parseConfigFile, resolveDshHome, configFilePath } from './lib/config.js'

const SERVICE_JS = fileURLToPath(import.meta.url)

/** Load and validate config.json. */
export function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8')
  return parseConfigFile(text)
}

/** Launch DSH detached, with stdout/stderr appended to the log files. */
export function spawnDsh(config) {
  const out = fs.openSync(config.logPaths.out, 'a')
  const err = fs.openSync(config.logPaths.err, 'a')
  const child = spawn(config.command.execPath, config.command.argv, {
    cwd: config.command.cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  })
  child.unref()
  return child.pid
}

/** Pick the interpreter for a hook script by extension. */
function hookInvocation(script) {
  const ext = path.extname(script).toLowerCase()
  if (ext === '.ps1') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]]
  }
  if (ext === '.cmd' || ext === '.bat') return ['cmd.exe', ['/c', script]]
  return [script, []]
}

/**
 * Run the optional hook script. A hook failure NEVER blocks DSH startup.
 */
export function runHook(config, log, deps = {}) {
  const script = config.hookScript
  if (typeof script !== 'string' || script === '') return Promise.resolve({ ran: false })
  const exists = deps.exists ?? fs.existsSync
  if (!exists(script)) {
    log(`hook not found: ${script}`)
    return Promise.resolve({ ran: false, missing: true })
  }
  const spawnHook = deps.spawnHook ?? ((cmd, args) => spawn(cmd, args, { windowsHide: true, stdio: 'ignore' }))
  const [cmd, args] = hookInvocation(script)
  return new Promise((resolve) => {
    let child
    try {
      child = spawnHook(cmd, args)
    } catch (error) {
      log(`hook spawn error: ${error.message}`)
      resolve({ ran: true, failed: true })
      return
    }
    child.once('error', (error) => {
      log(`hook error: ${error.message}`)
      resolve({ ran: true, failed: true })
    })
    child.once('close', (code) => {
      log(`hook exited code=${code}`)
      resolve({ ran: true, code })
    })
  })
}

/**
 * Start DSH unless the port already answers. Conditional polling only.
 */
export async function runStart(input) {
  const { config, log } = input
  const deps = input.deps ?? {}
  const probe = deps.isPortListening ?? isPortListening
  const wait = deps.waitForPort ?? waitForPort
  const spawnImpl = deps.spawnDsh ?? spawnDsh
  const hook = deps.runHook ?? runHook

  if (await probe(config.dshPort)) {
    log(`port ${config.dshPort} already running; skip start`)
    return { started: false }
  }
  const pid = spawnImpl(config)
  log(`spawned dsh pid=${pid}`)
  const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
  log(up ? `port ${config.dshPort} is up` : `WARN port ${config.dshPort} did not come up in time`)
  await hook(config, log, deps)
  return { started: true, pid, up }
}

/** Log to service.log, creating the directory first. */
function makeLogger(config) {
  const target = config?.logPaths?.service
  if (typeof target !== 'string' || target === '') return () => {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  return (line) => {
    fs.appendFileSync(target, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  }
}

/**
 * CLI entry. Returns a process exit code.
 * @param argv - full `process.argv` shaped array.
 */
export async function main(argv, deps = {}) {
  const mode = argv[2]
  const configPath = deps.configPath ?? configFilePath(resolveDshHome())
  let config
  try {
    config = readConfig(configPath)
  } catch (error) {
    // At login there is no UI to report to: log and exit quietly.
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.appendFileSync(
        configPath.replace(/config\.json$/, 'service.log'),
        `[${new Date().toISOString()}] cannot read config: ${error.message}\n`,
        'utf8',
      )
    } catch {
      // nothing else we can do
    }
    return 1
  }
  const log = makeLogger(config)
  if (mode === 'start') {
    await runStart({ config, log, deps })
    return 0
  }
  return 2
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === path.resolve(SERVICE_JS)) {
  process.exitCode = await main(process.argv)
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/service-start.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add service.js test/service-start.test.js test/fixtures/config.json
git commit -m "feat: add service.js start mode with hook support"
```

---

## Task 9: `service.js` — `restart` 模式

**Files:**
- Modify: `service.js`
- Create: `test/service-restart.test.js`

**Interfaces:**
- Consumes: `runStart`(Task 8)
- Produces:
  - `waitForProcessExit(pid: number, options?: { timeoutMs?: number, intervalMs?: number, isAlive?: Function }): Promise<boolean>`
  - `runRestart(input: { config, oldPid, log, deps? }): Promise<{ restarted: boolean, started?: boolean, pid?: number, up?: boolean }>`
  - `main` 支持 `restart --pid <n>`

- [ ] **Step 1: 写失败测试**

`test/service-restart.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForProcessExit, runRestart, main } from '../service.js'

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    command: { execPath: 'node.exe', argv: ['bin.js', 'web', '--no-open'], cwd: 'C:\\work' },
    dshPort: 3080,
    hookScript: '',
    startTimeoutMs: 500,
    waitForExitMs: 500,
    logPaths: { out: 'out.log', err: 'err.log', service: 'service.log' },
    ...overrides,
  }
}

test('waitForProcessExit returns true as soon as the pid is gone', async () => {
  let calls = 0
  const alive = await waitForProcessExit(1, {
    timeoutMs: 1000,
    intervalMs: 10,
    isAlive: () => {
      calls += 1
      return calls < 3
    },
  })
  assert.equal(alive, true)
  assert.equal(calls, 3)
})

test('waitForProcessExit returns false on timeout', async () => {
  const gone = await waitForProcessExit(1, {
    timeoutMs: 60,
    intervalMs: 10,
    isAlive: () => true,
  })
  assert.equal(gone, false)
})

test('runRestart waits for exit, then starts and hooks', async () => {
  const order = []
  const result = await runRestart({
    config: baseConfig(),
    oldPid: 999,
    log: () => {},
    deps: {
      waitForProcessExit: async () => {
        order.push('waitExit')
        return true
      },
      isPortListening: async () => false,
      waitForPort: async () => {
        order.push('waitPort')
        return true
      },
      spawnDsh: () => {
        order.push('spawn')
        return 555
      },
      runHook: async () => {
        order.push('hook')
        return { ran: false }
      },
    },
  })
  assert.deepEqual(order, ['waitExit', 'spawn', 'waitPort', 'hook'])
  assert.deepEqual(result, { restarted: true, started: true, pid: 555, up: true })
})

test('runRestart aborts without spawning when the old process never exits', async () => {
  const lines = []
  const result = await runRestart({
    config: baseConfig(),
    oldPid: 999,
    log: (line) => lines.push(line),
    deps: {
      waitForProcessExit: async () => false,
      spawnDsh: () => {
        throw new Error('must not spawn a second instance')
      },
    },
  })
  assert.deepEqual(result, { restarted: false })
  assert.match(lines.join('\n'), /aborting restart/)
})

test('main rejects restart without a --pid', async () => {
  const code = await main(['node', 'service.js', 'restart'], {
    configPath: 'test/fixtures/config.json',
  })
  assert.equal(code, 2)
})
```

`test/fixtures/config.json` 已由 Task 8 创建,本任务直接复用(不要重复创建;若它不存在,说明 Task 8 未完成)。

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/service-restart.test.js`
Expected: FAIL —— `waitForProcessExit` / `runRestart` 未导出

- [ ] **Step 3: 写实现**

在 `service.js` 中,`runStart` 之后插入:

```js
/** Whether a pid is still alive on this OS (Windows-safe). */
export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Poll until the pid disappears. Never a fixed sleep: a fast exit returns fast.
 * @returns true when the process is gone, false when the deadline passed first.
 */
export async function waitForProcessExit(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 250
  const isAlive = options.isAlive ?? defaultIsAlive
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isAlive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Full restart: wait for the old process to exit, then start DSH again.
 * Aborting (rather than starting a second instance) is the safe failure mode.
 */
export async function runRestart(input) {
  const { config, oldPid, log } = input
  const deps = input.deps ?? {}
  const waitExit = deps.waitForProcessExit ?? waitForProcessExit
  const exited = await waitExit(oldPid, { timeoutMs: config.waitForExitMs })
  if (!exited) {
    log(`WARN old process ${oldPid} still alive after ${config.waitForExitMs}ms; aborting restart`)
    return { restarted: false }
  }
  log(`old process ${oldPid} exited; starting a new instance`)
  const started = await runStart({ config, log, deps })
  return { restarted: true, ...started }
}
```

把 `main` 里的模式分支替换为:

```js
  const log = makeLogger(config)
  if (mode === 'start') {
    await runStart({ config, log, deps })
    return 0
  }
  if (mode === 'restart') {
    const pidFlag = argv.indexOf('--pid')
    const oldPid = pidFlag === -1 ? Number.NaN : Number(argv[pidFlag + 1])
    if (!Number.isInteger(oldPid) || oldPid <= 0) {
      log('restart requires --pid <number>')
      return 2
    }
    await runRestart({ config, oldPid, log, deps })
    return 0
  }
  return 2
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/service-restart.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 跑全部测试确认无回归**

Run: `node --test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add service.js test/service-restart.test.js
git commit -m "feat: add service.js restart mode with pid wait"
```

---

## Task 10: host 侧 — 状态聚合、same-origin、启用/停用路由

**Files:**
- Create: `index.js`, `test/host-routes.test.js`

**Interfaces:**
- Consumes: `lib/platform.js`、`lib/port.js`、`lib/config.js`、`lib/registry.js`、`lib/detect-command.js`、`lib/render-vbs.js`、`lib/parse-url.js`
- Produces:
  - `buildState(input): Promise<object>`(见 Step 3 字段定义)
  - `sameOrigin(headers): boolean`
  - `createHandlers(deps): { state, enable, disable, restart }`
  - `apply(ctx, config)`(Cordis 行入口)
  - `inject = ['webServer']`

- [ ] **Step 1: 写失败测试**

`test/host-routes.test.js`:

```js
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

test('enable refuses on an unsupported platform', async () => {
  const handlers = createHandlers({
    platform: 'linux',
    config: {},
    dshHome: 'C:\\dsh',
    serviceJsPath: 'C:\\p\\service.js',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
  })
  const res = fakeRes()
  await handlers.enable(fakeReq(), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body, /Windows/)
})

test('enable refuses cross-origin POSTs', async () => {
  const handlers = createHandlers({ platform: 'win32' })
  const res = fakeRes()
  await handlers.enable(fakeReq({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), res)
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
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/host-routes.test.js`
Expected: FAIL —— `Cannot find module '../index.js'`

- [ ] **Step 3: 写实现**

`index.js`:

```js
// dsh-autostart — host face.
//
// Registers the settings card's HTTP endpoints. The browser face (client.js)
// talks to these with same-origin fetch; no Typert dependency is needed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSupportedPlatform, unsupportedReason } from './lib/platform.js'
import { isPortListening } from './lib/port.js'
import {
  PLUGIN_DEFAULTS,
  resolvePluginConfig,
  resolveDshHome,
  configDir,
  configFilePath,
  logPaths,
  buildConfigFile,
} from './lib/config.js'
import {
  RUN_VALUE_NAME,
  readRunValue,
  writeRunValue,
  removeRunValue,
  isOurEntry,
} from './lib/registry.js'
import { detectCommand } from './lib/detect-command.js'
import { parseLatestAccessUrl } from './lib/parse-url.js'

const SERVICE_JS = fileURLToPath(new URL('./service.js', import.meta.url))

/** Only same-origin writes are accepted: these endpoints can restart the host. */
export function sameOrigin(headers) {
  const host = headers?.host
  const origin = headers?.origin
  if (typeof host !== 'string' || typeof origin !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read the newest access URL out of the captured stdout, if any. */
function readAccessUrl(paths) {
  try {
    return parseLatestAccessUrl(fs.readFileSync(paths.out, 'utf8'))
  } catch {
    return null
  }
}

/** Aggregate everything the settings card shows, from live probes only. */
export async function buildState(deps) {
  const { platform = process.platform, dshHome, pluginConfig, registry } = deps
  const supported = isSupportedPlatform(platform)
  const paths = logPaths(dshHome)
  const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
  const hookScript = pluginConfig.hookScript
  const base = {
    supported,
    platform,
    dshPort: pluginConfig.dshPort,
    accessUrl: readAccessUrl(paths),
    hookScript,
    hookExists: hookScript === '' ? false : fs.existsSync(hookScript),
    configPath: configFilePath(dshHome),
    vbsPath,
    logPath: paths.service,
  }
  if (!supported) return { ...base, reason: unsupportedReason(platform) }
  const stored = registry.readRunValue()
  return {
    ...base,
    serviceRunning: await isPortListening(pluginConfig.dshPort),
    autostartEnabled: stored !== null,
    registryValue: stored,
    registryMatchesOurs: isOurEntry(stored, vbsPath),
  }
}

/** Build the four route handlers with injectable seams for tests. */
export function createHandlers(deps) {
  const platform = deps.platform ?? process.platform
  const dshHome = deps.dshHome ?? resolveDshHome()
  const pluginConfig = resolvePluginConfig(deps.config ?? {})
  const registry = deps.registry ?? { readRunValue, writeRunValue, removeRunValue }
  const fsImpl = deps.fs ?? fs
  const probe = deps.isPortListening ?? isPortListening
  const spawnHelper = deps.spawnHelper ?? defaultSpawnHelper

  const send = (res, code, payload) => {
    res.writeHead(code)
    res.end(JSON.stringify(payload))
  }
  const guard = (req, res) => {
    if (!isSupportedPlatform(platform)) {
      send(res, 400, { error: unsupportedReason(platform) })
      return false
    }
    if (!sameOrigin(req.headers)) {
      send(res, 403, { error: 'same-origin request required' })
      return false
    }
    return true
  }

  return {
    async state(_req, res) {
      const state = await buildState({
        platform,
        dshHome,
        pluginConfig,
        registry,
      })
      send(res, 200, state)
    },

    async enable(req, res) {
      if (!guard(req, res)) return
      try {
        const command = detectCommand({
          execPath: deps.execPath ?? process.execPath,
          argv: deps.argv ?? process.argv.slice(1),
          cwd: deps.cwd ?? process.cwd(),
          openBrowser: pluginConfig.openBrowserOnBoot,
        })
        const dir = configDir(dshHome)
        fsImpl.mkdirSync(dir, { recursive: true })
        const configFile = buildConfigFile({ command, pluginConfig, dshHome })
        fsImpl.writeFileSync(configFilePath(dshHome), JSON.stringify(configFile, null, 2), 'utf8')
        const vbsPath = path.join(dir, 'bootstrap.vbs')
        // wscript.exe reads a BOM-less file as ANSI, so a non-ASCII path (a Chinese user
        // profile, a non-ASCII DSH_HOME) would silently corrupt the login command.
        // UTF-16LE with a BOM is what WSH parses as Unicode.
        fsImpl.writeFileSync(
          vbsPath,
          `\uFEFF${renderBootstrap({ execPath: command.execPath, serviceJsPath: deps.serviceJsPath ?? SERVICE_JS })}`,
          'utf16le',
        )
        registry.writeRunValue(vbsPath)
        send(res, 200, { enabled: true, configPath: configFilePath(dshHome), vbsPath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 500, { error: `enable failed: ${message}` })
      }
    },

    async disable(req, res) {
      if (!guard(req, res)) return
      try {
        const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
        const stored = registry.readRunValue()
        if (stored !== null && !isOurEntry(stored, vbsPath)) {
          send(res, 200, { enabled: true, foreignEntry: true, registryValue: stored })
          return
        }
        registry.removeRunValue()
        send(res, 200, { enabled: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 500, { error: `disable failed: ${message}` })
      }
    },

    // Task 11 replaces this with the real restart implementation.
    async restart(req, res) {
      if (!guard(req, res)) return
      send(res, 501, { error: 'not implemented yet' })
    },
  }
}

/** Cordis row entry: mount the four routes on the web server. */
export const inject = ['webServer']

export function apply(ctx, config) {
  const handlers = createHandlers({ config })
  ctx.effect(() => {
    const dispose = [
      ctx.webServer.register({ kind: 'exact', path: '/dsh-autostart/state', handler: handlers.state }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-autostart/autostart/enable',
        handler: handlers.enable,
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-autostart/autostart/disable',
        handler: handlers.disable,
      }),
      ctx.webServer.register({ kind: 'exact', path: '/dsh-autostart/restart', handler: handlers.restart }),
    ]
    return () => {
      for (const fn of dispose) fn()
    }
  }, 'dsh-autostart: routes')
}
```

同时在 `index.js` 顶部 import 处补上 `renderBootstrap` 与 `defaultSpawnHelper` 的引用(在 Task 11 实现 `defaultSpawnHelper`;本任务先给一个占位实现并在 Task 11 替换):

```js
import { renderBootstrapVbs as renderBootstrap } from './lib/render-vbs.js'

/** Replaced in Task 11 with the real detached spawn. */
function defaultSpawnHelper() {
  throw new Error('restart is not implemented yet')
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/host-routes.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 语法检查**

Run: `node --check index.js`
Expected: 无输出(通过)

- [ ] **Step 6: 提交**

```bash
git add index.js test/host-routes.test.js
git commit -m "feat: add host state aggregation and autostart routes"
```

---

## Task 11: host 侧 — 重启路由(防重入 + Agent 守卫 + detached 助手)

**Files:**
- Modify: `index.js`(`restart` 处理器 + `defaultSpawnHelper`)
- Create: `test/host-restart.test.js`

**Interfaces:**
- Consumes: `createHandlers`(Task 10)
- Produces:
  - `countRunningAgents(agentsService: object | undefined): number`
  - `defaultSpawnHelper(configPath: string, oldPid: number): void`

- [ ] **Step 1: 写失败测试**

`test/host-restart.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandlers, countRunningAgents } from '../index.js'

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
const req = () => ({
  method: 'POST',
  headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
})

test('countRunningAgents counts only running agents', () => {
  const agents = { list: () => [{ status: 'running' }, { status: 'idle' }, { status: 'running' }] }
  assert.equal(countRunningAgents(agents), 2)
  assert.equal(countRunningAgents(undefined), 0)
  assert.equal(countRunningAgents({}), 0)
})

test('restart refuses while a restart is already scheduled', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    spawnHelper: () => {},
    scheduleExit: () => {},
  })
  const first = fakeRes()
  await handlers.restart(req(), first)
  assert.equal(first.statusCode, 202)
  const second = fakeRes()
  await handlers.restart(req(), second)
  assert.equal(second.statusCode, 409)
})

test('restart spawns the helper with the current pid', async () => {
  const calls = []
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    currentPid: 4321,
    spawnHelper: (deps) => calls.push(deps),
    scheduleExit: () => {},
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 202)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].oldPid, 4321)
})

test('restart returns 500 and schedules no exit when the helper fails to spawn', async () => {
  let exits = 0
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    spawnHelper: () => {
      throw new Error('spawn boom')
    },
    scheduleExit: () => {
      exits += 1
    },
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 500)
  assert.equal(exits, 0)
})

test('restart blocks when agents are running and the guard is on', async () => {
  const handlers = createHandlers({
    platform: 'win32',
    dshHome: 'C:\\dsh',
    config: { blockWhenAgentsRunning: true },
    execPath: 'node.exe',
    argv: ['bin.js', 'web'],
    cwd: 'C:\\work',
    agents: { list: () => [{ status: 'running' }] },
    spawnHelper: () => {},
  })
  const res = fakeRes()
  await handlers.restart(req(), res)
  assert.equal(res.statusCode, 409)
  assert.match(res.body, /agent/i)
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `node --test test/host-restart.test.js`
Expected: FAIL —— `countRunningAgents` 未导出 / `restart` 返回 501

- [ ] **Step 3: 写实现**

在 `index.js` 中用以下内容**替换** Task 10 留下的 `restart` 占位与 `defaultSpawnHelper` 占位:

```js
import { spawn } from 'node:child_process'

/** Count agents that are mid-turn; used only to inform or gate a restart. */
export function countRunningAgents(agentsService) {
  if (agentsService === undefined || agentsService === null) return 0
  let list
  try {
    list = agentsService.list?.()
  } catch {
    return 0
  }
  if (!Array.isArray(list)) return 0
  return list.filter((agent) => agent?.status === 'running').length
}

/**
 * Spawn the detached helper that waits for this process to exit and then
 * restarts DSH. Detached + unref so it outlives this process.
 */
export function defaultSpawnHelper(input) {
  const child = spawn(input.execPath, [input.serviceJsPath, 'restart', '--pid', String(input.oldPid)], {
    cwd: input.cwd,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
}
```

并在 `createHandlers` 的返回对象里把 `restart` 换成:

```js
    async restart(req, res) {
      if (!guard(req, res)) return
      if (restarting) {
        send(res, 409, { error: 'a restart is already scheduled' })
        return
      }
      const running = countRunningAgents(deps.agents)
      if (pluginConfig.blockWhenAgentsRunning && running > 0) {
        send(res, 409, { error: `refusing to restart: ${running} agent(s) are running` })
        return
      }
      try {
        spawnHelper({
          execPath: deps.execPath ?? process.execPath,
          serviceJsPath: deps.serviceJsPath ?? SERVICE_JS,
          cwd: deps.cwd ?? process.cwd(),
          oldPid: deps.currentPid ?? process.pid,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 500, { error: `could not start the restart helper: ${message}` })
        return
      }
      restarting = true
      send(res, 202, { accepted: true, runningAgents: running })
      const scheduleExit = deps.scheduleExit ?? ((fn, ms) => setTimeout(fn, ms))
      scheduleExit(() => process.exit(0), pluginConfig.exitDelayMs)
    },
```

并在 `createHandlers` 顶部(解构之后)加一行状态变量:

```js
  let restarting = false
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `node --test test/host-restart.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 跑全部测试 + 语法检查**

Run: `node --test && node --check index.js && node --check service.js`
Expected: 全部 PASS、语法通过

- [ ] **Step 6: 提交**

```bash
git add index.js test/host-restart.test.js
git commit -m "feat: add restart endpoint with re-entry guard and agent gate"
```

---

## Task 12: 浏览器侧 — 设置页卡片

**Files:**
- Create: `client.js`

**Interfaces:**
- Consumes: host 路由:`/dsh-autostart/state`、`/dsh-autostart/autostart/enable`、`/dsh-autostart/autostart/disable`、`/dsh-autostart/restart`
- Produces: 一个 `settings.general.item` 插槽注册项(id `dsh-autostart`)

> **重要**:`client.js` 必须是 `window.__ModuleLoader__.load({ id, factory })` 格式(DSH 的客户端模块加载器要求),**不使用 JSX 构建步骤**,直接用 `react.createElement`。`inject` 是**服务名**数组,不是包名。

- [ ] **Step 1: 写 `client.js`**

```js
// dsh-autostart — browser face.
//
// A settings card (General settings) with four controls. Talks to the host
// over same-origin fetch; no Typert manifest is required.
window.__ModuleLoader__.load({
  id: 'dsh-autostart',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const CSS = [
      '.dsas_card{border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--dsw-alias-label-primary)}',
      '.dsas_head{display:flex;align-items:center;gap:8px;font-weight:400;line-height:22px}',
      '.dsas_grid{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsas_row{display:flex;align-items:center;gap:8px}',
      '.dsas_url{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.dsas_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsas_btn{background:var(--dsw-alias-bg-module-platform);height:32px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:16px;padding:0 14px;font-family:inherit;font-size:13px;display:inline-flex;align-items:center}',
      '.dsas_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsas_btn:disabled{cursor:default;opacity:.5}',
      '.dsas_warn{color:var(--dsw-alias-state-warning-primary)}',
      '.dsas_error{color:var(--dsw-alias-state-error-primary)}',
      '.dsas_ok{color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    const CSS_TAG = 'dsh-autostart/card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-autostart'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const zh = {
      'card.title': 'DSH 服务与开机自启',
      'card.service': '服务',
      'card.running': '运行中(端口 {port})',
      'card.stopped': '已停止',
      'card.autostart': '开机自启',
      'card.on': '已启用',
      'card.off': '未启用',
      'card.foreign': '注册表里有一条同名但非本插件的自启项,未改动它',
      'card.url': '访问地址',
      'card.urlMissing': '尚未取到(服务还没启动过)',
      'card.hook': '钩子脚本',
      'card.hookMissing': '配置了但文件不存在',
      'card.hookNone': '未配置',
      'card.copy': '复制',
      'card.copied': '已复制',
      'card.enable': '启用自启',
      'card.disable': '停用自启',
      'card.restart': '重启服务',
      'card.restarting': '正在重启…',
      'card.confirm': '重启会中断正在进行的任务,未落盘的对话可能丢失。确定继续吗?',
      'card.unsupported': '仅支持 Windows',
      'card.loadFailed': '无法读取插件状态',
    }
    const en = {
      'card.title': 'DSH service & boot autostart',
      'card.service': 'Service',
      'card.running': 'Running (port {port})',
      'card.stopped': 'Stopped',
      'card.autostart': 'Boot autostart',
      'card.on': 'Enabled',
      'card.off': 'Disabled',
      'card.foreign': 'A same-named entry owned by something else is present; left untouched',
      'card.url': 'Access URL',
      'card.urlMissing': 'Not captured yet (the service has not started)',
      'card.hook': 'Hook script',
      'card.hookMissing': 'configured, but the file is missing',
      'card.hookNone': 'not configured',
      'card.copy': 'Copy',
      'card.copied': 'Copied',
      'card.enable': 'Enable autostart',
      'card.disable': 'Disable autostart',
      'card.restart': 'Restart service',
      'card.restarting': 'Restarting…',
      'card.confirm': 'Restarting interrupts running tasks; unsaved conversation may be lost. Continue?',
      'card.unsupported': 'Windows only',
      'card.loadFailed': 'Could not read plugin state',
    }

    const NS = 'dsh-autostart'

    /** Format a dictionary entry, substituting {name} placeholders. */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    }

    function Card(props) {
      const t = props.t
      const [state, setState] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [copied, setCopied] = react.useState(false)

      const load = react.useCallback(() => {
        fetch('/dsh-autostart/state')
          .then((res) => res.json())
          .then((payload) => {
            setState(payload)
            setError(null)
          })
          .catch(() => setError(t('card.loadFailed')))
      }, [t])

      react.useEffect(() => {
        load()
      }, [load])

      const post = react.useCallback(
        (url) => {
          setBusy(true)
          return fetch(url, { method: 'POST' })
            .then((res) => res.json().then((body) => ({ status: res.status, body })))
            .then(({ status, body }) => {
              setBusy(false)
              if (status >= 400) setError(body?.error ?? `HTTP ${status}`)
              else setError(null)
              load()
              return status < 400
            })
            .catch(() => {
              setBusy(false)
              setError(t('card.loadFailed'))
              return false
            })
        },
        [load, t],
      )

      if (state !== null && state.supported === false) {
        return h('div', { className: 'dsas_card' }, [
          h('div', { className: 'dsas_head', key: 'title' }, t('card.title')),
          h('div', { className: 'dsas_warn', key: 'reason' }, `${t('card.unsupported')} — ${state.reason ?? ''}`),
        ])
      }

      const url = state?.accessUrl ?? null
      const hookText =
        state === undefined || state === null
          ? ''
          : state.hookScript === ''
            ? t('card.hookNone')
            : state.hookExists
              ? state.hookScript
              : `${state.hookScript} — ${t('card.hookMissing')}`

      return h('div', { className: 'dsas_card' }, [
        h('div', { className: 'dsas_head', key: 'title' }, t('card.title')),
        h('div', { className: 'dsas_grid', key: 'status' }, [
          h('div', { className: 'dsas_row', key: 's' }, [
            h('span', { key: 'k' }, `${t('card.service')}: `),
            h(
              'span',
              { key: 'v', className: state?.serviceRunning ? 'dsas_ok' : 'dsas_error' },
              state?.serviceRunning ? format(t('card.running'), { port: state.dshPort }) : t('card.stopped'),
            ),
          ]),
          h('div', { className: 'dsas_row', key: 'a' }, [
            h('span', { key: 'k' }, `${t('card.autostart')}: `),
            h('span', { key: 'v' }, state?.autostartEnabled ? t('card.on') : t('card.off')),
          ]),
          state?.autostartEnabled && state?.registryMatchesOurs === false
            ? h('div', { className: 'dsas_warn', key: 'f' }, t('card.foreign'))
            : null,
          h('div', { className: 'dsas_row', key: 'u' }, [
            h('span', { key: 'k' }, `${t('card.url')}: `),
            url === null
              ? h('span', { key: 'v' }, t('card.urlMissing'))
              : h('span', { className: 'dsas_url', key: 'v' }, url),
            url === null
              ? null
              : h(
                  'button',
                  {
                    key: 'c',
                    type: 'button',
                    className: 'dsas_btn',
                    disabled: busy,
                    onClick: () => {
                      navigator.clipboard?.writeText(url).then(() => {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      })
                    },
                  },
                  copied ? t('card.copied') : t('card.copy'),
                ),
          ]),
          h('div', { className: 'dsas_row', key: 'h' }, [
            h('span', { key: 'k' }, `${t('card.hook')}: `),
            h(
              'span',
              { key: 'v', className: state !== null && state.hookScript !== '' && !state.hookExists ? 'dsas_warn' : '' },
              hookText,
            ),
          ]),
        ]),
        h('div', { className: 'dsas_actions', key: 'actions' }, [
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'dsas_btn',
              disabled: busy,
              onClick: () =>
                post(
                  state?.autostartEnabled
                    ? '/dsh-autostart/autostart/disable'
                    : '/dsh-autostart/autostart/enable',
                ),
            },
            state?.autostartEnabled ? t('card.disable') : t('card.enable'),
          ),
          h(
            'button',
            {
              key: 'restart',
              type: 'button',
              className: 'dsas_btn',
              disabled: busy,
              onClick: () => {
                if (typeof window !== 'undefined' && window.confirm(t('card.confirm')) === false) return
                post('/dsh-autostart/restart')
              },
            },
            busy ? t('card.restarting') : t('card.restart'),
          ),
          error === null ? null : h('span', { key: 'err', className: 'dsas_error' }, error),
        ]),
      ])
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'dsh-autostart: dictionaries',
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'dsh-autostart',
            order: Number.MAX_SAFE_INTEGER - 1,
            locale: NS,
          },
          Card,
        ),
      )
    }

    const exports = { apply, inject }
    return exports
  },
})
```

> `order: Number.MAX_SAFE_INTEGER - 1` 让本卡片位于 `dsh-setting-restart`(它用 `MAX_SAFE_INTEGER`)之上、其余设置行之下。

- [ ] **Step 2: 语法检查**

Run: `node --check client.js`
Expected: 无输出(通过)

- [ ] **Step 3: 提交**

```bash
git add client.js
git commit -m "feat: add settings card for autostart and restart"
```

---

## Task 13: 文档(中英双份 + 免责声明)

**Files:**
- Create: `README.md`, `README.zh.md`

**Interfaces:**
- Consumes: 无
- Produces: 面向用户的两份文档

- [ ] **Step 1: 写 `README.zh.md`**

必须包含以下**小节**(标题固定为这些,便于校验):

```markdown
# dsh-autostart

Windows 专用的 DeepSeek Harness 插件:在设置页一键启用「开机自动启动 DSH 服务」,并一键重启该服务。全程无控制台窗口。

## ⚠️ 免责声明(务必先读)

**安装前请自行检验环境。因使用本插件导致对话历史丢失、任务中断或数据损坏的,概不负责。**

重启会杀掉承载对话与 Agent 回合的 DSH 宿主进程:

- 有 Agent 在执行回合时重启 → 该回合被硬中断,结果可能不落盘
- 对话尚未写入 `~/.dsh/sessions/` → 该段历史可能丢失且不可恢复
- 并行会话中正在运行的任务也会被中断

使用前请:① 自行确认环境(Windows 版本、Node、DSH 版本、安全软件是否拦注册表);② 重启前确认没有重要任务在跑;③ 重要会话先备份 `~/.dsh/sessions/`;④ 自行评估是否启用开机自启(会写入 `HKCU\...\Run`)。

本软件按「原样」提供(MIT License,无任何担保)。

## 要求

- Windows 10 / 11
- Node.js ≥ 20(随 DSH 提供)
- DeepSeek Harness ≥ `0.1.0-rc.6`(实测于 `0.1.2-rc.1`)

## 安装

```sh
dsh plugin --profile web add github:Mandarin715/dsh-autostart
```

重启 DSH 后,进入「设置 → 通用设置」,拉到最下方即可看到本插件的卡片。

## 使用

| 控件 | 作用 |
|---|---|
| 服务状态 | 实时探测端口,显示运行中/已停止 |
| 开机自启开关 | 启用时会写 `~/.dsh/dsh-autostart/config.json`、生成 `bootstrap.vbs`,并写入注册表 `HKCU\...\Run` 的 `DSH autostart` 项 |
| 当前访问地址 | 从捕获的启动输出里解析出的最新带 token 地址,可一键复制 |
| 重启服务 | 二次确认后重启;DSH 会在数秒内恢复 |
| 钩子脚本 | 可选。服务起来后会执行它,用于拉起你自己的依赖进程 |

## 配置

在 profile 的 `cordis.patch.yml` 里:

```yaml
- id: dsh-autostart
  name: dsh-autostart
  config:
    hookScript: ''                 # 可选,服务起来后执行的脚本绝对路径
    dshPort: 3080
    exitDelayMs: 800
    waitForExitMs: 30000
    startTimeoutMs: 30000
    openBrowserOnBoot: false       # true = 开机时自动打开浏览器
    blockWhenAgentsRunning: false  # true = 有 Agent 在跑时拒绝重启
```

## 生成物位置

```
~/.dsh/dsh-autostart/
├── config.json               # 记录真实启动命令,service.js 读取
├── bootstrap.vbs             # 开机入口(wscript 无窗口)
├── dsh-web-server.log        # DSH stdout(含访问地址)
├── dsh-web-server.err.log
└── service.log               # 助手日志,排查问题先看这里
```

## 卸载

1. **先在设置页停用开机自启**(会删除注册表项)

   > 若插件被卸载而注册表项仍在,该项会指向一个已不存在的脚本。插件在 `dispose` 时会**仅在注册表项仍指向本插件的 `bootstrap.vbs` 时**清理它;其他情况不动。
2. 卸载插件:`dsh plugin --profile web remove dsh-autostart`
3. 如需彻底清理,手动删除 `~/.dsh/dsh-autostart/` 目录

## 为什么这样实现(踩坑记录)

- **为什么用 `wscript.exe` 而不是 `powershell -WindowStyle Hidden`**:后者对长时间运行的脚本不可靠,会留下一个无法关闭的空控制台窗口。
- **为什么等待用条件轮询而不是固定 `Start-Sleep`**:固定等待曾让一次重启耗时 80 秒以上;条件轮询把它压到数秒。
- **为什么端口判定用 TCP 连接而不是 `netstat`/`:port` 子串**:子串匹配会命中 `TIME_WAIT` 与客户端连接,导致"其实没启动却报告已在运行"。
- **为什么用 Node 而不是 PowerShell 实现逻辑**:PowerShell 脚本里的中文易出现编码问题,且受执行策略限制。
- **为什么必须写 `--no-open`**:DSH `0.1.2-rc.1` 每次启动生成新的 token,访问地址会打印在 stdout;插件把它捕获到日志并在设置页展示,因此开机时无需(也不应)弹出浏览器。
```

- [ ] **Step 2: 写 `README.md`(英文对照)**

内容与 `README.zh.md` 一一对应,标题为:`# dsh-autostart`、`## ⚠️ Disclaimer (read first)`、`## Requirements`、`## Install`、`## Usage`、`## Configuration`、`## Generated files`、`## Uninstall`、`## Why it is built this way`。免责声明正文必须与 spec §0 语义一致,至少包含:

```markdown
**Verify your environment before installing. The author is not liable for lost conversation history, interrupted tasks, or damaged data.**
```

并说明机制原因(重启会杀掉承载对话的宿主进程、未落盘的对话可能丢失)。

- [ ] **Step 3: 校验免责声明存在于两份文档**

Run:
```bash
node -e "for (const f of ['README.md','README.zh.md']) { const t = require('fs').readFileSync(f,'utf8'); if (!/免责声明|Disclaimer/.test(t)) throw new Error('missing disclaimer in '+f); if (!/对话历史|conversation history/i.test(t)) throw new Error('missing consequence in '+f) } console.log('ok')"
```
Expected: `ok`

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh.md
git commit -m "docs: add bilingual README with the required disclaimer"
```

---

## Task 14: 真机验收

**Files:**
- Create: `docs/ACCEPTANCE.md`(把验收结果记录在案)

**Interfaces:**
- Consumes: 全部前述任务
- Produces: 验收记录

> 本任务必须在**真实的 Windows 桌面会话**里手动执行(spec §8.3)。**执行前务必确认没有正在进行的重要 Agent 任务**——重启会中断它。

- [ ] **Step 1: 安装并确认卡片出现**

```bash
dsh plugin --profile web add <本仓库路径或 github:mandarin715/dsh-autostart>
```
重启 DSH,打开「设置 → 通用设置」,确认卡片在最下方。记录实际显示内容。

- [ ] **Step 2: 跑 M1/M2(自启开关)**

1. 点「启用自启」,确认注册表出现条目:
   ```bash
   reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DSH autostart"
   ```
   期望:值形如 `wscript.exe "C:\Users\<user>\.dsh\dsh-autostart\bootstrap.vbs"`
2. 确认 `~/.dsh/dsh-autostart/config.json` 与 `bootstrap.vbs` 已生成
3. 点「停用自启」,再次 query,期望:条目不存在

- [ ] **Step 3: 跑 M3(重启计时)**

启用自启后点「重启服务」并**计时**。期望:数秒内页面恢复;`service.log` 含 `old process ... exited`、`spawned dsh pid=`、`port 3080 is up`;设置页「访问地址」已更新为新 token。

- [ ] **Step 4: 跑 M4/M6(无窗口回归)**

1. 在资源管理器里双击 `~/.dsh/dsh-autostart/bootstrap.vbs`
2. 期望:**不出现任何控制台窗口**;`service.log` 记录 `already running; skip start`
3. 重启过程中观察桌面:期望**无控制台窗口闪烁或残留**

> 若出现窗口,用窗口枚举确认宿主进程,并回到 spec §2 表格核对是哪条经验失效。

- [ ] **Step 5: 跑 M5(钩子失败不阻断)**

配置 `hookScript` 指向一个不存在的路径,重启。期望:DSH 正常起来;`service.log` 记录 `hook not found`;设置页钩子一行显示黄字提示。

- [ ] **Step 6: 跑 M7(卸载清理)**

启用了自启的状态下卸载插件,再 query 注册表。期望:条目被清理。若手工删除 `node_modules` 后条目残留(未走卸载流程),记录该现象到 `ACCEPTANCE.md`。

- [ ] **Step 7: 记录结果并提交**

把 M1–M7 的实际结果(通过/失败、耗时、截图路径、日志片段)写入 `docs/ACCEPTANCE.md`,然后:

```bash
git add docs/ACCEPTANCE.md
git commit -m "docs: record Windows acceptance results"
```

---


## Task 15: 卸载清理(`dispose` 时安全移除自启项)

**Files:**
- Modify: `index.js`(`apply` 的 cleanup)
- Create: `test/host-dispose.test.js`

**Interfaces:**
- Consumes: `createHandlers` / `apply`(Task 10)、`lib/registry.js`
- Produces: `cleanupAutostart(deps): void`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupAutostart } from '../index.js'

const VBS = 'C:\\dsh\\dsh-autostart\\bootstrap.vbs'

test('cleanup removes our own entry', () => {
  const removed = []
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => `wscript.exe "${VBS}"`,
      removeRunValue: () => removed.push('removed'),
    },
  })
  assert.deepEqual(removed, ['removed'])
})

test('cleanup leaves a foreign entry alone', () => {
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: {
      readRunValue: () => '"C:\\other\\x.exe"',
      removeRunValue: () => {
        throw new Error('must not remove')
      },
    },
  })
})

test('cleanup is a no-op when no entry exists', () => {
  const removed = []
  cleanupAutostart({
    dshHome: 'C:\\dsh',
    registry: { readRunValue: () => null, removeRunValue: () => removed.push('x') },
  })
  assert.deepEqual(removed, [])
})
```

Run: `node --test test/host-dispose.test.js`
Expected: FAIL —— `cleanupAutostart` 未导出

- [ ] **Step 2: 写实现**

在 `index.js` 中新增:

```js
/**
 * Remove the autostart entry on plugin unload — but only if it is still ours,
 * so an unrelated entry can never be deleted by accident.
 */
export function cleanupAutostart(deps) {
  const dshHome = deps.dshHome ?? resolveDshHome()
  const registry = deps.registry ?? { readRunValue, removeRunValue }
  const vbsPath = path.join(configDir(dshHome), 'bootstrap.vbs')
  let stored
  try {
    stored = registry.readRunValue()
  } catch {
    return
  }
  if (stored === null || !isOurEntry(stored, vbsPath)) return
  try {
    registry.removeRunValue()
  } catch {
    // best effort on unload
  }
}
```

并把 `apply` 的 cleanup 返回值改为同时清理注册表:

```js
export function apply(ctx, config) {
  const handlers = createHandlers({ config })
  ctx.effect(() => {
    const dispose = [ /* ...四条路由注册同 Task 10... */ ]
    return () => {
      for (const fn of dispose) fn()
      cleanupAutostart({})
    }
  }, 'dsh-autostart: routes')
}
```

- [ ] **Step 3: 跑测试,确认通过**

Run: `node --test test/host-dispose.test.js`
Expected: PASS(3 tests)

- [ ] **Step 4: 跑全部测试**

Run: `node --test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add index.js test/host-dispose.test.js
git commit -m "feat: remove our autostart entry on plugin dispose"
```

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 覆盖任务 |
|---|---|
| §0 免责声明 | Task 13(README 双份)+ Task 12(重启确认文案 `card.confirm`)+ Task 12(卡片黄字警告位) |
| §1.2 S1–S6 | S1→T10/T12;S2→T5/T8/T14;S3→T9/T14;S4→T4/T10/T12;S5→T7/T10/T14;S6→T1/T10 |
| §2 经验表 | T2(轮询/端口判定)、T5(VBS)、T6(契约)、T9(条件轮询)、T8(detached)、T7(LISTENING 判定) |
| §3 架构(2 部件) | T8/T9(service.js)+ T10/T11(index.js)+ T12(client.js);无 watcher、无标记文件 |
| §4 文件布局 | 逐文件对应;`lib/*` 全部在 T1–T7 落地 |
| §4.3 config.json 契约 | T6(生成 + 解析 + 兜底) |
| §5.1 启用流 | T10(`enable` 处理器,含探测命令 / 写文件 / 写注册表)+ T14 M1 |
| §5.2 重启流 | T11(防重入 / Agent 守卫 / spawn / exit)+ T9(等待退出 → 启动 → 钩子) |
| §5.3 开机流 | T5(VBS)+ T8(`start` 模式,幂等 + 钩子)+ T14 M4 |
| §5.4 VBS 内容 | T5 |
| §6.1 UI | T12(状态 / 地址 / 开关 / 重启 / 钩子 / 非 Windows 分支)+ T10(`buildState` 提供全部字段) |
| §6.2 路由与 same-origin | T10(`sameOrigin` + 4 条路由注册) |
| §6.3 配置块 | T6(默认值)+ T10(`apply` 读取 config) |
| §7 错误处理(12 行) | 非 Windows→T10 guard;注册表失败→T10 try/catch;config 缺失(开机)→T8 `main`;config 缺失(重启)→T8;端口占用→T8;钩子缺失/失败→T8;重启重复点→T11;等退出超时→T9;端口超时→T8;spawn 助手失败→T11 |
| §8.1 单测 | T1–T11 各自测试任务 |
| §8.2 语法门 | T10 Step 5、T11 Step 5、T12 Step 2、`npm run check` |
| §8.3 M1–M7 | T14 |
| §10 交付/分发 | T1(package.json files/engines)、T13(README)、T14(验收) |
| §10.1 卸载清理 | T10(`disable` 只删自己的条目)。**缺口见下** |
| §11 R1–R7 | R1→T4(解析失败返回 null,UI 显示"尚未取到");R2→T3;R3→T7/T10;R4→T14 M4;R5→T8;R6→T11;R7→T2 |


**发现的缺口(已补)**:spec §10.1 要求「插件 `dispose` 时,仅当注册表项仍指向我们的 `bootstrap.vbs` 时删除它」。原计划在 Task 10 的 `apply` 里只注销了路由,**没有注册表清理** —— 已补为 **Task 15**(见上)。

**2. Placeholder scan**

已逐任务检查:无 TBD / TODO / 「add error handling」式空话;每个代码步骤都给出可粘贴的完整代码;`test/fixtures/config.json` 给出了完整内容。Task 10 中 `defaultSpawnHelper` 与 `restart` 是**显式标注的临时占位**,并在 Task 11 明确替换(spec 中"重启"是核心能力,不能留占位,因此 Task 11 是必须完成的,不是可选)。

**3. Type consistency**

| 名称 | 定义处 | 使用处 | 一致 |
|---|---|---|---|
| `PLUGIN_DEFAULTS` | T6 | T10/T11 | ✅ |
| `resolvePluginConfig` | T6 | T10 | ✅ |
| `parseConfigFile` | T6 | T8 | ✅ |
| `configFilePath` / `configDir` / `logPaths` / `resolveDshHome` | T6 | T8/T10/T15 | ✅ |
| `isPortListening` / `waitForPort` | T2 | T8/T10 | ✅ |
| `detectCommand` / `normalizeArgv` | T3 | T10 | ✅ |
| `parseLatestAccessUrl` | T4 | T10 | ✅ |
| `renderBootstrapVbs` | T5 | T10(以别名 `renderBootstrap` 引入) | ✅ |
| `readRunValue` / `writeRunValue` / `removeRunValue` / `isOurEntry` / `REGISTRY` 常量 | T7 | T10/T15 | ✅ |
| `runStart` / `runHook` / `runRestart` / `waitForProcessExit` / `readConfig` / `main` | T8/T9 | T9/T14 | ✅ |
| `sameOrigin` / `buildState` / `createHandlers` / `countRunningAgents` / `cleanupAutostart` / `apply` / `inject` | T10/T11/T15 | T12(HTTP 契约)/T15 | ✅ |
| 路由路径常量 | T10 注册、T12 fetch | 两者完全一致:`/dsh-autostart/state`、`/dsh-autostart/autostart/enable`、`/dsh-autostart/autostart/disable`、`/dsh-autostart/restart` | ✅ |
| `config.json` 字段 | T6 `buildConfigFile` | T8 `runStart`/`spawnDsh`/`runHook` | ✅(均通过 `config.*` 访问) |
