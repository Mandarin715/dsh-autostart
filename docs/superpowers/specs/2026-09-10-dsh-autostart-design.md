# dsh-autostart — 设计规格(spec)

- 日期:2026-09-10
- 状态:待评审
- 目标版本:`dsh-autostart@0.1.0`
- 验证环境:Windows 10/11 · Node v24.15.0 · DeepSeek Harness `0.1.2-rc.1`

---

## 0. ⚠️ 免责声明(务必先读)

**安装前请自行检验环境。因使用本插件导致对话历史丢失、任务中断或数据损坏的,概不负责。**

**为什么会有这个风险(不是套话,是机制决定的):**

本插件的核心能力是**杀掉 DSH 宿主进程并重新拉起**。而 DSH 的**对话与 Agent 回合正跑在这个宿主进程里**。因此:

- 在**有 Agent 正在执行回合时**触发重启 → 该回合被**硬中断**,正在进行的推理/工具调用结果可能**不会落盘**
- 若对话尚未写入会话持久化(`~/.dsh/sessions/`),**该段对话历史可能丢失且不可恢复**
- 重启还会中断**其他并行会话**中正在运行的任务

**使用者的责任:**

1. **安装前自行确认环境**:Windows 版本、Node 可用性、DSH 版本、是否有安全软件拦截注册表写入
2. **重启前自行确认没有重要任务在跑**:检查是否有 Agent 正在工作;必要时先等待回合结束
3. **自行做好备份**:重要会话建议先备份 `~/.dsh/sessions/`,或先在**非关键环境**试装验证
4. **自行评估**是否启用「开机自启」(会写入 `HKCU\...\Run`)

**软件作者不承担的责任:**

- 对话历史、上下文、记忆数据、任务结果**丢失或损坏**
- 因重启导致的中断、未完成的工作、外部系统副作用(如已发出的 API 调用、已执行的文件操作)
- 注册表改动引发的任何系统层面的问题
- 在不符合要求的环境中(非 Windows、DSH 版本不匹配、企业策略禁用 `wscript.exe`)使用造成的任何后果

**本软件按「原样」提供(MIT License,无任何明示或暗示担保)。** 详见 LICENSE。

**设计层面的缓解措施**(降低但不消除风险):

- 提供 `blockWhenAgentsRunning` 配置项:设为 `true` 时,**检测到有 Agent 运行中就拒绝重启**(默认 `false`——因为默认阻止会导致"在对话里永远点不了重启";请自行权衡)
- 重启按钮**必须二次确认**,确认文案中必须包含"可能中断正在进行的任务"
- **`README` 显著位置必须重复本声明**(中英双份)

---

## 1. 目标与成功标准

### 1.1 一句话

一个**面向第三方分发**的 DSH 插件:让 Windows 用户**开机自动跑起 DSH 服务**,并能在**设置页一键重启**它——不需要碰终端、不需要记命令、不需要额外依赖。

### 1.2 成功标准

| # | 标准 | 可验证方式 |
|---|---|---|
| S1 | 用户装上插件后,能在设置页**一键启用开机自启** | 注册表出现 `DSH autostart` 条目 |
| S2 | 重启电脑登录后,**DSH 自动在后台起来**,且**不弹任何控制台窗口** | 手动跑 `bootstrap.vbs`,用窗口枚举确认无 console 窗口 |
| S3 | 用户在设置页点「重启服务」,DSH **数秒内**恢复可用 | 记录 `重启触发 → 端口恢复` 时间差,应 < 15s |
| S4 | 设置页显示**当前带 token 的访问地址**,可一键复制 | UI 显示与 `dsh-web-server.log` 中最新 URL 一致 |
| S5 | 启用/停用自启**可逆**,卸载插件**自动清理自己写的注册表项** | 停用后条目消失;卸载后条目消失 |
| S6 | 非 Windows 平台**明确拒绝**且不产生副作用 | 单测覆盖平台门控分支 |

### 1.3 非目标(YAGNI)

明确**不做**:

