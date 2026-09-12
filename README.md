# dsh-autostart

[English](README.en.md) | 中文

Windows 专用的 DeepSeek Harness 插件:一键开机自启 + 一键重启,而且**重启失败也不会把 DSH 关掉不回来** —— 全程没有控制台窗口。

## ⚠️ 免责声明(务必先读)

**安装前请自行检验环境。因使用本插件导致对话历史丢失、任务中断或数据损坏的,概不负责。**

重启会杀掉承载对话与 Agent 回合的 DSH 宿主进程:

- 有 Agent 在执行回合时重启 → 该回合被硬中断,结果可能不落盘
- 对话尚未写入 `~/.dsh/sessions/` → 该段历史可能丢失且不可恢复
- 并行会话中正在运行的任务也会被中断

使用前请:① 自行确认环境(Windows 版本、Node、DSH 版本、安全软件是否拦注册表);② 重启前确认没有重要任务在跑;③ 重要会话先备份 `~/.dsh/sessions/`;④ 自行评估是否启用开机自启(会写入 `HKCU\...\Run`)。

本软件按「原样」提供(MIT License,无任何担保)。

## 核心卖点(它到底解决什么)

重启一个程序,难的不是「关掉」,而是**「关掉之后还能回来」**。这个插件就是把这件事做成有保证的:

1. **重启失败不会让 DSH 停摆。** 放手让 DSH 退出之前,插件会 ① 确认「接管者」(看护进程)活着,② 把重启请求**写进磁盘并读回来验证**。任何一步不成立,它就**拒绝这次重启、DSH 原地不动**,并说明原因。这是一个真实发生过的故障:端口还没释放,旧逻辑探测一次就放弃,结果 DSH 关了、起不来。

2. **全程没有黑窗口。** DSH 启动时依附在**看护进程的隐藏控制台**上,所以它派生的每条命令都共用这个隐藏控制台,而不再各自新建一个 Windows Terminal 窗口 —— 以前是「每用一次工具就弹一个黑框」。

3. **接管者不是「看门狗」。** 看护进程常驻,但**只在「这次退出是你点的重启」时才拉起新实例**。你自己关掉 DSH,它就安静收工 —— 一个你关不掉的进程,比一个偶尔不自动回来的服务更糟。

4. **停用 / 卸载不会偷袭你正在用的 DSH。** 「停用自启」只取消下次开机自启;当前这次开机里 DSH 照常运行,看护进程会在 DSH 自己退出后收工。

5. **出问题有据可查。** 每一步都写进 `service.log`;失败时它会说明原因,而不是静默不动。

## 要求

- Windows 10 / 11(需要能通过 PowerShell 调用 `Win32_Process.Create` —— 点重启而当时**还没有看护进程**在跑时,会**刻意**交由 WMI 服务创建一个,以免和宿主一起被杀)
- Node.js ≥ 20(随 DSH 提供)
- DeepSeek Harness ≥ `0.1.0-rc.6`(实测于 `0.1.2-rc.1`;重启所依赖的 Job Object 行为实测于 `0.1.5-rc.1`)
- `HKCU\...\Run` 可写(开机自启用);安全软件拦截注册表会导致「启用」失败

### 环境与重启

DSH 由一个**常驻看护进程**启动 —— 开机时由 `bootstrap.vbs` 跑
`node service.js start --config <config.json>`(`start` 是 `supervise` 的别名,后者才是真正的入口;
生成的 bootstrap.vbs 用的是 `start`)。活得比 DSH 久的是这个看护进程:它从子进程句柄上
得知 DSH 退出,并且只在「这次退出是你从设置页要的重启」时才拉起新实例。

只有当你点重启、而**当时还没有看护进程**在跑(例如 DSH 是你手动起来的)时,才需要从 DSH 内部先创建一个
看护进程。这是 **WMI 服务**唯一出场的地方:DSH 把自己的子进程放在一个 kill-on-close 的 Windows Job
Object 里,所以仅仅 `detached` 的进程会在 DSH 退出的瞬间被一起杀掉 —— 结果是 DSH 停摆、再也起不来。
交给 WMI 创建,看护进程才能出得了那个 job、活得比宿主久。一旦看护进程已经存在(登录后的常态,以及第一次
重启之后的每一次),就不再经过 WMI。

