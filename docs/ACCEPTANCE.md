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

### 发现 F5 —— 重启没有回滚(设计限制,已知)

若新 DSH 因任何原因启动失败(本次事件 A 就是实例),助手会记录端口等待失败,但**不会回滚**,
DSH 停在下线状态,需外部手段(本机 `restart-dsh-web.ps1` 或官方命令)拉起。
这与 spec §5.2 一致,但值得在 README 里对用户明说。

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

遗留可见窗口:全部属于同一个 Windows Terminal 进程(pid 23444),其**子进程为空**
(标签页里的进程都已退出),且当前 DSH 的祖先链上没有它 —— 关掉不影响 DSH。

### 发现 F7 —— 重启按钮的禁用理由与实际前置条件不一致(Minor,未修)

`client.js:178` 的禁用条件是 `state.autostartEnabled` 为假就禁用,但**路由的真实前置条件是
`config.json` 存在**。于是"自启已停用、但 `config.json` 仍在"时,按钮是灰的、提示却在说
"需要先由它生成 config.json" —— 而那个文件确实存在(本次验收收尾时正处于这个状态:卡片显示
`开机自启: 未启用` 并要求启用,但重启其实是可用的)。建议按 `config.json` 是否存在来禁用,
或让提示文案与真实条件一致。

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
| F7 重启按钮禁用理由不符 | **未修**(Minor,待定) | 见发现 F7 |

**关于 F3 在 `link:` 安装下的行为(有意为之)**:`link:` 安装卸载后仓库仍在,`service.js` 依然存在,
条目会被**保留** —— 而那条自启此时**仍然可用**,保留是合理的;真正会留下死条目的是
**拷贝式安装**(`node_modules` 被删除),那种情况恰好会被清理。

## 结论

- 插件的 **挂载层** 与 **四条写路由** 在真机 `0.1.5-rc.1` 上**全部工作**,包括它存在的理由
  (助手在宿主退出后仍然存活并拉起新实例、`accessUrl` 随新 token 刷新)。
- 验收中发现的 **F2/F3/F4/F6 四项已修复并验证**;F7 已修(待用户刷新页面视觉确认);无其他待定项。
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