- ❌ **不做手机远程 / frp 隧道 / 反向代理** —— 与本插件解耦;需要的人另装 `dsh-mobile-access-plugin`
- ❌ **不做跨平台**(macOS `launchd` / Linux `systemd`)—— 本版本只支持 Windows
- ❌ **不内置 frpc / 不管理任何隧道进程**
- ❌ **不打包 DSH 本体**,不管理 DSH 的安装与升级
- ❌ **不做服务化(Windows Service)**,只用用户级 `HKCU Run`
- ❌ **不做守护/自愈**(不实现"发现 DSH 挂了就自动拉起")——只做"开机拉起"与"主动重启"

---

## 2. 背景:为什么要这个插件

本设计基于在一台 Windows 机器上**长期实战验证**得到的结论。以下每条都是踩过的坑,直接决定了设计选择:

| 经验 | 后果 | 本设计如何应对 |
|---|---|---|
| `PowerShell -WindowStyle Hidden` 对**常驻脚本**不可靠,会留下可见空控制台窗口 | 用户桌面出现无法关闭的空弹窗 | 用 **`wscript.exe` + VBS** 包装(仅此一处用 VBS) |
| 固定 `Start-Sleep` 串起来的重启流程耗时 ~81s | "网页打不开"持续 1 分多钟 | **条件轮询**,无固定等待 |
| DSH `0.1.2-rc.1` 每次启动生成**新的 launch token**,根路径强制校验 | 重启后网页 401,须去日志翻 token URL | 启动时**捕获 stdout 到日志**,UI 解析并展示 URL |
| 用 `cmd /b` / 会话绑定的方式拉起脚本,进程随会话死亡 | 重启后服务没起来 | 一律 **独立进程**,且必须由 **Job 之外的服务**创建(见 §3.2) |
| 幂等判断用 `:port`(会匹配 TIME_WAIT)导致误判"已在运行" | 服务其实没起来却跳过 | 幂等判断只看 **LISTENING** 状态 |
| 第三方插件 `dsh-setting-restart` + 标记文件 + 常驻 watcher 共 4 个部件串联 | 部件多、状态易乱、标记易残留 | 本插件**自带按钮 + 自带 Node 助手**,部件降到 **2** |
| PowerShell 脚本里的中文导致编码乱码、"字符串缺少终止符" | 脚本损坏 | 插件逻辑**全用 Node**,不写中文进 .ps1 |

### 2.1 与既有插件的关系

| | `dsh-mobile-access-plugin`(已有) | **`dsh-autostart`(本设计)** |
|---|---|---|
| 职责 | 生成 frp 隧道 + Basic Auth 反代 + 其自启 | **DSH 服务本体的自启 + 重启** |
| 依赖 | 需要 VPS + 域名 + 证书 | **零外部依赖**(不需要 VPS/域名) |
| 关系 | 两者**独立**;可选搭配(见 §9 钩子) | |

---

## 3. 架构

### 3.1 部件(共 2 个)

```
┌──────────────────────────────────────────────┐
│  ① 插件本体(安装在 DSH profile 里)          │
│     index.js   host 侧:状态查询 / 自启管理 /  │
│                重启调度 / HTTP 路由           │
│     client.js  浏览器侧:设置页 UI 行          │
│     service.js Node 助手:start / restart 两模式│
├──────────────────────────────────────────────┤
│  ② 生成物(用户机器上,启用时才生成)        │
│     config.json    记录真实启动命令与策略     │
│     bootstrap.vbs  开机无窗口入口             │
│     日志文件        dsh-web-server.log 等     │
└──────────────────────────────────────────────┘
```

**对比**:原方案有 4 个部件(第三方插件 + 标记文件 + 常驻 watcher + 脚本)。本设计**去掉 watcher 与标记文件**,因为它们存在的唯一理由是"第三方插件无法执行自定义逻辑";而本插件**自己就是那个逻辑**,于是宿主进程可以直接创建助手(经 WMI 落到 Job 之外,见 §3.2),无需中转信号。

### 3.2 为什么 `service.js` 必须是独立进程

重启的本质是"**杀掉自己再把自己拉起来**"。宿主 DSH 进程调用 `process.exit(0)` 后,没有任何代码还能继续运行,因此:

- 启动 DSH 的动作**必须**由一个**不属于该进程树**的助手完成
- 助手必须在宿主退出**之前**启动完毕,确保宿主死亡后它仍在(WMI 创建的子进程不继承任何
  标准句柄,所以助手**自己**写 `service.log`,不依赖 stdio 重定向)