代价是:这样创建出来的进程**不继承你的环境变量**。因此:

- 看护进程的 config.json 路径由宿主用 `--config <绝对路径>` 显式告知(而不是让它去按
  `DSH_HOME` 推导 —— 那个变量在这里是缺失的);
- 重启后的实例用 config.json 里记录的 `dshHome` 重新断言 `DSH_HOME`。

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
| 重启服务 | 二次确认后重启;DSH 会在数秒内恢复。它会先确保有看护进程在跑、由它把 DSH 拉回来;起步失败则当场拒绝这次重启 |
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
    exitDelayMs: 800               # 重启时旧宿主退出前的延时;上限 5000(见下方说明)
    waitForExitMs: 30000           # 自常驻看护进程取代旧重启路径后已无读者 —— 保留只是为了让
                                   # 已存在的 config.json 仍能加载
    startTimeoutMs: 30000
    openBrowserOnBoot: false       # true = 开机时自动打开浏览器
    blockWhenAgentsRunning: false  # true = 有 Agent 在跑时拒绝重启
    allowedHosts: []               # 经反代访问时填你的域名(必须显式填写),如 ['derp.example.com']
```

> **`exitDelayMs` 的有效上限是 5000 毫秒。** 这个延时只为让重启响应先刷出去、旧宿主再退出;而新拉起的
> 看护进程等这个宿主退出只等 30 秒(`DEFAULT_TAKEOVER_EXIT_MS`)。延时超过那个窗口,接管就会放弃并收工,
> 重启也就变成了关机 —— 所以超过 5000 的值在使用处被**截断到 5000**,而不是拒绝加载
> (`index.js` 的 `MAX_EXIT_DELAY_MS`)。

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
> `hookScript` / `dshPort` / `startTimeoutMs` 这些字段是在**「启用自启」时快照进
> `config.json`** 的,而看护进程读的是 `config.json`、不是插件的实时配置。所以改了它们**必须回设置页
> 重新点一次「启用自启」**才会生效(重复启用是幂等的)。真机实测过:改了 `hookScript` 却只重启服务,
> `config.json` 里仍是旧值,钩子不会执行。
> 而 `allowedHosts` 只影响插件的路由守卫,重载即生效,与自启无关。
> `waitForExitMs` 同样会被快照,但已经没有任何代码读它(见上方配置示例里的说明)。
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
├── bootstrap.vbs             # 开机入口:拉起常驻看护进程(wscript 无窗口)
├── dsh-web-server.log        # DSH stdout(含访问地址)
├── dsh-web-server.err.log
├── service.log               # 看护进程日志,排查问题先看这里
├── supervise.pid             # 看护进程自报的 pid(单实例守卫)
├── restart.request           # 重启时写入,记的是看护进程看到的那个退出的 DSH
└── supervise.stop            # 通知活着的看护进程在 DSH 消失后收工
```

后三个是**临时状态文件**:需要时创建、用完删除(全部尽力而为),不存在是正常的。但三者的清理时机并不一样:
`supervise.pid` 和 `supervise.stop` 在持有它们的看护进程处理到时就删掉;而 `restart.request` 只有在它记名的
那个 DSH **真的退出**时才会被消费 —— 所以一次被拒绝、或始终没走到那次退出的重启,它写的请求可以一直留在盘上,
直到下一次匹配的退出把它取走。

## 服务没起来时怎么救

**卡片在 DSH 的页面里 —— DSH 没起来时你打不开卡片**,所以补救必须走命令行。按下面顺序来。

### 0) 先等几分钟 —— 看护进程会原地重试

DSH 是由**常驻看护进程**启动的 —— 开机自启那条入口指向的**就是它**,所以在该有 DSH 的时候它总在。
新实例没起来时,看护进程不会干等就放弃:

1. 它会**原地重试**,间隔递增 1s → 1.5s → 2.25s → …,最多 **5 次**、预算 **5 分钟**;每次尝试还会为等端口
   花掉 `startTimeoutMs`(默认 30 秒)。所以"预算 + 最后一次尝试自己的等待"才是最久要等的时间,而循环通常
   比预算更早结束。*前提是上一次那个子进程确实已经退出* —— 如果它还活着,它不会另起一个去抢同一个端口。
