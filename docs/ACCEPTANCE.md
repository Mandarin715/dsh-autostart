# 真机验收记录 (Task 14 / spec §8.3)

**日期**:2026-09-10
**环境**:Windows 桌面会话 · DSH `0.1.5-rc.1` · Node v24 · 插件以 `link:<repo path>` 安装(`feat/implementation`,HEAD `34ad1f2`)

## 执行方式说明(与计划书的差异)

计划书的 M1–M7 是"在设置页点击卡片"的手动步骤。本次由 agent 执行,而 agent **没有浏览器**,
因此写操作改为**直连 `127.0.0.1:3080` 调同一批路由**:

- `Host: 127.0.0.1:3080` + `Origin: http://127.0.0.1:3080`(满足 same-origin 守卫)
- 先用 `dsh-web-server.log` 里的 launch token 换取 Host 绑定的会话 cookie,再带 cookie 调用

这**等价于点击**(同一条路由、同一个守卫),但更强:参数确定、可重复。
**代价**:凡是需要"用眼睛看"的项(卡片是否出现、重启时有没有控制台窗口闪)agent 无法判定,
下表以 **未验证(需人工)** 明确标注,不冒充通过。

## 结果

| 项 | 结果 | 证据 |
|---|---|---|
| Step 1 卡片出现 | **未验证(需人工)** | 需在「设置 → 通用设置」底部肉眼确认 |
| —— 插件能否挂载 | **通过** | `GET /dsh-autostart/state` → **200**,字段齐全(`supported:true`,`serviceRunning:true`) |
| —— `agents` 服务 | **通过** | 重启返回 `{"accepted":true,"runningAgents":1}`,说明可选注入读到了真实服务 |
| M1 启用自启 | **通过** | 注册表新增 `DSH autostart = wscript.exe "...\.dsh\dsh-autostart\bootstrap.vbs"`;生成 `config.json`(含真实启动命令、`dshHome`、`logPaths`)与 `bootstrap.vbs`(**UTF-16LE BOM** = `255,254`,命令行含 `--config "<绝对路径>"`);`state.autostartEnabled:true`,`registryMatchesOurs:true` |
| —— 同源守卫(安全) | **通过** | 无 `Origin` 的 `POST enable` → **403** `{"error":"same-origin request required"}` |
| M2 停用自启 | **通过** | 返回 `{"enabled":false}`;注册表条目消失;**原有四条一字未动**;再启用可回到 `autostartEnabled:true` |
| M3 重启服务 | **通过** | `POST /dsh-autostart/restart` → **202**;助手 `service.log`:`old process 33608 exited` → `spawned dsh pid=20476` → **`port 3080 is up`**(宿主死后由助手写下 —— 这正是曾经不可能的一行);新 DSH 的父进程已消失(= 助手退出、DSH 存活);耗时约 **6.5s** |
| —— `accessUrl` 刷新 | **通过** | 重启后 `state.accessUrl` 从旧 token 变为 `http://127.0.0.1:3080/?token=XfnRWbASvVAOxGev2pTyhBC76E4W_np_I2RPSFbUpls`,与插件自己捕获的日志一致 |
| M4/M6 无控制台窗口 | **通过(修复后)** | 首测**失败**(见发现 F6);修复后连续两次真实重启,用户确认**均没有新窗口出现**;自动化枚举亦显示可见控制台窗口数只减不增 |
| M5 钩子失败不阻断 | **通过** | `hookScript` 指向不存在路径后重启,`service.log` 末行 `hook not found: C:\definitely\missing\hook.ps1`,而 DSH **正常起来**并在 3080 监听 |
| M7 卸载清理 | **通过(走 CLI,非 UI)** | 见下节「M7 实做记录」。UI 无卸载入口 —— 「设置 → 插件」只管理市场安装的插件,不提供手工 `link:` 依赖的卸载 |

### 额外验证(计划书之外的,但直接影响可用性)

| 项 | 结果 | 证据 |
|---|---|---|
| 自启条目能否活过一次插件重启 | **能** | 重启前后 `DSH autostart` 均存在,`autostartEnabled:true` 不变 |
| 改写 profile 配置会不会误删条目 | **不会** | 用无 BOM 方式重写 `cordis.patch.yml`(内容不变),12 秒内条目始终存在 |
| 与原自启项是否冲突 | **不冲突(注册表层)** | 插件值名 `DSH autostart`,与 `DSH Web`/`frpc`/`authproxy`/`restartwatcher` 互不覆盖;`isOurEntry` 只认自己的值 |