**⚠️ 实测更正(2026-09-10):`spawn(..., { detached: true })` 是不够的。**

DSH 把自己的子进程放在一个 **Windows Job Object** 里,该 Job 带
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`(实测 `LimitFlags=0x2000`、`BREAKAWAY_OK=False`)。
Node 的 `detached: true` 只设置 `DETACHED_PROCESS`,**不会**设置
`CREATE_BREAKAWAY_FROM_JOB`,所以助手**仍然是该 Job 的成员**:
宿主一退出 → Job 关闭 → 助手被一并杀掉 → **DSH 永久停摆**,
即"重启"按钮实际等于"关机"按钮。(实测:枚举 Job 的 PID 列表,`detached` 起的子进程仍在其中。)

因此助手必须由**另一个服务**代为创建。本插件用 **WMI**:
`powershell -NoProfile -NonInteractive -EncodedCommand <base64>`,脚本体是
`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`。
WMI provider host 不是 DSH 的后代,它创建的进程**不在** DSH 的 Job 里
(实测:不在 Job 的 PID 列表内,且在 WMI host 卸载后仍存活)。

由此产生两条硬性约束(§7 有对应错误行):

1. 宿主必须 **await** 这次创建,不能 fire-and-forget —— 启动器本身也在 Job 里,
   必须在宿主退出**之前**完成 WMI 调用。
2. 创建失败 / 超时 / 启动器返回非 0 → **不得退出宿主**,否则"重启"就变成了"关机"。

#### 3.2.1 环境不继承(实测,2026-09-10)

WMI 创建的子进程拿到的是 **provider host 的环境**,不是调用者的:实测 `DSH_HOME` 在启动器
里存在、在 WMI 子进程里为 `null`(`USERPROFILE` 仍是正确用户)。因此:

- **助手不得自行推导 DSH home**。宿主把 `configFilePath(dshHome)` 经
  `--config <绝对路径>` 显式传给助手。否则自定义 `DSH_HOME` 的用户会让助手去读
  `~/.dsh` 下并不存在的 config.json → 退出 1,而 DSH 此时已经退出 → **永久停摆**
  (与本设计要消灭的缺陷同类,只是触发条件不同)。
- **新 DSH 的 `DSH_HOME` 由 `spawnDsh` 重新断言**,取值来自 config.json 里新增的
  `dshHome` 字段(§5.2 / §7)。缺省 `null` 表示"不动环境",老 config.json 因此继续可用。
- 其余环境变量(自定义 `PATH`、DSH 读取的其他变量)**不会**被继承 —— 这是该边界的固有
  代价,已在 README 的「要求 / 环境与重启」里写明。若将来需要更多变量,应把它们加入
  config.json 这个唯一契约(§3.3),而不是假设环境可用。

### 3.3 组件职责与边界

| 单元 | 职责 | 依赖 | 可否独立理解 |
|---|---|---|---|
| `client.js` | 只做 UI 与 HTTP 调用,不含业务判断 | DSH client runtime | ✅ 看 UI 即知全貌 |
| `index.js` | 平台门控、状态聚合、注册表读写、生成文件、spawn 助手 | `ctx.webServer`、`node:fs` | ✅ |
| `service.js` | 与插件解耦的纯 Node 脚本:读 config → 启动/重启 DSH → 跑钩子 → 写日志 | 仅 `node:*` | ✅ **可脱离 DSH 单独运行**(便于测试) |
| `config.json` | 两个组件之间的**唯一契约** | — | ✅ |

> `service.js` 不 `import` 插件代码,只读 `config.json`。这让它可以用 `node service.js start` 直接手动测试,无需启动 DSH。

---

## 4. 文件布局

### 4.1 仓库结构

```
dsh-autostart/
├── package.json            # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml        # insert: id=dsh-autostart, name=dsh-autostart
├── index.js                # host 侧(§5.1)
├── client.js               # 浏览器侧(§6)
├── service.js              # Node 助手(§5.3)
├── lib/                    # 纯函数模块(便于单测)
│   ├── platform.js         # 平台门控
│   ├── detect-command.js   # 探测当前 DSH 启动命令 + argv 规范化
│   ├── registry.js         # HKCU Run 读写
│   ├── render-vbs.js       # bootstrap.vbs 渲染
│   ├── parse-url.js        # 从日志解析最新 token URL
│   ├── port.js             # 端口状态探测(统一实现,见 §6.1)
│   └── config.js           # 配置默认值 + 校验
├── test/                   # node:test 单测
├── README.md               # 英文
├── README.zh.md            # 中文
└── LICENSE                 # MIT
```

### 4.2 用户机器上的生成物

```
~/.dsh/dsh-autostart/
├── config.json             # 由插件生成,service.js 读取
├── bootstrap.vbs           # 由插件生成,开机入口
├── dsh-web-server.log      # DSH stdout(含 token URL)
├── dsh-web-server.err.log  # DSH stderr
└── service.log             # service.js 自己的日志
```

### 4.3 `config.json` 结构(组件间唯一契约)

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-09-10T09:29:00.000Z",
  "command": {
    "execPath": "C:\\Program Files\\nodejs\\node.exe",
    "argv": ["C:\\...\\@deepseek-ai\\dsh\\lib\\bin.js", "web", "--no-open"],
    "cwd": "C:\\Users\\<user>"
  },
  "dshHome": "C:\\Users\\<user>\\.dsh",
  "dshPort": 3080,
  "hookScript": "",
  "openBrowserOnBoot": false,
  "waitForExitMs": 30000,
  "startTimeoutMs": 30000,
  "logPaths": {
    "out": "C:\\Users\\<user>\\.dsh\\dsh-autostart\\dsh-web-server.log",
    "err": "C:\\Users\\<user>\\.dsh\\dsh-autostart\\dsh-web-server.err.log",
    "service": "C:\\Users\\<user>\\.dsh\\dsh-autostart\\service.log"
  }
}
```

