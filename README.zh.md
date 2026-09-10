# dsh-autostart

[English](README.md) | 中文

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

- Windows 10 / 11(需要能通过 PowerShell 调用 `Win32_Process.Create` —— 重启助手**刻意**交由 WMI 服务创建,以免和宿主一起被杀)
- Node.js ≥ 20(随 DSH 提供)
- DeepSeek Harness ≥ `0.1.0-rc.6`(实测于 `0.1.2-rc.1`;重启所依赖的 Job Object 行为实测于 `0.1.5-rc.1`)
- `HKCU\...\Run` 可写(开机自启用);安全软件拦截注册表会导致「启用」失败

### 环境与重启

重启助手是由 **WMI 服务**创建的,不是 DSH 直接创建的。DSH 把自己的子进程放在一个
kill-on-close 的 Windows Job Object 里,所以仅仅 `detached` 的助手会在 DSH 退出的瞬间被
一起杀掉 —— 结果是 DSH 停摆、再也起不来。交给 WMI 创建,它才能活得比宿主久。

代价是:这样创建出来的进程**不继承你的环境变量**。因此:

- 助手的 config.json 路径由宿主用 `--config <绝对路径>` 显式告知(而不是让助手去按
  `DSH_HOME` 推导 —— 那个变量在这里是缺失的);
- 重启时用 config.json 里记录的 `dshHome` 重新断言 `DSH_HOME`。

其余环境变量(自定义 `PATH`、DSH 读取的其他变量)**不会**被带到重启后的实例。如果你的
DSH 配置依赖环境变量,请留意这一点,并尽量让 `command.execPath` 是绝对路径。

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

> **页面完全打不开?** 这张卡片只在 DSH 运行时才存在 —— 见下面的「服务没起来时怎么救」。

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
    allowedHosts: []               # 经反代访问时填你的域名(必须显式填写),如 ['derp.example.com']
```

> **`allowedHosts` 必须由你显式填写(opt-in)。** 默认是空数组,即**不信任任何非回环的 Host**。
> 如果你是通过反向代理访问 DSH(例如 frp + auth-proxy,它会把浏览器发来的**原始 Host** 转发过来),
> 那么请求里的 Host 是公网域名而不是 `127.0.0.1`,写操作按钮(启用/停用自启、重启服务)会被守卫
> 拒绝并返回 **403**。把你的域名填进 `allowedHosts` 后这些按钮才可用;同源校验
> (Origin 必须与 Host 完全一致)对这些条目**仍然生效**——可接受的写法见下。

**`allowedHosts` 可接受的写法**:裸主机名,或 `host:port`,例如 `['derp.example.com']` 或
`['derp.example.com:8443']`。**不要**带协议头或路径(`https://derp.example.com/` 是错的)。
浏览器访问 `https://derp.example.com` 时 `Host` **不带端口**,因此对白名单里的权威**跳过**本地 `dshPort`
校验——填进白名单本身就是显式授权,而 Origin 与 Host 的同源校验依然必须成立。回环地址仍保持严格端口校验。

> **改配置后要不要重新启用自启?——要,但原因不是 dispose。**
> `hookScript` / `dshPort` / `waitForExitMs` / `startTimeoutMs` 这些字段是在**「启用自启」时快照进
> `config.json`** 的,而助手读的是 `config.json`、不是插件的实时配置。所以改了它们**必须回设置页
> 重新点一次「启用自启」**才会生效(重复启用是幂等的)。真机实测过:改了 `hookScript` 却只重启服务,
> `config.json` 里仍是旧值,钩子不会执行。
> 而 `allowedHosts` 只影响插件的路由守卫,重载即生效,与自启无关。
>
> **注册表项不会因为改配置而消失。** 插件只在自己**真的被卸载**时(判据:本插件的 `service.js`
> 已不存在)才移除 `DSH autostart`;DSH 因重载或加载失败而拆解插件树时**保留**它。

## 和已有的开机自启项如何共存(重要)

本插件**只管 DSH**。如果你原本已经有自己的开机自启项(例如 `HKCU\...\Run` 里的 `DSH Web`、
`DSH frpc`、`DSH authproxy`),那么启用本插件的自启之后,**会有两条自启项都想在登录时拉起 DSH**。