## 事件与发现(只有真机安装才会暴露)

### 事件 A —— 我自己造成的故障(已修复,非插件缺陷)

我用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写
`~/.dsh/profiles/web/cordis.patch.yml`,该写法会**在文件开头写入 UTF-8 BOM**。
`dsh-skin-market/lib/profile.js:289` 用 `yaml.parse()` 解析该文件时被 BOM 噎住,导致
`dsh: fatal load failure: YAMLParseError: Unexpected scalar at node end at line 1, column 4`,
DSH 无法启动。恢复方式:去掉 BOM 后重新启动。

**采用的两条纪律**:① 配置文件一律用**无 BOM** 写法(`UTF8Encoding($false)` / 写入工具);
② 重启前必须用**同一个 `yaml` 解析器**验证,而不是肉眼检查。

### 发现 F1 —— `hookScript` 是"启用时快照",改配置不生效(文档缺口)

`config.json` 由 `enable` 写入,其中 `hookScript` 取自**那一刻**的插件配置;而助手读的是
`config.json`。因此事后修改插件配置(如 `cordis.patch.yml` 里的 `hookScript`)**不会生效**,
必须重新点一次「启用自启」重新快照。本次 M5 第一次就是这么"没生效"的。
建议写进 README。

### 发现 F2 —— 插件与既有 auth-proxy 的 token 来源不一致(Important,集成)

插件让 DSH 把 stdout 写进**插件自己的** `~/.dsh/dsh-autostart/dsh-web-server.log`;
而本机 `frp/auth-proxy.js` 读的是 `~/.dsh/logs/dsh-web-server.log`。
插件驱动的重启之后,后者里是**旧 token**。本次手机访问仍然 401→200,只是因为 DSH 的会话
cookie 跨重启依然有效、auth-proxy 用的是缓存。**一旦需要重新换取 cookie(例如超过 6 小时、
或签名密钥变化),auth-proxy 会拿到已失效的 token,手机远程会断。**
建议:让 auth-proxy 同时考虑两个日志文件,取**最新**的 token。

### 发现 F3 —— `dispose → cleanupAutostart` 可能在拆解/失败时删掉用户的自启条目(Important,风险)

事件 A 之后观察到:`DSH autostart` 条目在未执行「停用」的情况下消失了。
已排除"普通插件重启"和"改 profile 配置"两种触发(均实测不会删)。
最可能的触发是**加载失败时插件树被拆解**,从而跑了 `ctx.effect` 的清理。
而 `` (README/ledger) 已记录 `dispose` **在插件重载时也会触发**。
后果:用户的自启可能在意料之外的时机静默消失。
建议:把"移除注册表条目"限定为显式的「停用/卸载」动作,不要绑在通用 dispose 上。

### 发现 F4 —— `reg.exe` 的 stderr 会漏进 DSH 的 stderr 日志(Minor)

条目不存在时 `readRunValue` 的 `reg query` 会失败,其 stderr 未被捕获,于是
`~/.dsh/logs/dsh-web-server.err.log` 里出现乱码行
`错误: 系统找不到指定的注册表项或值。`(每次 `state` 都可能写一条)。
建议:`defaultExec` 用 `stdio: ['ignore','pipe','pipe']` 捕获并丢弃 stderr。

### 发现 F5 —— 重启失败后没有回滚(2026-09-12 已缓解)

若新 DSH 因任何原因启动失败(事件 A 就是实例),看护进程会记录端口等待失败,**不会回滚**,
DSH 停在下线状态,原先只能靠外部手段(本机 `restart-dsh-web.ps1` 或官方命令)拉起。

关键约束:**卡片在 DSH 的页面里** —— 一旦 DSH 下线,任何界面提示都是无效的。所以兜底只能是
**自动动作**,不能是"通知用户"。

缓解(2026-09-12):