`dshHome`(2026-09-10 新增)记录启用时解析出的 DSH home。它的作用是让**重启后的实例**不必
依赖环境:`spawnDsh` 会用它重新断言 `DSH_HOME`(见 §3.2.1)。缺省 / 缺失时为 `null`,表示
"不动环境",因此旧 `config.json` 继续可用。

**契约稳定性**:`service.js` 只依赖上表字段。新增字段必须提供默认值,保证旧 `config.json` 仍可用。

---

## 5. 数据流

### 5.1 流 ①:启用开机自启

```
用户在设置页点「启用开机自启」
  → client: POST /dsh-autostart/autostart/enable
  → host(index.js):
      1. 平台门控:非 Windows → 400 + 明确错误
      2. 探测当前 DSH 命令(lib/detect-command.js):
           execPath = process.execPath
           argv     = process.argv.slice(1)
           cwd      = process.cwd()
      3. 规范化 argv:确保含 "--no-open"(除非 openBrowserOnBoot=true)
      4. 写 ~/.dsh/dsh-autostart/config.json
      5. 渲染并写 bootstrap.vbs(lib/render-vbs.js)
      6. 写注册表 HKCU\...\Run:
           name  = "DSH autostart"
           value = wscript.exe "<abs path>\bootstrap.vbs"
      7. 返回 { enabled: true, registryValue, configPath, vbsPath }
  → client: 刷新状态
```

**幂等**:重复启用为覆盖写,不产生重复注册表项。
**失败出口**:任一步失败 → 返回明确错误(见 §7)。

### 5.2 流 ②:一键重启

> ⚠️ **本节已由 `2026-09-12-resident-supervisor-design.md` 取代。** 重启不再经 WMI 助手。
> 下面这段流程(第 4 步的 `service.js restart --pid`、第 6 步的 `exitDelayMs` 后退出、以及
> `service.js restart` 那半边的"等旧 pid 消失 → 拉新实例")记的是**旧实现**;现行实现是
> **常驻看护进程**接管:路由先确保看护进程活着,再写 `restart.request` 并退出本进程,
> 由看护进程按 `child.on('exit')` 拉起替代实例(spec §5/§6)。
> `waitForExitMs` 这个旋钮也因此失去了读者(见 `lib/config.js` 的注释)。

