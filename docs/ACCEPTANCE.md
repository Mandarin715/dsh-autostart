# 真机验收记录 (Task 14 / spec §8.3)

**日期**:2026-09-10
**环境**:Windows 桌面会话 · DSH `0.1.5-rc.1` · Node v24 · 插件以 `link:C:/Users/asus/Desktop/dsh-autostart` 安装(`feat/implementation`,HEAD `34ad1f2`)

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
| M4/M6 无控制台窗口 | **未验证(需人工)** | 需在重启瞬间肉眼确认;机制上走 `wscript` + `service.js`,不经 PowerShell 窗口 |
| M5 钩子失败不阻断 | **通过** | `hookScript` 指向不存在路径后重启,`service.log` 末行 `hook not found: C:\definitely\missing\hook.ps1`,而 DSH **正常起来**并在 3080 监听 |
| M7 卸载清理 | **未通过 UI 验证** | `dispose → cleanupAutostart` 确实会删除条目(见下方事件中实际观察到),但"从 UI 卸载插件"这一步未由 agent 执行 |

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

## 验收后的处理(2026-09-10 当晚)

| 发现 | 处理 | 证据 |
|---|---|---|
| F2 token 来源不一致 | **已修**(在用户的 `frp/auth-proxy.js`,不在本插件) | 改为按修改时间**从新到旧**尝试两个日志;重启一个**全新无缓存**的 auth-proxy 后,本机与手机均 **401 → 200**(而最新日志是插件那份,旧逻辑会读到 20:22 的旧 token) |
| F3 dispose 误删条目 | **已修**(`247728d`) | `cleanupAutostart` 只在**自己的 `service.js` 不存在**时才删(即真卸载的证据);真机注册表上验证:插件在 → **保留**,service.js 缺失 → **删除**,外来值 → **不动**。套件 118 → 121 |
| M7 卸载清理 | **已在真实注册表上验证** | 同上三条分支;未从 UI 卸载(agent 无浏览器),但 `dispose → cleanupAutostart` 已在真机触发并被观测 |
| F4 `reg.exe` stderr 噪音 | **未修**(Minor,待定) | 本次验收期间它再次现场出现于 PowerShell 输出,证实存在 |

**关于 F3 在 `link:` 安装下的行为(有意为之)**:`link:` 安装卸载后仓库仍在,`service.js` 依然存在,
条目会被**保留** —— 而那条自启此时**仍然可用**,保留是合理的;真正会留下死条目的是
**拷贝式安装**(`node_modules` 被删除),那种情况恰好会被清理。

## 结论

- 插件的 **挂载层** 与 **四条写路由** 在真机 `0.1.5-rc.1` 上**全部工作**,包括它存在的理由
  (助手在宿主退出后仍然存活并拉起新实例、`accessUrl` 随新 token 刷新)。
- 验收中发现的 **F2/F3 两个集成风险已修复并验证**;F4 为待定的 Minor。
- **仍未验证**(只能由人用眼睛/手完成):
  1. 「设置 → 通用设置」底部的**卡片是否出现**、内容是否正确(Step 1);
  2. 重启瞬间**是否有控制台窗口闪烁**(M4/M6);
  3. **从 UI 卸载插件**(M7 的 UI 路径)。
- 因此:**"机制已验证,插件未完全验收"** —— 三条人工项完成后才能说"确保能用"。
- 当前机器状态:插件已安装并加载(自启条目**已停用**,注册表只剩用户原有四条,避免开机竞态);
  手机远程正常。

