# dsh-autostart

English | [中文](README.zh.md)

A Windows-only DeepSeek Harness plugin: enable "start the DSH service at boot" and restart that service from the settings page, one click each. No console window at any point.

## ⚠️ Disclaimer (read first)

**Verify your environment before installing. The author is not liable for lost conversation history, interrupted tasks, or damaged data.**

Restarting kills the DSH host process that runs your conversations and agent turns:

- Restarting while an agent is mid-turn → that turn is hard-interrupted and its result may never be written to disk
- A conversation not yet flushed to `~/.dsh/sessions/` → that history may be lost and is not recoverable
- Tasks running in parallel sessions are interrupted too

Before you use it: (1) verify the environment yourself (Windows version, Node, DSH version, whether security software blocks registry writes); (2) make sure no important task is running before you restart; (3) back up `~/.dsh/sessions/` for important conversations; (4) decide for yourself whether to enable boot autostart (it writes to `HKCU\...\Run`).

The software is provided "as is" (MIT License, no warranty of any kind).

## Requirements

- Windows 10 / 11 (`Win32_Process.Create` must work through PowerShell — the restart helper is deliberately created by the WMI service, so that it is not killed together with the host)
- Node.js ≥ 20 (shipped with DSH)
- DeepSeek Harness ≥ `0.1.0-rc.6` (tested on `0.1.2-rc.1`; the job-object behaviour the restart depends on was measured on `0.1.5-rc.1`)
- A writable `HKCU\...\Run` for autostart — security software that blocks registry writes makes "enable" fail

### Environment and restart

The restart helper is created by the **WMI service**, not by DSH directly. DSH runs its
subprocesses inside a Windows Job Object created kill-on-close, so a merely "detached" helper is
killed the instant DSH exits — leaving DSH down. Having WMI create it is what lets it outlive the
host.

One consequence: a process created that way does **not** inherit your environment. So:

- the helper is told where `config.json` lives explicitly (`--config <absolute path>`), instead of
  re-deriving the DSH home from `DSH_HOME` (which would be missing);
- the restart re-asserts `DSH_HOME` from the `dshHome` captured in `config.json`.

Other environment variables (a custom `PATH`, extra variables DSH reads) are **not** carried over
to the restarted instance. If your DSH setup depends on environment variables, keep that in mind,
and prefer an absolute `command.execPath`.

## Install

```sh
dsh plugin --profile web add github:Mandarin715/dsh-autostart
```

Restart DSH, then open Settings → General and scroll to the bottom to find this plugin's card.

## Usage

| Control | What it does |
|---|---|
| Service status | Probes the port live; shows running / stopped |
| Boot autostart toggle | When enabled, writes `~/.dsh/dsh-autostart/config.json`, generates `bootstrap.vbs`, and adds the `DSH autostart` entry under `HKCU\...\Run` |
| Current access URL | The newest token-bearing URL parsed out of the captured startup output; one-click copy |
| Restart service | Restarts after a confirmation; DSH is back within seconds |
| Hook script | Optional. Run once the service is up, to start your own dependent processes |

