# 常驻看护进程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个常驻、拥有隐藏控制台的看护进程取代 WMI 助手来启动与重启 DSH,从而根治"每条命令弹一个 Windows Terminal 窗口"(F9)与"重启失败后 DSH 下线、无人接管"(F8/F5)。

**Architecture:** `bootstrap.vbs`(wscript,`Run(cmd, 0, False)`)拉起 `service.js supervise`,它因此天然拥有一个隐藏控制台并常驻;它用 `detached: false, windowsHide: false` 把 DSH 作为 attached 子进程启动,于是沙箱的工具子进程共享这个隐藏控制台、不再各建新窗口。看护进程持有子进程句柄,靠 `child.on('exit')` 判断宿主死活(不轮询),并用三个带 pid 的文件(`restart.request` / `supervise.stop` / `supervise.pid`)与外界通信。按需接管时用 `--takeover <pid>` 让新起的看护进程等那台 DSH 退出后再接手。

**Tech Stack:** Node.js ≥ 20(ESM,`node --test`,零运行时依赖)、PowerShell 5.1 与 WMI(仅用于把看护进程送出 DSH 的 Job)、Windows 控制台/Job Object 语义。

**Spec:** `docs/superpowers/specs/2026-09-12-resident-supervisor-design.md`

## Global Constraints

- **平台**:Windows 10 / 11 专属(本插件本就如此)。
- **零运行时依赖**:只用 Node 内置模块 + 系统工具;不得新增 npm 依赖。
- **测试**:`node --test`,当前 **131 条全绿**。每个任务的最后一步必须让全套保持全绿。
- **不许抢端口**:任何情况下都不得在端口已被占用时启动第二个 DSH;这是既有安全底线,重构不得削弱。
- **失败方向**:凡是"新实例能否起来"的路径,失败必须**留在可诊断、可恢复**的状态,不得静默变砖。
- **`config.json` 结构不变**;`schemaVersion` 仍为 `1`。
- **PowerShell 5.1 陷阱**(本项目已踩过):`.ps1` 含非 ASCII 必须带 BOM 或改纯 ASCII;`$var:` 在双引号字符串里要写 `${var}`;禁止用"会出现在自己命令行里的字面量"去匹配进程。
- **提交**:一律用 `git commit -F <文件>`,不要用 `-m`(PS 5.1 会传坏内嵌引号)。

---

## File Structure

| 文件 | 状态 | 职责 |
|---|---|---|
| `lib/supervise-state.js` | **新建** | 三个 pid 文件的读写与判定(单实例守卫、重启请求消费、stop 标记)。纯逻辑,不碰进程。 |
| `service.js` | 修改 | 新增 `runSupervise`;`spawnDsh` 改 attached;`main` 重构模式/参数;删除 `runRestart`/`scheduleSecondChance`/`--second-chance`/`--delay` |
| `lib/launch-helper.js` | 修改 | 只负责把看护进程经 WMI 送出 DSH 的 Job;命令改为 `supervise --config … --takeover <pid>` |
| `index.js` | 修改 | 重启路由:确认接管者活着 → 写 `restart.request` → 退出;停用/卸载:写 `supervise.stop` |
| `test/supervise-state.test.js` | **新建** | 文件契约的单元测试 |
| `test/service-start.test.js` | 修改 | `spawnDsh` 断言、`runSupervise` 的启动/重试/看护分支 |
| `test/host-restart.test.js` | 修改 | launch-helper 的 argv 断言 |
| `test/host-routes.test.js` | 修改 | 重启路由"接管者起不来则拒绝" |
| `README.md` / `README.zh.md` | 修改 | 恢复章节改写(看护进程语义、隐身进程说明) |
| `docs/ACCEPTANCE.md` | 修改 | F5/F8/F9 标注"由本设计根治" |

每个任务结束都是一个可独立验收的交付物;任务边界取"一个 reviewer 可能只否掉其中一个"的地方。

---

### Task 1: 真机验证核心前提(spec §10)

**为什么先做这个**:整个设计压在"宿主 attached 在长期存活的看护进程的隐藏控制台上 → 不弹窗且稳定"这个**未经证实**的前提上。本任务只回答它,不写产品代码。**不通过就停下重新设计。**

**Files:**
- Create: `C:\Users\asus\.dsh\scripts\spike-console-inherit.ps1`
- Create: `C:\Users\asus\.dsh\scripts\spike-console-inherit-spawn.js`
- Create: `C:\Users\asus\.dsh\logs\spike-console-inherit.md`(结论记录)

**Interfaces:**
- Consumes: 无
- Produces: 一个结论(前提成立 / 不成立)与一份实测记录;后续任务全部以它为前提

- [ ] **Step 1: 写"看护进程替身"(常驻 + attached 子进程)**

`C:\Users\asus\.dsh\scripts\spike-console-inherit-spawn.js`:

```js
// Stand-in for the supervisor: stay alive, and spawn an attached long-lived child.
// ASCII only is not required for .js (Node reads UTF-8), but keep it simple.
const { spawn } = require('node:child_process')

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: false,      // the proposed change: inherit this process's console
  windowsHide: false,   // and do NOT pass CREATE_NO_WINDOW
  stdio: ['ignore', 'ignore', 'ignore'],
})
process.stdout.write(`child=${child.pid} self=${process.pid}\n`)
setTimeout(() => process.exit(0), Number(process.argv[2] ?? 300000))
```

- [ ] **Step 2: 写启动器(经 wscript 拿到隐藏控制台,与登录入口同形)**

