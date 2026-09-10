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
    allowedHosts: []               # 经反代访问时填你的域名(必须显式填写),如 ['derp.example.com']
```

> **`allowedHosts` 必须由你显式填写(opt-in)。** 默认是空数组,即**不信任任何非回环的 Host**。
> 如果你是通过反向代理访问 DSH(例如 frp + auth-proxy,它会把浏览器发来的**原始 Host** 转发过来),
> 那么请求里的 Host 是公网域名而不是 `127.0.0.1`,写操作按钮(启用/停用自启、重启服务)会被守卫
> 拒绝并返回 **403**。把你的域名填进 `allowedHosts` 后这些按钮才可用;端口校验与同源校验
> (Origin 必须与 Host 完全一致)对这些条目**仍然生效**。

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