> **Cannot open the page at all?** This card only exists while DSH is running — see
> [If the service will not start](#if-the-service-will-not-start-recovery) below.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-autostart
  name: dsh-autostart
  config:
    hookScript: ''                 # optional, absolute path to a script run after the service starts
    dshPort: 3080
    exitDelayMs: 800
    waitForExitMs: 30000
    startTimeoutMs: 30000
    openBrowserOnBoot: false       # true = open the browser on boot
    blockWhenAgentsRunning: false  # true = refuse to restart while an agent is running
    allowedHosts: []               # for reverse-proxy access, add your domain (must be opted in), e.g. ['derp.example.com']
```

> **`allowedHosts` is opt-in — you must add the entry yourself.** The default is an empty array, meaning **no non-loopback Host is trusted**.
> If you reach DSH through a reverse proxy (for example frp + auth-proxy, which forwards the browser's **original Host**),
> the request's Host is your public domain rather than `127.0.0.1`, so the write buttons (enable / disable autostart,
> restart service) are refused with **403**. Add your domain to `allowedHosts` to make those buttons work; the
> same-origin check (Origin must equal Host exactly) still applies to those entries — see the accepted forms below.

**Accepted `allowedHosts` forms:** a bare host, or `host:port` — for example `['derp.example.com']` or
`['derp.example.com:8443']`. Do **not** include a scheme or a path (`https://derp.example.com/` is wrong).
Because a browser reaching `https://derp.example.com` sends no port at all, the local `dshPort` check is **skipped for
allow-listed authorities** — the entry itself is the explicit opt-in, and the Origin/Host match still has to hold.
Loopback keeps the strict port check.

> **Do config changes require re-enabling autostart? Yes — but not because of dispose.**
> `hookScript`, `dshPort`, `waitForExitMs` and `startTimeoutMs` are **snapshotted into `config.json` when you click
> Enable**, and the helper reads `config.json`, not the plugin's live config. So after changing them you **must open the
> settings card and enable autostart again** (re-enabling is idempotent). Measured on a real install: changing
> `hookScript` and only restarting the service left the old value in `config.json`, so the hook never ran.
> `allowedHosts` is different — it only affects the plugin's route guard and takes effect on reload.
>
> **The registry entry does not disappear because you edited the config.** The plugin removes `DSH autostart` only when it
> is genuinely uninstalled (evidence: its own `service.js` is gone); when DSH tears the plugin tree down for a reload or a
> failed load, the entry is **kept**.

## Coexisting with an autostart entry you already have (important)

This plugin manages **DSH only**. If you already have your own boot entries (for example `DSH Web`, `DSH frpc`,
`DSH authproxy` under `HKCU\...\Run`), then after enabling this plugin's autostart **two entries will both try to
start DSH at login**.

- ✅ **They do not overwrite each other**: this plugin writes and deletes only its own `DSH autostart` value and never
  touches yours (measured: after enabling, the user's other entries were untouched).
- ⚠️ **But they do duplicate work**: both dedupe via "skip if the port is already listening", so you still end up with
  one DSH — yet there is a **narrow race**: if both run and both probe before either binds the port, both will try to
  launch, and one will fail because the port is taken (harmless, but it leaves a failure in the log and possibly a
  stray process).

### Option A: keep only this plugin (simple)

Delete your own DSH entry:

```powershell
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DSH Web" /f
```

Then click Enable in the settings card.

> ⚠️ **Do not also delete `DSH frpc` / `DSH authproxy`** — this plugin does **not** manage frpc or auth-proxy.
> If phone access depends on them, deleting those entries loses their autostart. Use Option B to merge instead.

### Option B: merge into "one autostart + one hook" (least to maintain)

The hook runs **at boot and after every restart**, so put "make sure my other processes are running" in it and let
this plugin be your only autostart entry.

1. Write a hook, for example `~/.dsh/hooks/after-service-up.ps1`:

   ```powershell
   # once the service is up, make sure the other processes run (adjust the paths)
   & "$env:USERPROFILE\.dsh\scripts\start-frpc.ps1"
   & "$env:USERPROFILE\.dsh\scripts\start-authproxy.ps1"
   ```

2. Point the plugin at it in the profile's `cordis.patch.yml`:

   ```yaml
   - id: dsh-autostart
     name: dsh-autostart
     config:
       hookScript: 'C:\Users\<you>\.dsh\hooks\after-service-up.ps1'
   ```

3. **Click Enable again** in the settings card (`hookScript` is snapshotted into `config.json` when you enable), then
   delete `DSH Web` / `DSH frpc` / `DSH authproxy` and keep only this plugin's `DSH autostart`.

> A failing hook does **not** block DSH (it is only logged), so its steps may fail independently.
> To check whether it ran, look for `hook exited code=…` in `~/.dsh/dsh-autostart/service.log`.

| Your existing entry | Option A | Option B |
|---|---|---|
| `DSH Web` (starts DSH) | delete | delete |
| `DSH frpc` / `DSH authproxy` | **keep** | delete; the hook takes over |

## Generated files

```
~/.dsh/dsh-autostart/
├── config.json               # the real launch command, read by service.js
├── bootstrap.vbs             # boot entry point (wscript, no window)
├── dsh-web-server.log        # DSH stdout (contains the access URL)
├── dsh-web-server.err.log
└── service.log               # helper log; look here first when debugging
```

## If the service will not start (recovery)

**The card lives inside DSH's page — so when DSH is down you cannot open the card.** Recovery therefore has to be
command-line. Work down this list.

### 0) Wait a minute or two first — the plugin retries on its own

When the replacement instance does not come up, the helper does not simply give up:

1. It **retries the start up to 3 times** (each waits `startTimeoutMs`, 30s by default, with a 3s pause between).
   It only retries once the failed child is **really gone** — while one is still alive it will not start a competitor
   for the same port.
2. If all attempts fail it **schedules one delayed attempt** (60s by default), run by a process that outlives the
   helper. That attempt is **marked so it can never schedule another**, so this cannot become a retry loop.

So after a failure, **wait 1–2 minutes before intervening by hand**. The helper says what it is doing:

```
spawned dsh pid=… (attempt 2/3)                       # retrying
scheduled one more start attempt in 60000ms (pid=…)   # fallback armed
waiting 60000ms before the fallback attempt           # fallback actually ran
```

Only if all of that fails, continue below.

### 1) Read the logs first

```
~/.dsh/dsh-autostart/service.log            # the helper's log: start here
~/.dsh/dsh-autostart/dsh-web-server.err.log # DSH's own errors
```

Three common shapes:

- `WARN port 3080 did not come up in time` → DSH was launched but never listened; look at `dsh-web-server.err.log`
- `hook not found:` / `hook exited code=…` → a hook problem; it does **not** block DSH
- `cannot read config` → `config.json` is missing or corrupt

### 2) The general fix: run the boot entry point once by hand

This is exactly "run boot autostart right now". It is idempotent (it skips when the port is already listening) and it
opens no window:

```powershell
wscript.exe "$env:USERPROFILE\.dsh\dsh-autostart\bootstrap.vbs"
```

It runs `<node> <service.js> start --config <config.json>`, starts DSH hidden, and writes DSH's stdout to
`~/.dsh/dsh-autostart/dsh-web-server.log` — on success a fresh token URL appears there.

### 3) If `config.json` does not exist at all

Autostart was never enabled. Start DSH the way you normally do, then enable autostart in the settings page.

### 4) Your own launcher script works too — with two rules

The rules are **start it hidden / in the background**, and **never let a console window be the service's host**:

- ✅ `Start-Process … -WindowStyle Hidden`, or a `wscript` VBS, so DSH becomes a background process
- ❌ **Do not** use a foreground console launch such as `npx @deepseek-ai/dsh web`; and **never** "grab the tokenised
  address, then close that window" — the window *is* DSH's console, and **closing it makes Windows terminate DSH**,
  which kills the link too. You then get "connection refused" rather than 401, and pasting it again will not help.

> On the author's machine this step is `~/.dsh/scripts/start-dsh-web.ps1` (it launches with
> `Start-Process -WindowStyle Hidden` and captures stdout into `~/.dsh/logs/dsh-web-server.log`).
> **That is the author's local script, not part of this plugin** — substitute your own equivalent, or just use step 2.

### 5) Do not confuse the two failure modes

| What you see | What it means | What to do |
|---|---|---|
| **401 Unauthorized** | the service **is running**; this browser just has no session | open the tokenised address from "access URL" once; do **not** restart |
| **This site can't be reached / connection refused** | the service **is not running** | work through 1)–4) above |

Three facts about that tokenised address: (1) it is **local-only** (`127.0.0.1`; the phone uses the domain plus the
password, and the reverse proxy exchanges the token for you); (2) the session cookie it grants lasts **30 days** and
survives closing the browser and restarting DSH; (3) but the **token itself is per DSH process** and dies on every
restart — so use the *current* one (the card always shows the latest); bookmarking one for later does not work.

### 6) How you know recovery worked

- port 3080 is LISTENING
- `service.log` contains `port 3080 is up`
- the card's "service" line says **running**

### 7) If you recently upgraded or moved DSH

`config.json` stores an **absolute path captured at the time** (it may contain an npx cache hash directory such as
`…\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js`). After an upgrade or a move that path can go stale, and
**autostart then fails silently** (nothing happens at login). Open the settings card and **click Enable again** so the
current command is captured.

## Uninstall

1. **Disable boot autostart in the settings page first** (this removes the registry entry)

   > This step is **required**, not optional. Two reasons: (1) the registry entry points at
   > `~/.dsh/dsh-autostart/bootstrap.vbs`, and that file and `config.json` live **outside** the plugin directory, so
   > removing the plugin does not delete them; (2) `pnpm remove` **keeps** the `node_modules/dsh-autostart` symlink, so
   > this plugin's `service.js` is still reachable — and that reachability is exactly the plugin's cleanup test. So
   > **uninstalling without disabling first leaves a dead entry** (it runs once at login and fails silently). Deleting
   > `DSH autostart` from `HKCU\...\Run` by hand afterwards works too.
   >
   > Note: Settings → Plugins has **no** uninstall button for this plugin (that page only manages plugins installed from
   > the markets), so step 2's command line is the normal path.
2. Remove the plugin: `dsh plugin --profile web remove dsh-autostart`
3. To clean up completely, delete `~/.dsh/dsh-autostart/` by hand

## Why it is built this way

- **Why `wscript.exe` instead of `powershell -WindowStyle Hidden`**: the latter is unreliable for long-running scripts and leaves an empty console window that cannot be closed.
- **Why waiting uses conditional polling instead of a fixed `Start-Sleep`**: a fixed wait once made a single restart take over 80 seconds; conditional polling brought it down to a few seconds.
- **Why the port check uses a TCP connection instead of a `netstat`/`:port` substring**: substring matching also hits `TIME_WAIT` and client connections, so it reported "already running" when nothing had actually started.
- **Why the logic is Node rather than PowerShell**: Chinese text in PowerShell scripts tends to hit encoding problems, and execution policy gets in the way.
- **Why `--no-open` is mandatory**: DSH `0.1.2-rc.1` mints a new token on every start and prints the access URL to stdout; the plugin captures it into the log and shows it in the settings page, so opening a browser at boot is neither needed nor wanted.