- ✅ **不会互相覆盖**:本插件只写、也只删自己那一条 `DSH autostart`,不碰你的条目(实测:启用后原有条目一字未动)。
- ⚠️ **但会重复**:两者都靠"端口已在监听就跳过"去重,所以最终只会有一个 DSH;然而存在一个**窄竞态** ——
  两条几乎同时跑、都在对方绑定端口之前探测到"未监听",于是都去拉起,其中一个因端口被占用而失败退出
  (无害,但会留下一次失败记录与可能的残留进程)。

### 做法 A:只留本插件(简单)

删掉你自己的 DSH 启动项:

```powershell
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DSH Web" /f
```

然后回设置页点一次「启用自启」。

> ⚠️ **不要顺手删掉 `DSH frpc` / `DSH authproxy`** —— 本插件**不管** frpc 和 auth-proxy。
> 手机远程若依赖它们,删掉就会失去自启。要合并请用做法 B。

### 做法 B:合并成「一条自启 + 一个钩子」(维护面最小)

钩子在**开机与每次重启之后**都会执行,所以把"确保其他进程在跑"的逻辑放进去,自启就只需要本插件这一条。

1. 写一个钩子,例如 `~/.dsh/hooks/after-service-up.ps1`:

   ```powershell
   # 服务起来后,确保其余依赖进程在跑(路径按你自己的改)
   & "$env:USERPROFILE\.dsh\scripts\start-frpc.ps1"
   & "$env:USERPROFILE\.dsh\scripts\start-authproxy.ps1"
   ```

2. 在 profile 的 `cordis.patch.yml` 里指向它:

   ```yaml
   - id: dsh-autostart
     name: dsh-autostart
     config:
       hookScript: 'C:\Users\<you>\.dsh\hooks\after-service-up.ps1'
   ```

3. 回设置页**重新点一次「启用自启」**(`hookScript` 是启用时快照进 `config.json` 的),
   再删掉 `DSH Web` / `DSH frpc` / `DSH authproxy` 三条,只留插件的 `DSH autostart`。

> 钩子失败**不会**阻断 DSH 启动(只记日志),所以钩子里各步骤可以独立失败。
> 确认钩子跑了没:看 `~/.dsh/dsh-autostart/service.log` 里的 `hook exited code=…`。

| 你原有的自启项 | 做法 A | 做法 B |
|---|---|---|
| `DSH Web`(负责拉 DSH) | 删掉 | 删掉 |
| `DSH frpc` / `DSH authproxy` | **保留** | 删掉,改由钩子负责 |

## 生成物位置

```
~/.dsh/dsh-autostart/
├── config.json               # 记录真实启动命令,service.js 读取
├── bootstrap.vbs             # 开机入口(wscript 无窗口)
├── dsh-web-server.log        # DSH stdout(含访问地址)
├── dsh-web-server.err.log
└── service.log               # 助手日志,排查问题先看这里
```

## 服务没起来时怎么救

**卡片在 DSH 的页面里 —— DSH 没起来时你打不开卡片**,所以补救必须走命令行。按下面顺序来。

### 1) 先看日志找原因

```
~/.dsh/dsh-autostart/service.log            # 助手日志:先看这个
~/.dsh/dsh-autostart/dsh-web-server.err.log # DSH 自己的报错
```

常见三类:

- `WARN port 3080 did not come up in time` → DSH 被拉起了但没监听,去看 `dsh-web-server.err.log`
- `hook not found:` / `hook exited code=…` → 钩子问题,**不会**阻断 DSH 启动
- `cannot read config` → `config.json` 缺失或损坏

### 2) 通用补救:手动执行一次「开机入口」

这一步等价于**"现在立刻跑一次开机自启"**,幂等(端口已在监听就跳过),而且**无窗口**:

```powershell
wscript.exe "$env:USERPROFILE\.dsh\dsh-autostart\bootstrap.vbs"
```

它执行 `<node> <service.js> start --config <config.json>`,把 DSH 隐藏拉起,并把 DSH 的 stdout
写进 `~/.dsh/dsh-autostart/dsh-web-server.log` —— 成功的话那里面就会出现新的带 token 地址。

### 3) 如果连 `config.json` 都不存在

说明从未点过「启用自启」。那就先用你平时的方式把 DSH 起来,再到设置页启用一次自启。

### 4) 用你自己惯用的启动脚本也行 —— 但只有两个要点

要点是**隐藏/后台启动**,以及**不要拿控制台窗口当服务的宿主**:

- ✅ `Start-Process … -WindowStyle Hidden`,或 `wscript` 跑 VBS,把 DSH 拉成后台进程
- ❌ **不要**用 `npx @deepseek-ai/dsh web` 这种**前台占用控制台**的方式;更**不要**"先拿到带 token 的地址,
  再把那个窗口关掉" —— 那个窗口就是 DSH 的控制台,**关掉窗口 Windows 会终止 DSH**,链接随之失效
  (此时是"拒绝连接"而不是 401,再粘也没用)

> 作者自己的机器上这一步是 `~/.dsh/scripts/start-dsh-web.ps1`(它用 `Start-Process -WindowStyle Hidden`
> 启动,并把 stdout 写进 `~/.dsh/logs/dsh-web-server.log`)。**这是作者本地的脚本,不属于本插件**;
> 你换成自己的等价脚本即可,或者直接用上面第 2) 步。

### 5) 别把两种情况搞混

| 现象 | 含义 | 做法 |
|---|---|---|
| 页面 **401 Unauthorized** | 服务**在跑**,只是这个浏览器没有会话 | 用「访问地址」里那条带 token 的链接进一次,**不要**重启服务 |
| **无法访问此网站 / 拒绝了连接** | 服务**没起来** | 按上面 1)–4) 处理 |

关于那条带 token 的地址,三个事实:①**只对本机有效**(它是 `127.0.0.1`;手机走域名 + 密码,由反代代换);
②换来的会话 cookie 有 **30 天**有效期,关浏览器、重启 DSH 都不受影响;③但 **token 本身每个 DSH 进程一个,
重启即作废** —— 所以要用**当前**这条(卡片显示的就是最新的),收藏一条长期用是无效的。

### 6) 补救成功的判据

- 端口 3080 处于 LISTENING
- `service.log` 里出现 `port 3080 is up`
- 设置页卡片的「服务」显示**运行中**

### 7) 如果最近升级或迁移过 DSH

`config.json` 记录的是**当时的绝对路径**(可能含 npx 缓存目录的哈希路径,如
`…\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`)。升级/迁移后该路径可能已失效,于是
**自启会静默失败**(开机什么都没发生)。回设置页**重新点一次「启用自启」**让它重新捕获当前命令即可。

## 卸载

1. **先在设置页停用开机自启**(会删除注册表项)

   > 这一步是**必需**的,不是可选的。原因有两条:①注册表项指向 `~/.dsh/dsh-autostart/bootstrap.vbs`,
   > 而它与 `config.json` 都在插件目录**之外**,卸载不会删;②`pnpm remove` 会**保留**
   > `node_modules/dsh-autostart` 这条符号链接,于是本插件的 `service.js` 依然可达 —— 而插件的清理
   > 判据正是"`service.js` 是否还存在"。所以**只卸载而不先停用,会留下一条死条目**(开机跑一次、
   > 静默失败)。也可以卸载后手工删掉 `HKCU\...\Run` 里的 `DSH autostart`。
   >
   > 顺带一提:设置页的「设置 → 插件」**没有**本插件的卸载按钮(那一页只管理从市场安装的插件),
   > 所以第 2 步的命令行是正常路径。
2. 卸载插件:`dsh plugin --profile web remove dsh-autostart`
3. 如需彻底清理,手动删除 `~/.dsh/dsh-autostart/` 目录

## 为什么这样实现(踩坑记录)

- **为什么用 `wscript.exe` 而不是 `powershell -WindowStyle Hidden`**:后者对长时间运行的脚本不可靠,会留下一个无法关闭的空控制台窗口。
- **为什么等待用条件轮询而不是固定 `Start-Sleep`**:固定等待曾让一次重启耗时 80 秒以上;条件轮询把它压到数秒。
- **为什么端口判定用 TCP 连接而不是 `netstat`/`:port` 子串**:子串匹配会命中 `TIME_WAIT` 与客户端连接,导致"其实没启动却报告已在运行"。
- **为什么用 Node 而不是 PowerShell 实现逻辑**:PowerShell 脚本里的中文易出现编码问题,且受执行策略限制。
- **为什么必须写 `--no-open`**:DSH `0.1.2-rc.1` 每次启动生成新的 token,访问地址会打印在 stdout;插件把它捕获到日志并在设置页展示,因此开机时无需(也不应)弹出浏览器。