`C:\Users\asus\.dsh\scripts\spike-console-inherit.ps1`(**纯 ASCII**):

```powershell
# Mirrors the login entry shape: wscript -> powershell -> node (attached child).
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
$log = Join-Path $env:USERPROFILE '.dsh\logs\spike-console-inherit.log'
$node = (Get-Command node).Source
$js = Join-Path $PSScriptRoot 'spike-console-inherit-spawn.js'
"=== spike start $(Get-Date -Format o) ===" | Out-File -FilePath $log -Append -Encoding utf8
$out = (& $node $js 300000 2>&1 | Out-String).Trim()
"$out" | Out-File -FilePath $log -Append -Encoding utf8
```

- [ ] **Step 3: 用 wscript 拉起它(复刻 `bootstrap.vbs` 的隐藏窗口语义)**

```powershell
$vbs = "$env:TEMP\spike-launch.vbs"
Set-Content -Path $vbs -Value @"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\asus\.dsh\scripts\spike-console-inherit.ps1""", 0, False
"@ -Encoding ascii
Remove-Item "$env:USERPROFILE\.dsh\logs\spike-console-inherit.log" -Force -ErrorAction SilentlyContinue
& wscript.exe $vbs
Start-Sleep -Seconds 5
Get-Content "$env:USERPROFILE\.dsh\logs\spike-console-inherit.log" -Encoding UTF8
```

Expected: 日志出现 `child=<pid> self=<pid>`。

- [ ] **Step 4: 睡 3 秒后枚举可见控制台窗口(判据:必须为空)**

```powershell
Start-Sleep -Seconds 3
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
'@
$found = New-Object System.Collections.ArrayList
$cb = [W+EnumProc]{ param($h,$l)
  if ([W]::IsWindowVisible($h)) {
    $c = New-Object System.Text.StringBuilder 256; [void][W]::GetClassName($h,$c,256)
    if ($c.ToString() -match 'CASCADIA|ConsoleWindowClass') {
      $t = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText($h,$t,256)
      [void]$found.Add("class=$($c.ToString()) title='$($t.ToString())'")
    }
  }
  return $true }
[void][W]::EnumWindows($cb,[IntPtr]::Zero)
if ($found.Count -eq 0) { 'PASS: 没有可见控制台窗口' } else { $found | ForEach-Object { "FAIL: $_" } }
```

Expected: `PASS: 没有可见控制台窗口`。

- [ ] **Step 5: 观察 attached 子进程 5 分钟(判据:全程存活)**

```powershell
$log = Get-Content "$env:USERPROFILE\.dsh\logs\spike-console-inherit.log" -Encoding UTF8
$child = [int]([regex]::Match(($log -join "`n"), 'child=(\d+)').Groups[1].Value)
"watch child=$child"
1..10 | ForEach-Object {
  $p = Get-Process -Id $child -ErrorAction SilentlyContinue
  "$(Get-Date -Format HH:mm:ss)  $child = $(if ($p) { 'alive' } else { 'DEAD' })"
  Start-Sleep -Seconds 30
}
```

Expected: 10 行全是 `alive`(5 分钟)。若中途 `DEAD`,**前提不成立,停止本计划**。

- [ ] **Step 6: 记录结论并清理**

`C:\Users\asus\.dsh\logs\spike-console-inherit.md`:记下 ① 枚举结果 ② 5 分钟存活结果 ③ 父进程(`spike-console-inherit-spawn.js` 那个 node)是否一直活着 ④ 结论。

```powershell
Get-Process -Id $child -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "$env:TEMP\spike-launch.vbs" -Force -ErrorAction SilentlyContinue
```

- [ ] **Step 7: 决策门**

前提成立 → 继续 Task 2。**不成立 → 停止并回报,重新设计**(不要在此前提下继续写代码)。

---

### Task 2: 文件契约 `lib/supervise-state.js`

**Files:**
- Create: `lib/supervise-state.js`
- Test: `test/supervise-state.test.js`

**Interfaces:**
- Consumes: `defaultIsAlive(pid, kill?)`(已在 `service.js` 导出)
- Produces:
  - `readPid(file) -> number | null`
  - `writePid(file, pid) -> void`(尽力而为)
  - `clearFile(file) -> void`(尽力而为)
  - `anotherSupervisorAlive(file, isAlive) -> boolean`
  - `writeRestartRequest(file, pid) -> void`
  - `consumeRestartRequest(file, childPid) -> boolean`(**仅匹配时删除并返回 true**)
  - `isStopRequested(file, selfPid) -> boolean`(**仅匹配时删除**)

- [ ] **Step 1: 写失败的测试**

`test/supervise-state.test.js`:

```js
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
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/supervise-state.test.js`
Expected: FAIL —— `Cannot find module '../lib/supervise-state.js'`

- [ ] **Step 3: 实现**

`lib/supervise-state.js`:

```js
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
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test test/supervise-state.test.js`
Expected: PASS(5 tests)

- [ ] **Step 5: 全套保持全绿并提交**

```bash
node --test
git add lib/supervise-state.js test/supervise-state.test.js
git commit -F /tmp/msg.txt   # "feat: add the supervisor's pid-file contract"
```

---

### Task 3: `spawnDsh` 改为 attached

**Files:**
- Modify: `service.js`(`spawnDsh` 的 spawn 选项与上方注释)
- Modify: `test/service-start.test.js:348-350`(断言)

**Interfaces:**
- Consumes: Task 1 的结论(前提成立)
- Produces: `spawnDsh(config, log, deps)` 语义不变,仅子进程附着方式改变 —— 它现在**必须**由拥有控制台的进程调用

- [ ] **Step 1: 改断言(先红)**

`test/service-start.test.js` 里 `spawnDsh re-asserts the DSH_HOME captured at enable time` 的两行:

```js
    // Attached on purpose: DETACHED_PROCESS leaves the host with no console, and DSH's
    // sandboxed children cannot be given their own hidden console, so each of them would
    // create a new one and Windows 11 would hand it to Windows Terminal (one window per
    // command). Inheriting the supervisor's hidden console is what removes those windows.
    assert.equal(captured.options.detached, false)
    assert.equal(captured.options.windowsHide, false)
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL —— `false !== true`