```
用户在设置页点「重启」→ 二次确认
  → client: POST /dsh-autostart/restart
  → host(index.js):
      1. same-origin 校验,失败 → 403
      2. 防重入:已在重启中 → 409
      3. 读取 `agents` 服务(ctx.get('agents')),统计 status === 'running' 的 Agent 数
         · blockWhenAgentsRunning 为真且计数 > 0 → 409(附计数)
         · 否则仅把计数写入日志(默认不阻止)
      4. 经 WMI 在 Job 之外创建助手:
         node <service.js> restart --pid <本进程 pid> --config <configFilePath(dshHome)>
         · `--config` 必须是绝对路径:该边界不继承环境,助手不得自行推导 DSH home(§3.2.1)
         · **必须 await 到该创建完成**(启动器自己也在 Job 里,宿主先退出会把它一起杀掉)
         · 创建失败 / 超时 / 非 0 退出 → 500,且**不退出宿主**
         · 防重入标志位在 await **之前**置位,失败路径清位以便重试
      5. 返回 202 { accepted: true }
      6. 等 exitDelayMs(默认 800ms)→ process.exit(0)
  → service.js restart:
      1. 读 config.json
      2. 轮询等旧 pid 消失(`process.kill(pid, 0)`),上限 waitForExitMs(30s)
   —— 存活判定**只有 ESRCH 视为"已消失"**;`EPERM` 等其他错误一律视为**仍存活**。
   若把所有错误都当"已消失",会跳过下面的中止分支而启动第二个实例,与"宁可不动也不制造双实例"的安全方向相反。
      3. 用 config.command 启动 DSH:detached,stdout→out 日志,stderr→err 日志
      4. 轮询等端口 LISTENING,上限 30s(条件轮询,无固定 sleep)
      5. 若 hookScript 非空且存在 → 执行钩子,记录其退出码
      6. 全过程写 service.log → 退出
```

**超时语义**:
- 若「等旧进程退出」超时 → **放弃重启,不改动现状**(不启动第二个实例),日志记录
- 若「等端口起来」超时 → 记录失败,但**不杀**刚启动的进程(可能只是起得慢)

### 5.3 流 ③:开机自启

```
Windows 登录
  → HKCU Run 触发:wscript.exe "<...>\bootstrap.vbs"
  → bootstrap.vbs:以 0 号窗口(隐藏)运行 node <service.js> start,不等待
  → service.js start:
      1. 读 config.json(缺失/损坏 → 写 service.log 并退出,不弹框)
      2. 幂等:端口已 LISTENING → 记日志"已在运行",退出
      3. 启动 DSH(detached,stdio → 日志)
      4. 轮询等端口 LISTENING(上限 30s)
      5. 跑钩子脚本(若配置)
      6. 写 service.log → 退出(DSH 继续独立运行)
```

**关键**:钩子在**开机与重启都会跑**,因此用户可以把"确保其他依赖进程在跑"的逻辑全部放进钩子,从而**把多条自启项合并成一条**(见 §9)。

### 5.4 `bootstrap.vbs` 内容(渲染模板)

```vbs
' Generated by dsh-autostart. Do not edit by hand.
Set sh = CreateObject("WScript.Shell")
sh.Run """<execPath>"" ""<serviceJs>"" start", 0, False
```

`0` = 窗口隐藏,`False` = 不等待。这是"无控制台窗口"的唯一保证手段。

---

## 6. UI 与接口

### 6.1 设置页 UI(设置 → 通用设置,一张卡片)

| 元素 | 内容 | 数据来源 |
|---|---|---|
| 服务状态 | `运行中(端口 3080)` / `已停止` | 端口探测 |
| 自启状态 | `已启用` / `未启用` | 读注册表实测 |
| 当前访问地址 | 最新带 token URL + 复制按钮 | 解析 `dsh-web-server.log` 最后一条匹配 |
| 自启开关 | 启用 / 停用 | 流 ① / 停用接口 |
| 重启按钮 | 带二次确认;**确认文案必须含"可能中断正在进行的任务,未落盘的对话可能丢失"** | 流 ② |
| 免责提示 | 卡片底部一行小字:链接到 README 免责声明(见 §0) | 静态文案 |
| 钩子状态 | 路径 + 存在性(不存在显黄字) | `fs.existsSync` |
| 非 Windows | 整行退化为提示文案 | 平台门控 |