2. 它**不会再安排"以后某次"**:看护进程本身就活过这次尝试,重试就发生在那个已经在看着端口的进程里。

因此失败之后**先等几分钟再动手** —— 预算 5 分钟,再加上最后一次尝试的 `startTimeoutMs`。日志里能看到它的动作:

```
spawned dsh pid=… (attempt 2/5)                        ← 正在重试
giving up: DSH did not come up after 5 attempt(s); supervisor exiting
```

那行 `giving up` 报的是**实际尝试过的次数**,不一定等于配置上限 5。

只有这些都失败,才按下面手动补救。

### 关于常驻进程(两条必须知道)

1. **它和 DSH 同生共死。** DSH 是**附着(attached)**在它的隐藏控制台上启动的(正是这个共享让每条命令
   不再弹窗),所以看护进程退出时 DSH 会一起结束。
2. **停用自启并不会立刻停掉它。** 停用只是取消**开机**自启 —— 当前这次开机里看护进程和你的 DSH 继续跑,
   下次登录后不再出现。
   - 卸载会**另外**写一个停止标记,所以活着的看护进程不会在 DSH 下次消失之后继续留守。
   - **要立刻结束两者,直接关闭 DSH** —— 子进程正常退出后,看护进程有意不留守。它只在**你从设置页请求的
     重启**时才把 DSH 拉回来,它不是看门狗。
   - CLI 里**没有** `stop` 模式(只有 `supervise` 和它的别名 `start`),而且写停止标记也**不会立刻**停掉
     看护进程:它**只在子进程(DSH)退出之后**才读那个标记。这个顺序是有意为之 —— 停用自启不该关掉你正在
     用的 DSH。

### 1) 先看日志找原因

```
~/.dsh/dsh-autostart/service.log            # 看护进程日志:先看这个
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

它执行 `<node> <service.js> start --config <config.json>`(`start` 是 `supervise` 的别名)。这条命令创建出的
就是**常驻看护进程**,它拥有一个**隐藏**控制台 —— DSH 附着在它上面启动,所以 DSH 没有可见窗口;DSH 的
stdout 写进 `~/.dsh/dsh-autostart/dsh-web-server.log` —— 成功的话那里面就会出现新的带 token 地址。

> 看护进程**会一直活到 DSH 结束**,并始终持有 DSH。不要杀它:它是 DSH 的父进程,它退出 DSH 也会跟着结束。

#### 也可以直接跑 CLI

```
node "<插件目录>\service.js" start --config "<config.json 的绝对路径>"
```

两个路径都必须是绝对路径(裸写 `service.js` 只有在你当前的工作目录恰好是插件目录时才能解析到)。它做的
和上面的 `bootstrap.vbs` 是同一件事,但它把 DSH 的命绑在**你运行它的那个控制台**上:DSH 是**附着**启动的,
所以关掉那个窗口就会终止 DSH;而且看护进程会**占住前台**直到 DSH 退出。用这种形式就把窗口一直留着;
否则优先用上面的 `bootstrap.vbs` —— 它给看护进程一个自己的隐藏控制台,并且立刻返回。

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
- **为什么等端口用条件轮询而不是固定 `Start-Sleep`**:固定等待曾让一次重启耗时 80 秒以上;条件轮询(`waitForPort`,间隔 250ms、受 `startTimeoutMs` 约束)把它压到数秒。看护进程**不轮询自己持有的那个 DSH 进程** —— 它握有那个子进程的句柄,等的是句柄的 `exit` 事件。(没有句柄可握的地方仍然按 pid 轮询:接管时等旧 DSH 退出,以及等新看护进程认领 `supervise.pid`。)
- **为什么端口判定用 TCP 连接而不是 `netstat`/`:port` 子串**:子串匹配会命中 `TIME_WAIT` 与客户端连接,导致"其实没启动却报告已在运行"。
- **为什么用 Node 而不是 PowerShell 实现逻辑**:PowerShell 脚本里的中文易出现编码问题,且受执行策略限制。
- **为什么必须写 `--no-open`**:DSH `0.1.2-rc.1` 每次启动生成新的 token,访问地址会打印在 stdout;插件把它捕获到日志并在设置页展示,因此开机时无需(也不应)弹出浏览器。