- [ ] **Step 3: 改实现**

`service.js` 的 `spawnDsh`:

```js
  const child = spawnImpl(config.command.execPath, config.command.argv, {
    cwd: config.command.cwd,
    detached: false,
    windowsHide: false,
    stdio: ['ignore', out, err],
    env: dshEnv(config, deps.baseEnv ?? process.env),
  })
```

并把该函数上方的注释替换为:

```js
/**
 * Launch DSH attached to this process's console.
 *
 * Both flags are load-bearing and were measured, not guessed. `detached: true` is
 * DETACHED_PROCESS, which leaves the host with no console; `windowsHide: true` is
 * CREATE_NO_WINDOW, which does not set a console handle either. DSH's sandbox cannot give
 * its tool subprocesses their own hidden console under the restricted token
 * (dsh-sandbox-windows-acl: CREATE_NO_WINDOW children die with STATUS_DLL_INIT_FAILED), so
 * they must share the host's — and with no host console each of them created a fresh one
 * that Windows 11 handed to Windows Terminal: one visible window per command (F9).
 *
 * Clearing either flag makes the child die with its parent instead (measured: an attached
 * child of a WMI-created parent is gone within ~10s of that parent exiting), so this
 * function may only be called by a process that stays alive for DSH's whole lifetime —
 * the supervisor.
 */
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套)

- [ ] **Step 5: 提交**

```bash
git add service.js test/service-start.test.js
git commit -F /tmp/msg.txt   # "feat: launch DSH attached to the supervisor's console"
```

---

### Task 4: `runSupervise` 的启动阶段(含原地有界重试)

**Files:**
- Modify: `service.js`(新增 `runSupervise`,复用 `isPortListening`/`waitForPort`/`spawnDsh`/`runHook`)
- Test: `test/service-start.test.js`

**Interfaces:**
- Consumes: `spawnDsh`(Task 3)、`anotherSupervisorAlive`/`writePid`/`clearFile`(Task 2)
- Produces: `runSupervise({ config, configPath, log, deps, takeoverPid }) -> Promise<{ supervised: boolean, reason?: string, pid?: number }>` —— Task 5/6/7 都调用它

- [ ] **Step 1: 写失败的测试**

追加到 `test/service-start.test.js`(并把它加进文件顶部的 import):

```js
test('runSupervise starts DSH once and reports that it is supervising', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup-'))
  try {
    const spawned = []
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 1000 }),
      configPath: path.join(dir, 'config.json'),
      log: () => {},
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawned.push(1); return 4242 },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        // The loop ends when the child exits without a restart request.
        waitForChildExit: async () => 0,
        sleep: async () => {},
      },
    })
    assert.equal(spawned.length, 1)
    assert.deepEqual(result, { supervised: true, pid: 4242 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise retries a start that never came up, until the attempt limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup2-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => false,
        spawnDsh: () => { spawns += 1; return 5000 + spawns },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        superviseAttempts: 3,
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 60000) })(),
      },
    })
    assert.equal(spawns, 3, 'every attempt must be tried')
    assert.equal(result.supervised, false)
    assert.match(lines.join('\n'), /giving up|exit/i)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise stands down when another supervisor is already alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup3-'))
  try {
    const lines = []
    writePid(path.join(dir, 'supervise.pid'), 999)
    const result = await runSupervise({
      config: baseConfig(),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isProcessAlive: (pid) => pid === 999,
        spawnDsh: () => { throw new Error('must not spawn a second supervisor') },
      },
    })
    assert.deepEqual(result, { supervised: false, reason: 'already-running' })
    assert.match(lines.join('\n'), /already running/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

`test/service-start.test.js` 顶部 import 增加:`runSupervise`,以及 `import { writePid } from '../lib/supervise-state.js'`。

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL —— `runSupervise is not a function`

- [ ] **Step 3: 实现**

`service.js` 顶部常量区新增:

```js
// The supervisor retries a start that never came up. Backoff grows 1s, 1.5s, 2.25s … and
// the whole effort is bounded so a permanently broken command cannot retry forever.
const DEFAULT_SUPERVISE_ATTEMPTS = 5
const DEFAULT_SUPERVISE_BACKOFF_MS = 1000
const DEFAULT_SUPERVISE_BACKOFF_FACTOR = 1.5
const DEFAULT_SUPERVISE_TOTAL_MS = 5 * 60 * 1000
```

`service.js` 新增导出函数(Task 5 会补上"看护 + 重启请求"那一段,本任务只做启动):

```js
/**
 * Own DSH's lifetime: start it attached to this process's console and stay alive.
 *
 * Kept alive on purpose — see spawnDsh. Two startup shapes share this function:
 *   - plain `supervise`: start DSH if the port is free; if something else already serves
 *     it, stand down (nothing to supervise);
 *   - `supervise --takeover <pid>`: that `pid` is a DSH which is about to exit, so wait for
 *     it and then start ours. Without this shape an on-demand supervisor would see a busy
 *     port, stand down, and leave nobody to restart DSH when the old one exits.
 */
export async function runSupervise(input) {
  const { config, configPath, log } = input
  const deps = input.deps ?? {}
  const probe = deps.isPortListening ?? isPortListening
  const wait = deps.waitForPort ?? waitForPort
  const spawnImpl = deps.spawnDsh ?? spawnDsh
  const hook = deps.runHook ?? runHook
  const isAlive = deps.isProcessAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const dir = path.dirname(configPath)
  const pidFile = path.join(dir, 'supervise.pid')
  const requestFile = path.join(dir, 'restart.request')
  const stopFile = path.join(dir, 'supervise.stop')

  const guard = deps.anotherSupervisorAlive ?? anotherSupervisorAlive
  if (guard(pidFile, isAlive)) {
    log(`another supervisor is already running (${readPid(pidFile)}); standing down`)
    return { supervised: false, reason: 'already-running' }
  }
  const writePidImpl = deps.writePid ?? writePid
  writePidImpl(pidFile, process.pid)
  log(`supervisor pid=${process.pid} watching ${config.dshPort}`)

  if (input.takeoverPid) {
    log(`takeover: waiting for pid ${input.takeoverPid} to exit`)
    const waitExit = deps.waitForProcessExit ?? waitForProcessExit
    const gone = await waitExit(input.takeoverPid, { timeoutMs: deps.takeoverExitTimeoutMs ?? DEFAULT_TAKEOVER_EXIT_MS })
    if (!gone) {
      log(`takeover: pid ${input.takeoverPid} is still alive; standing down without starting`)
      ;(deps.clearFile ?? clearFile)(pidFile)
      return { supervised: false, reason: 'takeover-timeout' }
    }
  } else if (await probe(config.dshPort)) {
    log(`port ${config.dshPort} already answers and no takeover was requested; standing down`)
    ;(deps.clearFile ?? clearFile)(pidFile)
    return { supervised: false, reason: 'port-busy' }
  }

  const attempts = deps.superviseAttempts ?? DEFAULT_SUPERVISE_ATTEMPTS
  const startedAt = (deps.now ?? Date.now)()
  let delayMs = deps.superviseBackoffMs ?? DEFAULT_SUPERVISE_BACKOFF_MS
  let pid = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A previous child may still hold the port.
    if (attempt > 1 || input.takeoverPid) {
      const free = await waitForFreePort(probe, config.dshPort, log, deps)
      if (!free) {
        log(`port ${config.dshPort} still answers after the takeover window; standing down`)
        break
      }
    }
    pid = spawnImpl(config, log, deps)
    log(`spawned dsh pid=${pid}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`)
    const up = await wait(config.dshPort, { timeoutMs: config.startTimeoutMs })
    if (up) {
      log(`port ${config.dshPort} is up`)
      await hook(config, log, deps)
      return await superviseChild({ config, configPath, log, deps, pid, requestFile, stopFile, pidFile })
    }
    log(`WARN port ${config.dshPort} did not come up in time (attempt ${attempt}/${attempts})`)
    if (isAlive(pid)) {
      log(`previous pid ${pid} is still alive; not starting a second instance`)
      break
    }
    if ((deps.now ?? Date.now)() - startedAt + delayMs > (deps.superviseTotalMs ?? DEFAULT_SUPERVISE_TOTAL_MS)) {
      break
    }
    await sleep(delayMs)
    delayMs = Math.round(delayMs * (deps.superviseBackoffFactor ?? DEFAULT_SUPERVISE_BACKOFF_FACTOR))
  }
  log(`giving up: DSH did not come up after ${attempts} attempt(s); supervisor exiting`)
  ;(deps.clearFile ?? clearFile)(pidFile)
  return { supervised: false, reason: 'start-failed' }
}
```

同时新增小助手(本任务内联,Task 5 复用):

```js
/** Wait, briefly, for the port to stop answering before spawning a replacement. */
async function waitForFreePort(probe, port, log, deps = {}) {
  const windowMs = deps.takeoverPortWindowMs ?? DEFAULT_PORT_PROBE_WINDOW_MS
  const intervalMs = deps.portProbeIntervalMs ?? DEFAULT_PORT_PROBE_INTERVAL_MS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + windowMs
  for (;;) {
    if (!(await probe(port))) return true
    if (now() >= deadline) return false
    await sleep(intervalMs)
  }
}
```

并把 `DEFAULT_TAKEOVER_EXIT_MS = 30000` 加进常量区。本任务里 `superviseChild` 先写成最小形态(Task 5 补完):

```js
/** Placeholder replaced in Task 5. */
async function superviseChild(input) {
  const waitExit = input.deps.waitForChildExit
  if (typeof waitExit === 'function') await waitExit(input.pid)
  ;(input.deps.clearFile ?? clearFile)(input.pidFile)
  return { supervised: true, pid: input.pid }
}
```

顶部 import 增加:

```js
import { anotherSupervisorAlive, readPid, writePid, clearFile, consumeRestartRequest, isStopRequested, writeRestartRequest } from './lib/supervise-state.js'
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套)

- [ ] **Step 5: 提交**

```bash
git add service.js test/service-start.test.js
git commit -F /tmp/msg.txt   # "feat: add the supervisor start phase with bounded retries"
```

---

### Task 5: 看护阶段 —— 只有"请求过的重启"才重起

**Files:**
- Modify: `service.js`(`superviseChild` 由占位替换为真实实现)
- Test: `test/service-start.test.js`

**Interfaces:**
- Consumes: `consumeRestartRequest`/`isStopRequested`(Task 2)、Task 4 的 `runSupervise`
- Produces: `superviseChild({ config, configPath, log, deps, pid, requestFile, stopFile, pidFile }) -> Promise<{ supervised, pid? }>` —— 每次"被请求的重启"都在内部重新走一遍启动,直到子进程自然退出或收到 stop

- [ ] **Step 1: 写失败的测试**

```js
test('runSupervise restarts DSH only when the exit was requested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup4-'))
  try {
    const lines = []
    const exits = [111, 222]
    let spawns = 0
    // First child (pid 111) exits with a matching restart request; second (222) exits with
    // none, which must end the loop without another spawn.
    writeRestartRequest(path.join(dir, 'restart.request'), 111)
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return spawns === 1 ? 111 : 222 },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => { return pid },
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 2, 'the requested restart must respawn exactly once')
    assert.deepEqual(result, { supervised: true, pid: 222 })
    assert.match(lines.join('\n'), /restart requested/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise does not resurrect DSH when the exit was not requested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup5-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return 777 },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => pid,
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'a plain exit is not a reason to start another instance')
    assert.deepEqual(result, { supervised: true, pid: 777 })
    assert.match(lines.join('\n'), /exited without a restart request/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise exits when a stop marker names this supervisor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup6-'))
  try {
    const lines = []
    let spawns = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => false,
        waitForPort: async () => true,
        spawnDsh: () => { spawns += 1; return 555 },
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => {
          writePid(path.join(dir, 'supervise.stop'), process.pid)
          return pid
        },
        sleep: async () => {},
      },
    })
    assert.equal(spawns, 1, 'a stop must not spawn a replacement')
    assert.equal(result.supervised, false)
    assert.match(lines.join('\n'), /stop requested/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL —— 三条新测试都红(占位实现不消费标记)

- [ ] **Step 3: 实现**

把 Task 4 的占位 `superviseChild` 换成:

```js
/**
 * Supervise one running DSH and, when it exits, decide what happens next.
 *
 * The decision is deliberately narrow: only an exit that was *asked for* — a
 * `restart.request` naming this child — gets a replacement. A user closing DSH, or a crash,
 * ends the story; resurrecting those would be a watchdog, and a process the user cannot
 * stop is worse than a service that occasionally does not come back.
 */
async function superviseChild(input) {
  const { config, configPath, log, pid, requestFile, stopFile, pidFile } = input
  const deps = input.deps ?? {}
  const waitExit = deps.waitForChildExit ?? ((childPid) => new Promise((resolve) => {
    const tick = () => {
      if (!defaultIsAlive(childPid)) resolve(childPid)
      else setTimeout(tick, 500)
    }
    tick()
  }))
  const consumed = deps.consumeRestartRequest ?? consumeRestartRequest
  const stopped = deps.isStopRequested ?? isStopRequested
  const clear = deps.clearFile ?? clearFile

  let current = pid
  for (;;) {
    await waitExit(current)
    if (stopped(stopFile, process.pid)) {
      log('stop requested; supervisor exiting')
      clear(pidFile)
      return { supervised: false, reason: 'stopped' }
    }
    if (!consumed(requestFile, current)) {
      log(`dsh pid=${current} exited without a restart request; nothing to do`)
      clear(pidFile)
      return { supervised: true, pid: current }
    }
    log(`restart requested for pid=${current}; starting a replacement`)
    // Re-run the start phase for one attempt; runSupervise's own guard is skipped because
    // we already own the pid file.
    const next = await runSupervise({
      config,
      configPath,
      log,
      deps: { ...deps, anotherSupervisorAlive: () => false },
      takeoverPid: current,
    })
    if (!next.supervised || !next.pid) {
      log('replacement did not come up; supervisor exiting')
      clear(pidFile)
      return { supervised: false, reason: 'restart-failed' }
    }
    current = next.pid
  }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套)

- [ ] **Step 5: 提交**

```bash
git add service.js test/service-start.test.js
git commit -F /tmp/msg.txt   # "feat: respawn only on a requested restart, never as a watchdog"
```

---

### Task 6: 形态 B 的接管超时分支

**Files:**
- Modify: `service.js`(接管等待已存在,本任务补齐超时行为与测试)
- Test: `test/service-start.test.js`

**Interfaces:**
- Consumes: Task 4 的 `runSupervise`(`takeoverPid` 参数)
- Produces: 接管超时时 `{ supervised: false, reason: 'takeover-timeout' }` 且**不 spawn**

- [ ] **Step 1: 写失败的测试**

```js
test('runSupervise stands down without spawning when the takeover target never exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup7-'))
  try {
    const lines = []
    const result = await runSupervise({
      config: baseConfig(),
      configPath: path.join(dir, 'config.json'),
      takeoverPid: 4242,
      log: (line) => lines.push(line),
      deps: {
        isPortListening: async () => true,
        waitForProcessExit: async () => false,
        spawnDsh: () => { throw new Error('must not spawn while the target is alive') },
        sleep: async () => {},
      },
    })
    assert.deepEqual(result, { supervised: false, reason: 'takeover-timeout' })
    assert.match(lines.join('\n'), /still alive/)
    assert.equal(fs.existsSync(path.join(dir, 'supervise.pid')), false, 'it must not claim the pid file')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervise takes over once the target exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autostart-sup8-'))
  try {
    let probes = 0
    const result = await runSupervise({
      config: baseConfig({ startTimeoutMs: 10 }),
      configPath: path.join(dir, 'config.json'),
      takeoverPid: 4242,
      log: () => {},
      deps: {
        // Busy on the first probe, free afterwards: exactly the takeover shape.
        isPortListening: async () => { probes += 1; return probes === 1 },
        waitForProcessExit: async () => true,
        waitForPort: async () => true,
        spawnDsh: () => 9001,
        runHook: async () => ({ ran: false }),
        isProcessAlive: () => false,
        waitForChildExit: async (pid) => pid,
        sleep: async () => {},
      },
    })
    assert.deepEqual(result, { supervised: true, pid: 9001 })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL(第一条:pid 文件被提前写下了;第二条若已通过说明 Task 4 的重试分支够用 —— 那就把第一条修到绿即可)

- [ ] **Step 3: 实现**

把 `runSupervise` 里接管失败的收尾改成**先清掉自己刚写的 pid 文件再返回**(当前实现已经如此,确认它真的执行),并把接管等待包在 `try/finally` 里以防抛出后残留 pid 文件:

```js
  if (input.takeoverPid) {
    log(`takeover: waiting for pid ${input.takeoverPid} to exit`)
    const waitExit = deps.waitForProcessExit ?? waitForProcessExit
    const gone = await waitExit(input.takeoverPid, {
      timeoutMs: deps.takeoverExitTimeoutMs ?? DEFAULT_TAKEOVER_EXIT_MS,
    })
    if (!gone) {
      log(`takeover: pid ${input.takeoverPid} is still alive; standing down without starting`)
      ;(deps.clearFile ?? clearFile)(pidFile)
      return { supervised: false, reason: 'takeover-timeout' }
    }
  }
```

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套)

- [ ] **Step 5: 提交**

```bash
git add service.js test/service-start.test.js
git commit -F /tmp/msg.txt   # "test: cover the takeover timeout and success paths"
```

---

### Task 7: `main` 的模式与参数重构;删掉旧重启路径

**Files:**
- Modify: `service.js`(`main`、删除 `runRestart`/`scheduleSecondChance`/`DEFAULT_*_SECOND_CHANCE*`/`--second-chance`/`--delay`)
- Modify: `lib/launch-helper.js`(命令改为 `supervise … --takeover`)
- Modify: `test/service-restart.test.js`(删除 `runRestart` 相关;保留 `waitForProcessExit`/`defaultIsAlive`)
- Modify: `test/host-restart.test.js`(argv 断言)

**Interfaces:**
- Consumes: `runSupervise`(Task 4/5/6)
- Produces: CLI 契约 —— `service.js supervise --config <cfg> [--takeover <pid>]`;`service.js start` 作为 `supervise` 的别名;**不再有** `restart` 模式

- [ ] **Step 1: 写失败的测试**

```js
test('main treats start as an alias for supervise so existing installs keep working', async () => {
  // bootstrap.vbs is generated at enable time and snapshots `service.js start --config …`,
  // so an upgrade must not require the user to re-enable autostart.
  const calls = []
  await main(['node', 'service.js', 'start'], {
    configPath: 'test/fixtures/config.json',
    runSupervise: async (input) => { calls.push(input); return { supervised: true, pid: 1 } },
  })
  assert.equal(calls.length, 1)
})

test('main rejects the removed restart mode', async () => {
  const code = await main(['node', 'service.js', 'restart', '--pid', '5'], {
    configPath: 'test/fixtures/config.json',
  })
  assert.equal(code, 2, 'restart is gone; refusing loudly beats silently doing nothing')
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/service-start.test.js`
Expected: FAIL(`start` 目前走 `runStart`,`restart` 仍被接受)

- [ ] **Step 3: 实现**

`service.js` 的 `main`:模式分支变成

```js
  const runSuperviseImpl = deps.runSupervise ?? runSupervise
  try {
    // `start` is kept as an alias: bootstrap.vbs is written at enable time and says
    // `service.js start --config …`, so old installs must keep working without the user
    // re-enabling autostart.
    if (mode === 'start' || mode === 'supervise') {
      const takeoverFlag = argv.indexOf('--takeover')
      const takeoverRaw = takeoverFlag === -1 ? null : argv[takeoverFlag + 1]
      const takeoverPid = takeoverRaw === null ? null : Number(takeoverRaw)
      if (takeoverRaw !== null && (!Number.isInteger(takeoverPid) || takeoverPid <= 0)) return 2
      await runSuperviseImpl({ config, log, deps, configPath, takeoverPid })
      return 0
    }
    return 2
  } catch (error) {
    log(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
```

删除:`runRestart`、`scheduleSecondChance`、`DEFAULT_SECOND_CHANCE_DELAY_MS`、`MAX_DELAY_MS`、`--second-chance`/`--delay` 的解析块、`mode === 'restart'` 分支、`--pid` 解析。保留 `waitForProcessExit` 与 `defaultIsAlive`(形态 B 用)。

`lib/launch-helper.js`:把生成的 PowerShell 里的命令从 `restart --pid <n>` 改为 `supervise --config <cfg> --takeover <n>`(注释同步说明:现在只负责把看护进程送出 DSH 的 Job)。

`test/host-restart.test.js`:把 `assert.match(script, /restart --pid 99/)` 改为

```js
  assert.match(script, /supervise/)
  assert.match(script, /--takeover 99/)
```

`test/service-restart.test.js`:删掉 `runRestart waits for exit…` 与 `runRestart aborts…` 两条(功能已不存在),保留 `waitForProcessExit`/`defaultIsAlive`/`main rejects restart without a --pid` → 后者改为断言 `main(['node','service.js','restart','--pid','5'])` 返回 **2**。

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套;条数会因删除而减少,这是预期的)