**UI 原则**:所有状态来自**实测**(端口、注册表、文件),不使用缓存值,避免 UI 与真实状态不符。

**端口探测的统一实现**(`lib/port.js`,`index.js` 与 `service.js` 共用):

- 判定"运行中" = 尝试 TCP 连接 `127.0.0.1:<dshPort>`,成功即在运行(net.connect + 短超时)
- **不用** `netstat` 文本解析、**不用** `:port` 子串匹配(会误匹配 `TIME_WAIT` 与客户端连接——这是既有系统的教训)
- 探测失败(ECONNREFUSED / 超时)= 未运行

### 6.2 HTTP 路由

| 方法 | 路径 | 作用 | 副作用 |
|---|---|---|---|
| GET | `/dsh-autostart/state` | 聚合状态 | 无 |
| POST | `/dsh-autostart/autostart/enable` | 启用自启 | 写文件 + 注册表 |
| POST | `/dsh-autostart/autostart/disable` | 停用自启 | 删注册表(保留文件) |
| POST | `/dsh-autostart/restart` | 触发重启 | 杀宿主 + 拉起 |

**安全要求**:

- 所有 POST **必须**做 same-origin 校验,不通过返回 403
- **校验不能只比对 `Origin` 与 `Host` 是否相等** —— 这两个头都来自请求方,在 **DNS rebinding** 场景下天然相等:攻击者页面先由 `evil.example:<port>` 提供,随后该域名重绑定到 `127.0.0.1:<port>`,浏览器发出的请求便带着 `Host: evil.example:<port>` 与 `Origin: http://evil.example:<port>`。仅凭"两值相等"放行,等价于没有校验
- 正确做法:**先要求 `Host` 是回环权威**(hostname ∈ {`127.0.0.1`, `localhost`, `::1`, `[::1]`},且端口等于本插件的 `dshPort`),**再**要求 `Origin` 与该 `Host` 同源
- **例外:受信任的反向代理域名**。若用户通过反代(如 frp + auth-proxy)从外网访问 DSH,浏览器发出的 `Host` 与 `Origin` 都是那个域名(反代原样转发 Host),回环限制会把设置卡的**所有写操作拒成 403**。因此提供配置项 `allowedHosts: string[]`(默认 `[]`):列出的权威与回环**同等放行**,且**仍需满足端口匹配与 `Origin` 同源**两个条件。用户必须显式列出自己的域名才获得该例外,不存在"默认放开"
- 原因:这些接口能写 `HKCU\...\Run`(登录时执行)、能杀掉宿主进程。若被任意网页触达,后果是**持久化代码执行**,而不只是"被重启一下"
- `state` 为只读,可不强制校验(约束只针对写操作),但仍不返回敏感信息(token URL 除外——它就是本机用户自用)。注意它每次调用都会同步跑一次 `reg.exe` 并做一次 TCP 探测,因此服务若被绑到 `0.0.0.0` 会形成放大面

### 6.3 插件配置块

```yaml
- id: dsh-autostart
  name: dsh-autostart
  config:
    hookScript: ''                 # 可选,服务起来后执行的脚本绝对路径
    dshPort: 3080
    exitDelayMs: 800
    waitForExitMs: 30000
    startTimeoutMs: 30000
    openBrowserOnBoot: false
    blockWhenAgentsRunning: false
```

所有字段有默认值;缺省时插件可正常工作。

---

## 7. 错误处理