| 层 | 行为 |
|---|---|
| **助手内重试**(旧路径,已删) | 启动失败后最多重试 3 次(每次等 `startTimeoutMs`、间隔 3 秒)。**仅当上一个子进程确实已退出**才重试 —— 活着的子进程仍可能稍后绑上端口,此时另起一个就是两个 DSH 抢同一端口 |
| **看护进程原地重试**(现行) | 常驻看护进程(`service.js` 的 `runSupervise`)在启动阶段原地重试:间隔 1s 起、每次 ×1.5,上限 **5 次**且总时长不超过 **5 分钟**;同样只在失败的子进程确实已退出后才重试(`isAlive` 为假)。没有"安排一次延时尝试"这一层,看护进程本身就活过这次尝试 |
| **端口探测重试窗口**(F8 的修复) | `waitForFreePort`:在有界窗口内反复探测(`DEFAULT_PORT_PROBE_WINDOW_MS = 3000`,间隔 250ms),让垂死的 socket 有机会消失;持续应答者仍判为外来服务并收工。不再有"只在重启路径才安排兜底"的分支 —— 因为没有可安排的下一跳了 |

**仍然没有做的**:回滚到重启前的状态 —— 那本就不可能,旧进程已经退出。所以兜底的语义是
**再试一次把它拉起来**,不是撤销。两份 README 都已写明"失败后先等几分钟,看护进程会自己重试"
(重试预算上限 5 分钟)。

> **由 `docs/superpowers/specs/2026-09-12-resident-supervisor-design.md` 根治。** 兜底的语义是
> **"再拉一次",不是回滚** —— 旧进程已经退出,撤销无从谈起。
> 该设计的**真机验收(spec §9 那四条)尚在本文件中没有记录**;本行的"根治"指实现已落地,不等于已实测。

### 发现 F6 —— WMI 创建的助手会开出可见控制台窗口(M4/M6 实测失败,已修)

用户肉眼确认:重启时"cmd 窗口弹出来再消失",且事后仍有窗口留在前台。

根因(靠**枚举顶层窗口**实测得出;`Process.MainWindowHandle` 回答不了这个问题 ——
控制台窗口属于 `conhost`,不属于该进程):

| 创建方式 | 结果 |
|---|---|
| 不带 startup info(**原实现**) | 出现 `CASCADIA_HOSTING_WINDOW_CLASS \| visible=True` → **可见** |
| `ProcessStartupInformation.ShowWindow = 0` | 只有 `ConsoleWindowClass \| visible=False` → **隐藏** |

`Win32_Process.Create` 默认给控制台子系统程序一个**可见**控制台;而本机默认终端是
**Windows Terminal**,所以它不只是"闪一下":会新开一个可见窗口/标签页,并且
**终端窗口不随子进程退出而关闭**,于是残留在前台。这正是 spec 头号承诺
("全程无控制台窗口")被打破的地方。

修复:`buildLauncherArgv` 改为

```powershell
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$r = ([wmiclass]'Win32_Process').Create('<cmdline>', $null, $startup)
```

用 `[wmiclass]` 而不是 `Invoke-CimMethod`:后者无法绑定 `ProcessStartupInformation`(报"类型不匹配")。

**已验证**:用**真实启动器**创建一个长命进程(并确认它确实起来了、启动器 exit 0),
前后枚举可见控制台窗口**数量不变**。用户侧 `restart-dsh-web.ps1` 的 WMI 转交有同一问题,已同样修复。

遗留可见窗口:全部属于同一个 Windows Terminal 进程(pid 23444 —— 该次运行时的进程号,机器重启后会变),其**子进程为空**
(标签页里的进程都已退出),且当前 DSH 的祖先链上没有它 —— 关掉不影响 DSH。

### 发现 F7 —— 重启按钮的禁用理由与实际前置条件不一致(Minor,已修)

`client.js:178` 的禁用条件原本是 `state.autostartEnabled` 为假就禁用,但**路由的真实前置条件是
`config.json` 存在**。于是"自启已停用、但 `config.json` 仍在"时,按钮是灰的、提示却在说
"需要先由它生成 config.json" —— 而那个文件确实存在(本次验收收尾时正处于这个状态:卡片显示
`开机自启: 未启用` 并要求启用,但重启其实是可用的)。

**修复(`850f28f fix: gate the Restart button on config.json, not on the autostart entry`)**:禁用条件改为
`state.configExists === false`(`client.js:178-183`,并留了注释说明为什么不按 `autostartEnabled` 判),
与路由的真实前置条件一致。**待用户刷新页面做视觉确认**(见文末「结论」)。

### 发现 F8 —— 一键重启后 DSH 再没起来(重启竞态;已修)

2026-09-12 18:19:59 用户点「重启服务」后,**卡片没有任何报错**,页面左下角一直显示
「重新连接中」,DSH 再没起来(直到 18:22:39 用户手动 `npx @deepseek-ai/dsh web` 才恢复)。

`service.log` 里两行相隔 **4 毫秒**:

```
2026-09-12T10:19:59.598Z  old process 36640 exited; starting a new instance
2026-09-12T10:19:59.602Z  port 3080 already running; skip start
```

**根因:一次探测落在旧进程刚死的那几毫秒里。**

> ⚠️ **本节结论经过一次自我更正。** 最初写的是"端口上存在一个 `OwningProcess = 0`、
> 没有属主进程的 LISTEN socket"。**那个说法是错的**:探针脚本把"没有监听"强转成了 `0`
> (`Describe-Pid $null` → `[int]$null` → 查到 `Win32_Process` 的 pid 0,渲染成
> `System Idle Process`),于是我把自己工具的一个**空值显示**当成了"无属主的 socket"。
> 探针已修:现在明确输出 `NONE (no LISTEN socket on 3080)`。

**真正观测到的是时间线上的竞态:**

| 运行 | 旧进程退出 → 探测 | 结果 |
|---|---|---|
| 2026-09-12 18:19:59 | **+4ms** | 判为"端口被占" → `skip start` → **DSH 宕机** |
| 2026-09-12 18:31:03 | +10ms | 判为"空闲" → 正常启动 |
| 2026-09-12 18:52:55 | +9ms | 判为"空闲" → 正常启动 |

同一份代码,差几毫秒,两种结果。`waitForProcessExit` 是按 `process.kill(pid, 0)` 返回 ESRCH
判定"已退出"的,但内核未必已经释放那个监听 socket;探测恰好落进那一瞬,`connect` 会被一个
**再也不会 accept 的 socket** 完成 —— 而 `connect` 分不出它和"外来活服务"的区别。

**没能观测到的**:那一刻应答的究竟是旧进程自己的 socket,还是别的东西。150ms 采样只看到
"旧 DSH 持有"或"没人持有"两种状态,中间态没有抓到。所以这是一个**毫秒级竞态**的结论,
而不是"存在一个长期无属主的 socket"的结论。

修复:探测改为在有界窗口内重试(`DEFAULT_PORT_PROBE_WINDOW_MS = 3000`、间隔 250ms),让垂死的
socket 有机会消失;持续应答者仍会被判为外来服务并拒绝启动(安全底线不变)。

> **实现位置(常驻看护进程落地后仍然如此)**:这段重试就是 `service.js` 的 `waitForFreePort`,由
> `runSupervise` 在两处调用 —— 启动前的端口探测,以及重试循环里每次 `attempt > 1`(或带 `--takeover`)
> 之前的再探测。现行日志文案是 `port <port> is served by something else after waiting 3000ms;
> standing down`(探测前的那次)与 `port <port> still answers after waiting for it to drain;
> standing down`(重试循环里的那次)—— 前者下"外来服务"的结论,后者只说"它还在应答",不冒充结论。

**已验证**:① 新增两条单元测试(重试后启动 / 持续占用仍拒绝,**当时**全套 125/125 通过 —— 这是本节
最初写下时的数字,当天记录,不是当前套件规模);
② **真实 socket** 双向复核 —— 端口被占 1.6 秒后自行释放 → 重试到 1.6s 后成功启动;
端口持续占用 → 13 次探测 / 3.0 秒后拒绝启动。

> **未修(放大器)**:`index.js:549` 在**结果尚不可知**时就回 `202 {accepted:true}`,而看护进程最终放弃
> 启动时**没有任何面向用户的反馈** —— 于是这类失败仍然是"静默变砖":用户只看到转圈。建议把结局
> (已启动 / 已跳过 / 失败)写成卡片可读的状态。
> (看护进程把窗口收窄了:失败会在 5 分钟预算(再加上最后一次尝试自己的 `startTimeoutMs`)内以
> `giving up: DSH did not come up after N attempt(s); supervisor exiting` 结束,而不是无限期转圈;
> 但"给用户一条可见的结论"仍然没做。)

> **由 `docs/superpowers/specs/2026-09-12-resident-supervisor-design.md` 根治。** 重启不再经 WMI 助手:
> 由常驻看护进程按需接管,接管者起不来就当场拒绝重启、DSH 保持不动。
> (同上:指实现已落地;该设计的真机验收尚未在本文件中记录。)

### 发现 F9 —— 宿主没有控制台 ⇒ 每条命令弹一个 Windows Terminal 窗口(已定位;实现已落地,**真机未验证**)

现象(与 F6 同族,但层不同):用户报告"每次运行脚本都会弹窗"。**睡 3 秒后**枚举可见窗口
(不睡会在窗口变可见之前枚举,得到假的"干净"),抓到:

```
class=CASCADIA_HOSTING_WINDOW_CLASS  title='C:\Program Files\nodejs\node.exe'
```

链条(四步,均有据):

1. `spawnDsh` 用 `detached: true`,在 Windows 上即 `DETACHED_PROCESS` → **宿主没有控制台**;
2. `dsh-sandbox-windows-acl/README.zh.md:115`:**控制台隔离不可用** —— 受限令牌下
   `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 的子进程会在 DLL 初始化期间以
   `STATUS_DLL_INIT_FAILED`(`0xC0000142`)死亡,所以沙箱子进程**必须共享宿主控制台**;
3. 宿主没有可共享的控制台 → 每个 runner 各建一个新的(窗口标题正是 `node.exe`,不是 powershell);
4. `HKCU\Console\%%Startup` 的 `DelegationConsole` / `DelegationTerminal` **都为空**
   → Windows 11 把这个新控制台交给 Windows Terminal → 可见窗口。

**这是插件引入的回归**:用户原先的 `start-dsh-web.ps1` 用 `Start-Process -WindowStyle Hidden`
(**不** detach),DSH 于是继承 PowerShell 的隐藏控制台,子进程共享它,从无弹窗。

**"只去掉 `detached` 就行"这一行修法已实测否决。** 当时去掉 `detached` 让宿主继承控制台,但 A/B 对照
(`detached` 为唯一变量,父进程同为 WMI 创建、起完即退、`windowsHide` 保持常量)结果:

| 模式 | 子进程 | 观察 |
|---|---|---|
| `detached: true`(当时的现行值) | 496 | **存活**(>2.5 分钟) |
| `detached: false`(当时的拟改值) | 21196 | **10 秒内被杀**(父进程为 WMI 创建的一次性助手,起完就退出) |

原因:**控制台随它的创建者进程销毁,挂在上面的进程被连坐杀掉** —— 这是当时的读数(子进程与父进程在
同一采样点消失,见 Task 1 的 1.37s 闭式测量),不是对机制的独立确证。凶手不是 job ——
`DETACHED_PROCESS` 并不逃出 job,而只有 attached 的那个死了。所以在**没有一个活得久的控制台宿主**时,
`detached: true` 是必须的:清掉它会把子进程的命挂在一个短命父进程上,等于把"重启"变回"关机"。

**实际的修法(常驻看护进程,spec §4;截至本记录仍是代码层,真机未验证)**:让**看护进程本身**成为那个
活得久的控制台宿主 —— 它由 `bootstrap.vbs`(wscript,隐藏控制台)或 WMI 中继启动并常驻,DSH 用
`detached: false, windowsHide: false` **attached** 在它的隐藏控制台上起动。于是:

- 控制台**不再随创建者销毁**(创建者就是看护进程,它活到 DSH 结束);
- 沙箱 runner 共享那个隐藏控制台,没有谁需要新建控制台 → **零弹窗**(F9 的判据)。

> ⚠️ **这一条我按 spec §9 的要求如实标注:改动已实现,但"睡 3 秒后枚举可见窗口应为空"的真机验证
> 尚未执行**(本任务明确不做任何运行时验证,也不重启 DSH)。所以上面的结论是**设计推理 + 单元测试**,
> 不是实测结论;不要把标题读成"已验证修复"。

`spawnDsh` 的 JSDoc 里已经把两个 flag 的后果分开写明:`detached` 决定子进程的**生死**(attached ⇒ 随
看护进程一起结束),`windowsHide` 决定**窗口可见性**(见 F9 的成因链第 3–4 步)。A/B 只变过 `detached`,
`windowsHide` 没有被单独验证过,所以不要把它读成"两个 flag 都实测过"。

> **由 `docs/superpowers/specs/2026-09-12-resident-supervisor-design.md` 根治。** 常驻看护进程提供
> 长期存活的隐藏控制台,宿主 attached 于其上,于是"控制台随创建者销毁"这个前提不再成立
> (`detached` 仍然没有打开,但已不再是那个"必须开"的两难)。
> (同上:指实现已落地;该设计的真机验收尚未在本文件中记录。)

### M7 实做记录(CLI 卸载 + 手工清理)

**界面里没有卸载入口**:用户确认「设置 → 插件」中找不到卸载按钮 —— 该页只管理从市场安装的插件,
对 `dsh plugin --profile web add <本地路径>`(等价于 profile 里的一条 `link:` 依赖)不提供卸载。
因此 M7 走 CLI。

执行顺序(**先停用自启,再卸载**),每一步的结果:

| 步骤 | 结果 |
|---|---|
| 点「停用自启」 | `{"enabled":false}`;注册表 `DSH autostart` 消失;用户原有四条不动 |
| `dsh plugin --profile web remove dsh-autostart` | `dependencies` 中移除 ✅;`dsh.profile.bundles` 中**也**移除 ✅(关键:bundle 若残留,DSH 下次启动会因找不到模块而**启动失败**) |
| 残留检查 | `node_modules\dsh-autostart` **仍作为符号链接存在**(→ 仓库,`service.js` 仍可达);用 `cmd /c rmdir` 只删链接(**不用 `Remove-Item -Recurse`:PowerShell 5.1 对重解析点有递归进目标删除的历史问题,而这个链接指向用户的仓库**)。删除前后仓库均为 85 个文件、`git clean`,`index.js`/`service.js` 完好 |
| 生成数据 | `~/.dsh/dsh-autostart/`(config.json / bootstrap.vbs / 三个日志)需**手工删除**,卸载不会清 |

**由此确认的 F3 边界(本次未踩到,因为先停用了)**:`pnpm remove` **保留**了符号链接,
所以 `service.js` 依然可达 —— 若**只卸载、不停用**,按 F3 的判据(`service.js` 是否存在)
`cleanupAutostart` 会**保留**那条注册表条目,留下一条死条目(开机跑一次、静默失败)。
**结论:卸载前必须先「停用自启」**,或用 CLI/注册表编辑器手工删掉条目。
建议后续把这条写进 README 的卸载一节。

## 验收后的处理(2026-09-10 当晚)

| 发现 | 处理 | 证据 |
|---|---|---|
| F2 token 来源不一致 | **已修**(在用户的 `frp/auth-proxy.js`,不在本插件) | 改为按修改时间**从新到旧**尝试两个日志;重启一个**全新无缓存**的 auth-proxy 后,本机与手机均 **401 → 200**(而最新日志是插件那份,旧逻辑会读到 20:22 的旧 token) |
| F3 dispose 误删条目 | **已修**(`247728d`) | `cleanupAutostart` 只在**自己的 `service.js` 不存在**时才删(即真卸载的证据);真机注册表上验证:插件在 → **保留**,service.js 缺失 → **删除**,外来值 → **不动**。套件 118 → 121 |
| M7 卸载清理 | **已在真实注册表上验证** | 同上三条分支;未从 UI 卸载(agent 无浏览器),但 `dispose → cleanupAutostart` 已在真机触发并被观测 |
| F4 `reg.exe` stderr 噪音 | **已修** | `defaultExec` 改为 `stdio: ['ignore','pipe','ignore']`。它不只是日志噪音 —— **实测会直接出现在用户的 DSH 控制台里**(每次状态轮询一行;用户截图里那两句 `错误: 系统找不到指定的注册表项或值。` 就是它)。真实验证:调用真实 `readRunValue` 时 stderr 为空 |
| F6 可见控制台窗口(M4/M6) | **已修**(`bf85b09`) | 见发现 F6;修复后用真实启动器复测,可见控制台窗口数量不变,实际重启时 3 → 2 且无新增 |
| F7 重启按钮禁用理由不符 | **已修**(`850f28f`) | 禁用条件改为 `state.configExists === false`(`client.js:178-183`),与路由的真实前置条件一致;**待用户刷新页面视觉确认** |

**关于 F3 在 `link:` 安装下的行为(有意为之)**:`link:` 安装卸载后仓库仍在,`service.js` 依然存在,
条目会被**保留** —— 而那条自启此时**仍然可用**,保留是合理的;真正会留下死条目的是
**拷贝式安装**(`node_modules` 被删除),那种情况恰好会被清理。

## 结论

- 插件的 **挂载层** 与 **四条写路由** 在真机 `0.1.5-rc.1` 上**全部工作**,包括它存在的理由
  (助手在宿主退出后仍然存活并拉起新实例、`accessUrl` 随新 token 刷新)。
- 验收中发现的 **F2/F3/F4/F6 四项已修复并验证**;F7 已修(`850f28f`,禁用条件改用 `configExists`)、待用户刷新页面视觉确认;无其他待定项。
- **三个"需人工"项的状态**:
  1. **卡片是否出现、内容是否正确 → 已通过**(用户截图确认:标题、服务状态、访问地址、复制按钮、
     免责声明行都在,且访问地址是当前有效 token);
  2. **重启时无控制台窗口 → 首测失败,修复(F6)后连续两次真实重启,用户确认均无新窗口 → 通过**;
  3. **从 UI 卸载插件(M7 的 UI 路径)→ 仍未做**;注册表层面的清理已用真实注册表验证过。
- 另外记录一次**执行者造成的故障**:agent 曾从 DSH 工具调用里重启 `auth-proxy`,
  该进程因此在 DSH 的 kill-on-close Job 内、随重启被杀,导致手机远程 502;
  改用 WMI 在 Job 外启动后恢复(本机与手机 401→200)。运维铁律见
  `~/.dsh/logs/2026-09-10-restart-rootcause.md`。
- 因此结论更新为:**除"从 UI 卸载"一项外,真机验收已完成**;机制与四条路由均已通过。
- 当前机器状态:插件已安装并加载(自启条目**按用户要求保持停用**,注册表只剩用户原有四条,
  避免开机竞态);手机远程正常。

## 2026-09-12 常驻看护进程:真机验收(四条判据)

**背景**:F5/F8/F9 的根因(重启竞态、宿主无控制台)由
`docs/superpowers/specs/2026-09-12-resident-supervisor-design.md` 的**常驻看护进程**设计根治。
本节记录该设计在真机上的验收。合并后 `main` = `5da4fb0`(18 个提交,本地快进、未推送)。

**读法说明**:本节里的**进程号、窗口计数、启动时间**都是 **2026-09-12 当晚那一次运行**的实测值。机器重启后进程号必然不同,窗口计数也会随当时桌面上开着什么而变化 —— 请把它们当作那一次的现场记录,而不是可复现的常量。

**验收方法**:两条启动形态各跑一遍,并在每条之后用 `EnumWindows` + `IsWindowVisible` + `GetClassName`
枚举可见顶层窗口(命令执行前 / 执行一条 `cmd /c echo` 子进程并等 4 秒后各一次),看**新增窗口数**与
**控制台类窗口数**。判据 1/2 时桌面上没有用户自己的终端,故控制台类窗口绝对数应为 0;判据 4 时用户
按步骤开了一个终端,故绝对数不为 0,此时以**新增数 = 0** 为准。

### 判据 1 —— 登录路径 + 无可见控制台窗口:**通过**

- 登录路径(`service.log`,UTC;本地 = +8):
  ```
  [2026-09-12T14:26:13.295Z] supervisor pid=23440 watching 3080
  [2026-09-12T14:26:13.304Z] spawned dsh pid=29520
  [2026-09-12T14:26:34.403Z] port 3080 is up
  ```
  ⇒ 看护进程启动 → 9 毫秒后 attached 启动 DSH → **21.1 秒**端口就绪;在 `startTimeoutMs = 30000` 之内,
  故**无 `WARN`、无重试、无 `giving up`**。
- **血缘**:DSH(29520)的父进程 = 看护进程(23440);而看护进程的父进程已经退出(wscript 用
  `sh.Run(cmd, 0, False)` 不等候)⇒ 看护进程**不在 DSH 的 Job 内**,与设计一致。
- **窗口**:可见顶层窗口命令前 **18** 个 → 等 4 秒后 **18** 个,**新增 0**;控制台类窗口 **0** 个。
  ⇒ 用户在 F9 里抱怨的"每条命令弹一个 Windows Terminal 窗口"**在真机上消失**。

### 判据 2 —— 点一次「重启服务」:**通过**(且覆盖"停用自启之后再点重启"这一曾被缺陷破坏的场景)

- 点击时间本地 22:31:48(此前的判据 3 已执行,即 `supervise.stop` 处于待处理状态)。
- 新 DSH **12604**(22:31:48);**看护进程仍是 23440、启动时间仍是 22:26:13** ⇒ 看护进程常驻、只更换 DSH;
  新 DSH 的父进程 = 23440。
- `restart.request` **已被消费(文件消失)**;`supervise.stop` **仍在**(23440)⇒ 按设计跨重启保留。
- `service.log` 序列:
  ```
  [2026-09-12T14:31:48.389Z] restart requested for pid=29520; starting a replacement
  [2026-09-12T14:31:48.389Z] supervisor pid=23440 watching 3080
  [2026-09-12T14:31:48.389Z] takeover: pid 29520 must be gone before we start
  [2026-09-12T14:31:48.392Z] spawned dsh pid=12604
  [2026-09-12T14:32:01.949Z] port 3080 is up
  ```
  (第二行来自重入启动的同进程再记录,属实。)
- **关键**:日志中**没有** `stop requested; supervisor exiting`,**也没有** `replacement did not come up`
  ⇒ 修复前会出现的"**停用自启后再点重启 = 关机且不回来**"**在真机上确认不再发生**。
- **窗口**:20 → 20,**新增 0**;控制台类 **0**。

### 判据 3 —— 停用自启后 DSH 仍在跑:**通过**

| 检查 | 实测 |
|---|---|
| `HKCU\...\Run` 的 `DSH autostart` | **消失** |
| 看护进程 23440 | **仍存活**,启动时间仍 22:26:13 |
| DSH 29520 | **仍存活**,启动时间仍 22:26:13 |
| 新建的 `supervise.stop` | 内容 **23440** = **看护进程自己的 pid**(不是宿主 DSH 的 29520),写入 22:29:17 |
| `service.log` | **无新增行**、无关机动作 |

⇒ 与文档一致:**停用自启只取消开机自启,当前这次开机里两者继续运行**。

### 判据 4 —— 按需接管(没有看护进程时点重启):**通过**

- 步骤:正常关掉 DSH → 在**普通终端**里手动 `npx @deepseek-ai/dsh web`(无看护进程的 DSH)→ 在该界面点「重启服务」。
- 新看护进程 **30120**(22:38:08),其父进程 = **`WmiPrvSE`** ⇒ **确系经 WMI 中继拉起**(按需接管路径,非登录脚本)。
- `service.log`:
  ```
  [2026-09-12T14:38:08.643Z] supervisor pid=30120 watching 3080
  [2026-09-12T14:38:08.644Z] takeover: pid 19752 must be gone before we start
  [2026-09-12T14:38:09.907Z] spawned dsh pid=27244
  [2026-09-12T14:38:14.679Z] port 3080 is up
  ```
  其中 **19752 = 那台手动启动、被接管的 DSH**;新 DSH **27244** 的父进程 = 30120。
- **窗口**:命令前 23 → 等 4 秒后 23,**新增 0**。桌面上当时存在 2 个控制台类窗口
  (`WindowsTerminal.exe` 32200 与 `cmd.exe` 29152,均启动于 22:37:10,`cmd` 的父进程是 `explorer.exe`)
  —— 那是**用户按本判据步骤自己开的终端**,不是 DSH 产生的(新增数为 0 正是这一点的证据)。

### 未验到 / 残余(照实记录)

- **正常关闭 DSH 时看护进程消费 `supervise.stop` 并自行退出**:真机未观测到 `stop requested; supervisor exiting`
  这一行 —— 当时那次是把看护进程直接结束的,而非让它看到子进程的普通退出。**该路径目前只有单元测试覆盖。**
- **遗留纸条**:`restart.request` 里是**判据 4 那次**写下的目标 `19752`(判据 2 那条已被消费;这条的编号不属于任何当前子进程 ⇒ **永不被消费**);
  `supervise.stop` 仍写着旧看护进程 `23440`(与新看护进程 30120 不匹配 ⇒ **惰性**)。两者都是"陈旧文件由 pid 比对消解"
  的实证,但确实留了文件。
- **冷启动慢于 30 秒的机器**:首次等待会超时,此时 `isAlive(pid)` 为真 ⇒ 走"不重复启动"分支并放弃看护
  (方向安全,但会失去常驻)。本机实测 21.1 秒,未触及该分支。
- **按需接管实例的控制台归属**只有本判据这一次样本(结果无新增窗口),不足以断言该路径在所有机器上都稳定。

### 验收后的机器状态

- `DSH autostart` 已按用户要求**重新启用**(HKCU-Run 中可见)。
- 与 F9/重启相关的另一套旧机制 `DSH restartwatcher` **已退休**:开机项已删除、进程已结束;
  其文件保留在 `~/.dsh/scripts/restart-watcher.{vbs,ps1}`(恢复方式:在 HKCU Run 新建字符串值
  `DSH restartwatcher` = `wscript.exe "C:\Users\asus\.dsh\scripts\restart-watcher.vbs"`)。`DSH frpc` / `DSH authproxy` 未改动。
- 当前运行:DSH pid 27244、看护进程 pid 30120(均由判据 4 的按需接管路径产生)。