- [ ] **Step 5: 提交**

```bash
git add service.js lib/launch-helper.js test/
git commit -F /tmp/msg.txt   # "refactor!: supervise replaces the WMI restart path"
```

---

### Task 8: 路由侧 —— 先确保接管者活着,再放手

**Files:**
- Modify: `index.js`(重启路由;`disable`/`cleanupAutostart` 写 stop 标记)
- Modify: `lib/config.js`(若需要,暴露 `supervisePidFile`/`restartRequestFile`/`superviseStopFile` 三个路径助手)
- Test: `test/host-routes.test.js`

**Interfaces:**
- Consumes: Task 2 的文件契约、`lib/launch-helper.js`(Task 7)
- Produces: 重启路由的新语义 —— 接管者起不来 → **500 且 DSH 不动**;成功 → `202` + `restart.request` 已写 + 退出

- [ ] **Step 1: 写失败的测试**

`test/host-routes.test.js` 追加(沿用该文件现有的 handler 构造方式):

```js
test('restart refuses and stays alive when no supervisor can be started', async () => {
  const calls = []
  const res = fakeRes()
  await handlers.restart(fakeReq(), res, {
    currentPid: 1234,
    supervisor: {
      isAlive: () => false,
      start: async () => { throw new Error('launcher exited 1') },
    },
    deps: { scheduleExit: (fn) => calls.push(fn) },
  })
  assert.equal(res.statusCode, 500)
  assert.match(res.body, /could not start the supervisor/)
  assert.deepEqual(calls, [], 'DSH must not be asked to exit when nothing will take over')
})

test('restart writes a request naming this process and then exits', async () => {
  const written = []
  const calls = []
  const res = fakeRes()
  await handlers.restart(fakeReq(), res, {
    currentPid: 4321,
    supervisor: { isAlive: () => true, start: async () => {} },
    deps: {
      writeRestartRequest: (file, pid) => written.push([file, pid]),
      scheduleExit: (fn) => calls.push(fn),
    },
  })
  assert.equal(res.statusCode, 202)
  assert.deepEqual(written.map(([, pid]) => pid), [4321])
  assert.equal(calls.length, 1, 'the host exits only after the request is on disk')
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `node --test test/host-routes.test.js`
Expected: FAIL —— 路由还没有 `supervisor` 依赖

- [ ] **Step 3: 实现**

`index.js` 的重启路由(保留既有的同源守卫、重入标志、`config.json` 前置检查):

```js
    async restart(req, res) {
      if (!guard(req, res)) return
      if (restarting) { send(res, 409, { error: 'a restart is already scheduled' }); return }
      if (!fsImpl.existsSync(configFilePath(dshHome))) {
        send(res, 400, { error: 'enable autostart first: config.json is missing' })
        return
      }
      const running = countRunningAgents(deps.agents)
      if (pluginConfig.blockWhenAgentsRunning && (running === null || running > 0)) {
        const detail = running === null ? 'the agent list is unreadable' : `${running} agent(s) are running`
        send(res, 409, { error: `refusing to restart: ${detail}` })
        return
      }
      restarting = true
      const selfPid = deps.currentPid ?? process.pid
      try {
        // The order is the whole point: make sure something will take over BEFORE this host
        // goes away. If the supervisor cannot be started, refuse and stay up — an exit with
        // nobody to restart us is exactly the failure this design exists to remove.
        const supervisor = deps.supervisor ?? defaultSupervisor(dshHome)
        if (!(await supervisor.isAlive())) {
          await supervisor.start(selfPid)
        }
        ;(deps.writeRestartRequest ?? writeRestartRequest)(restartRequestFile(dshHome), selfPid)
      } catch (error) {
        restarting = false
        send(res, 500, { error: `could not start the supervisor: ${messageOf(error)}` })
        return
      }
      send(res, 202, { accepted: true, runningAgents: running })
      const scheduleExit = deps.scheduleExit ?? ((fn, ms) => setTimeout(fn, ms))
      scheduleExit(() => process.exit(0), pluginConfig.exitDelayMs)
    },