| 场景 | 行为 | 用户可见位置 |
|---|---|---|
| 非 Windows 平台 | 启用/重启接口返回 400 + 原因;`state` 标 `supported:false` | UI 显示"仅支持 Windows" |
| 注册表写入失败 | 返回 500 + `registry write failed`;提示可能被安全软件拦截 | UI 错误提示 |
| `config.json` 缺失/损坏(开机) | 写 `service.log` 后退出,**不弹任何对话框** | 仅日志 |
| `config.json` 缺失(重启时) | 返回 400,提示"请先启用自启"(启用动作本身会生成它) | UI 错误提示 |
| `node` 路径失效(开机) | 写日志退出 | 仅日志 |
| 启动时端口已被占用 | 幂等跳过,记"已在运行" | UI 状态显示运行中 |
| 钩子脚本不存在 | 跳过并记日志;如配置了路径但不存在,UI 显黄字 | UI + 日志 |
| 钩子执行失败(非零退出) | **不阻断** DSH 启动;记录退出码与 stderr | 仅日志 |
| 重启中重复点击 | 返回 409。标志位在 **await 之前**置位,否则并发请求会各自通过检查、起两个助手、arm 两次退出(§5.2) | UI 提示"正在重启中" |
| 启动失败后重试 | 失败路径清掉标志位,用户可以再点一次(否则按钮永久锁死) | UI 错误提示 |
| 自定义 `DSH_HOME` 的用户重启 | 宿主把 config.json 的**绝对路径**经 `--config` 交给助手;新实例的 `DSH_HOME` 由 config.json 的 `dshHome` 重新断言(§3.2.1) | 仅日志 |
| 等旧进程退出超时 | 中止重启(不启动第二实例),写日志 | 仅日志 |
| 等端口起来超时 | 记录失败,不杀进程 | 仅日志 |
| 创建助手失败 / WMI 启动器超时或非 0 退出 | 返回 500,宿主**不退出**(避免把服务搞停) | UI 错误提示 |
| 宿主在助手创建完成前退出 | **禁止**:创建必须 await,否则助手被 Job 一并杀掉(§3.2) | — |

**总原则**:**DSH 服务本身优先于辅助功能**。任何钩子/日志/UI 层面的失败都不得阻止 DSH 起来;而任何会导致"服务消失"的操作都必须有明确的失败出口。

---

## 8. 测试策略

### 8.1 自动化(Node 内置 `node:test`,零新增依赖)

| 模块 | 用例 |
|---|---|
| `lib/platform.js` | 非 Windows 拒绝;Windows 通过 |
| `lib/detect-command.js` | 给定 argv 数组 → 正确切分 execPath/argv;`--no-open` 规范化(缺则补、`openBrowserOnBoot` 为真则不补) |
| `lib/parse-url.js` | 从多行日志取**最后一条** `dsh web: http...?token=`;无匹配返回 null;容忍尾随空白/CRLF |
| `lib/render-vbs.js` | 路径含空格时正确加引号;路径含反斜杠转义正确;必须收到**绝对** `configPath` 并渲染进命令行(否则登录时助手会去推导 DSH home) |
| `lib/registry.js` | 注册表 value 字符串构造正确(可注入假执行器测试,不触碰真实注册表) |
| `lib/port.js` | 对已监听端口返回 true、未监听返回 false(用本进程临时监听一个端口做真实断言) |
| `lib/config.js` | 默认值填充;非法值拒绝;旧版本 config 缺字段时用默认值;`dshHome` 缺失时为 `null` |
| `lib/launch-helper.js` | 含空格 / 单引号 / 尾随反斜杠的路径加引号正确;非正整数 pid 与缺失 `configPath` 被拒;启动器走**绝对路径** powershell 且用 `-EncodedCommand` 承载 `Win32_Process.Create`,失败时既非 0 退出、又经 `Write-Error` 带出 ReturnValue;**用真实启动器**对不存在的 exe 断言退出码非 0 |
| Job / 环境边界(`index.js` + `service.js`) | 助手经 WMI 在 Job 外创建;启动失败/超时/非 0 → 路由 500 且**不退出**;并发两次重启只得到一次 202、只起一个助手;重启路由把 `configFilePath(dshHome)` 作为 `--config` 传入;`spawnDsh` 按 config.json 的 `dshHome` 重新断言 `DSH_HOME`,缺省时不动环境 |

### 8.2 语法门

所有 `.js` 文件通过 `node --check`。

### 8.3 手动验收清单(Windows 真机,必须逐条跑)

| # | 步骤 | 期望 |
|---|---|---|
| M1 | 启用自启 | 注册表 `DSH autostart` 出现且指向我们生成的 `bootstrap.vbs`;UI 显示"已启用" |
| M2 | 停用自启 | 注册表条目消失;UI 显示"未启用" |
| M3 | 点重启,计时 | DSH 在 **< 15s** 内恢复;`service.log` 时间线完整;UI 访问地址更新为新 token |
| M4 | 手动执行 `bootstrap.vbs` | **无任何控制台窗口出现**;服务已在跑时幂等跳过并记日志 |
| M5 | 钩子故意填错路径 | DSH 仍正常起来;`service.log` 记录钩子失败 |
| M6 | 重启时观察桌面 | 全程**无控制台窗口**闪烁/残留 |
| M7 | 卸载插件 | 注册表条目被清理(仅当仍指向我们的 vbs) |