```

`defaultSupervisor(dshHome)` 放在 `lib/supervise-launch.js`(新文件,~40 行):`isAlive()` 读 `supervise.pid` 并用 `process.kill(pid,0)` 校验;`start(selfPid)` 调 `defaultSpawnHelper`(既有的 WMI relay)拉起 `supervise --config <cfg> --takeover <selfPid>`,然后**轮询 `supervise.pid` 出现且存活**(上限 10s),超时抛错。

`disable`/`cleanupAutostart`:在删除注册表条目的同时,若 `supervise.pid` 里的进程活着,写 `supervise.stop`(**写入那个 pid**),不等待。

- [ ] **Step 4: 运行,确认通过**

Run: `node --test`
Expected: PASS(全套)

- [ ] **Step 5: 提交**

```bash
git add index.js lib/supervise-launch.js lib/config.js test/host-routes.test.js
git commit -F /tmp/msg.txt   # "feat: the restart route hands over to the supervisor before exiting"
```

---

### Task 9: 文档

**Files:**
- Modify: `README.md` / `README.zh.md`(恢复章节)
- Modify: `docs/ACCEPTANCE.md`(F5/F8/F9 标注)
- Modify: `docs/superpowers/specs/2026-09-10-dsh-autostart-design.md`(§5.2 由新 spec 取代的指针)

- [ ] **Step 1: 改写 README 的恢复章节**

两份都做:把"0) 先等 1~2 分钟"改成常驻进程的语义 ——

```markdown
### 0) 先等 1~2 分钟 —— 看护进程会自己重试

DSH 由常驻的看护进程启动(开机自启入口就是它)。新实例没起来时它会**原地重试**,
间隔递增、总时长有界(默认 5 分钟)。日志里能看到:

    spawned dsh pid=… (attempt 2/5)
    giving up: DSH did not come up after 5 attempt(s); supervisor exiting

只有这些都失败,才按下面手动补救。
```

并新增一节,说明两件用户会困惑的事:

```markdown
### 关于常驻进程(两条必须知道)

1. **它和 DSH 同生共死**:DSH 附着在它的隐藏控制台上,所以它退出时 DSH 会一起结束。
2. **停用自启不会立刻停掉它**:停用只是取消开机自启,当前这次开机里它和 DSH 继续跑,
   下次重启后不再出现。想立刻收工:跑 `service.js` 的 `stop` 路径(卸载会自动做)。
```

- [ ] **Step 2: 标注 ACCEPTANCE**

在 F5/F8/F9 三段各加一行:`> **由 `docs/superpowers/specs/2026-09-12-resident-supervisor-design.md` 根治。**`(F5 另加一句:兜底的语义是"再拉一次",不是回滚。)

- [ ] **Step 3: 给旧 spec 加指针**

`2026-09-10-dsh-autostart-design.md` 的 §5.2 开头加:

```markdown
> ⚠️ **本节已由 `2026-09-12-resident-supervisor-design.md` 取代。** 重启不再经 WMI 助手。
```

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh.md docs/
git commit -F /tmp/msg.txt   # "docs: describe the supervisor, its lifetime and the recovery path"
```