> M4 与 M6 是本次设计的**回归测试重点**——它们对应 §2 表格里"空控制台窗口"那条教训。

---

## 9. 集成:与用户既有环境共存

本插件**不修改**任何既有配置。它通过**可选钩子**接入其他需求:

```
config.hookScript = "C:\\Users\\<user>\\.dsh\\scripts\\hooks\\after-service-up.ps1"
```

该钩子在**开机与重启后**执行,可用于:

- 确保 `auth-proxy`(Basic Auth 反代)在跑 → 手机远程不断
- 确保 `frpc` 在跑
- 任何其他依赖服务

**建议的收敛路径**(可选,不在本版本实现):

用户在钩子就绪后,可以把既有的多条 `HKCU Run` 自启项**合并为插件这一条**,由钩子统一负责其余进程。这样整个"手机远程可用"只依赖**一条自启 + 一个钩子脚本**,维护面最小。

**示例钩子内容**(用户自建,非插件提供):

```powershell
# ~/.dsh/scripts/hooks/after-service-up.ps1
& "$env:USERPROFILE\.dsh\scripts\start-authproxy.ps1"
& "$env:USERPROFILE\.dsh\scripts\start-frpc.ps1"
```

---

## 10. 交付与分发

| 项 | 内容 |
|---|---|
| 仓库 | `Mandarin715/dsh-autostart`(public,MIT) |
| 安装 | `dsh plugin --profile web add github:Mandarin715/dsh-autostart` |
| npm 发布 | 本版本不做(可选后续) |
| README | 中英双份:简介 / **⚠️ 免责声明(显著位置,见 §0)** / 要求 / 安装 / 启用 / 配置 / 卸载 / **踩坑说明** |
| 要求 | Windows 10+;DSH ≥ `0.1.0-rc.6`(**实测于 `0.1.2-rc.1`**);Node ≥ 20(随 DSH 提供) |
| 版本 | `0.1.0` 起 |

### 10.1 卸载行为

插件 `dispose` 时:
1. 读取注册表 `DSH autostart`
2. **仅当**其值指向我们生成的 `bootstrap.vbs` 时删除该条目
3. **不删除**生成的文件与目录(留给用户手动清理,README 说明路径)

理由:避免误删他人的自启项;文件保留可避免"误卸载后无法排查"。

---

## 11. 假设、风险与缓解

| # | 假设/风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | DSH 未来的版本可能改动"启动参数"或"token 打印格式" | 启停仍可用,但 UI 的访问地址解析可能失效 | 解析失败时 UI 显示"未取到地址"而非报错;格式变化只需更新 `parse-url.js` |
| R2 | 用户用非 npx 方式(全局安装 / 其他启动器)运行 DSH | 命令探测仍有效(基于 `execPath+argv`) | 探测法本身与安装方式无关 |
| R3 | 企业安全软件拦截 `HKCU Run` 写入 | 自启不可用 | 明确错误提示;不影响其他功能 |
| R4 | `wscript.exe` 在某些企业策略下被禁用 | 开机启动会弹窗或失败 | README 记录此限制;M4 用于发现 |
| R5 | npx 缓存被清理导致 `bin.js` 路径失效 | 开机启动失败 | 记日志;README 提示可改用全局安装 `dsh` |
| R6 | 用户在 Agent 运行中点重启,任务被中断、**对话历史可能丢失**(详见 §0 免责声明) | 数据/上下文丢失 | 提供 `blockWhenAgentsRunning` 配置项;默认不阻止(否则无法在对话中点重启);重启按钮二次确认 + 卡片免责提示 |
| R7 | 端口被其他程序(非 DSH)占用 | 启动失败,且幂等逻辑会误判为"已在运行" | 启动前用 TCP 连接确认端口"有响应";README 提示改 `dshPort` 或排查占用 |

---

## 12. 未决问题

无。本 spec 的每一节均已在对话中与用户逐段确认。