---

### Task 10: 真机验收(四条,缺一不可)

**Files:**
- Modify: `docs/ACCEPTANCE.md`(新增一节"2026-09-12 看护进程真机验收")

- [ ] **Step 1: 登录路径走一遍,枚举可见控制台窗口应为空**

按 Task 1 的 Step 3/4 手法,但用**真实的** `bootstrap.vbs`(即 `supervise`),然后跑一条会触发沙箱子进程的命令(例如任意 `pwsh` 命令)。Expected: 睡 3 秒后枚举,`CASCADIA_HOSTING_WINDOW_CLASS` **为空**。

- [ ] **Step 2: 点一次「重启服务」**

Expected: 页面数秒内恢复;**全程没有新窗口**;`service.log` 依次出现 `restart requested for pid=…`、`takeover: waiting for pid …`、`spawned dsh pid=…`、`port 3080 is up`。

- [ ] **Step 3: 停用自启后 DSH 仍在跑**

在设置页点「停用自启」。Expected: `DSH autostart` 条目消失,而 **DSH 与看护进程都还活着**;`state.autostartEnabled === false` 且 `serviceRunning === true`。

- [ ] **Step 4: 按需接管(最容易被忽略的一条)**

先手动 `npx @deepseek-ai/dsh web` 起一个 DSH(此时没有看护进程),再点重启。Expected: 看护进程被拉起并接管,页面恢复,此后**无弹窗**。

- [ ] **Step 5: 记录并提交**

把四条的实测证据(含窗口枚举输出、`service.log` 片段)写进 `ACCEPTANCE.md`,然后:

```bash
git add docs/ACCEPTANCE.md
git commit -F /tmp/msg.txt   # "docs: record the supervisor acceptance run"
```

---

## Self-Review

**Spec coverage**(逐节对照 spec):

| spec 节 | 落在哪个任务 |
|---|---|
| §4 架构(看护进程 + attached) | Task 3(spawn 选项)、Task 4(`runSupervise`) |
| §5 形态 A | Task 4 |
| §5 看护中(exit → 仅请求才重起) | Task 5 |
| §5 形态 B(`--takeover`) | Task 4(等待)+ Task 6(超时分支) |
| §5 文件契约 + pid 比对 | Task 2 |
| §5 单实例守卫 | Task 2 + Task 4 |
| §6 失败方向(先确保接管者活着) | Task 8 |
| §7 `start` 别名 / 删 `--second-chance` / 单实例 | Task 7 + Task 4 |
| §8 删掉什么 | Task 7 |
| §9 单元测试 1–14 | Task 4(1–4)、Task 5(8–10)、Task 6(5–7)、Task 2(11–12)、Task 4(13)、Task 8(14) |
| §9 真机四条 | Task 10 |
| §10 未验证前提 | **Task 1(决策门)** |

**Placeholder scan**:无 "TBD/TODO/待补";唯一的临时物是 Task 4 里显式标注"Task 5 会替换"的 `superviseChild` 占位,且 Task 5 Step 3 给出了完整替换代码。

**Type consistency**:`runSupervise` 的返回类型 `{ supervised, reason?, pid? }` 在 Task 4/5/6 与 Task 7 的 `main` 中一致;`consumeRestartRequest(file, childPid)` / `isStopRequested(file, selfPid)` / `anotherSupervisorAlive(file, isAlive)` 的签名在 Task 2 定义、Task 4/5 使用处一致;`runSupervise` 的 `takeoverPid` 参数在 Task 4/6/7 一致。
