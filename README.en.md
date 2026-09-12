# dsh-autostart

English | [中文](README.md)

A Windows-only DeepSeek Harness plugin: one-click boot autostart and one-click restart, where **a failed restart leaves DSH running instead of taking it down** — with no console window at any point.

## ⚠️ Disclaimer (read first)

**Verify your environment before installing. The author is not liable for lost conversation history, interrupted tasks, or damaged data.**

Restarting kills the DSH host process that runs your conversations and agent turns:

- Restarting while an agent is mid-turn → that turn is hard-interrupted and its result may never be written to disk
- A conversation not yet flushed to `~/.dsh/sessions/` → that history may be lost and is not recoverable
- Tasks running in parallel sessions are interrupted too

Before you use it: (1) verify the environment yourself (Windows version, Node, DSH version, whether security software blocks registry writes); (2) make sure no important task is running before you restart; (3) back up `~/.dsh/sessions/` for important conversations; (4) decide for yourself whether to enable boot autostart (it writes to `HKCU\...\Run`).

The software is provided "as is" (MIT License, no warranty of any kind).

## Why you want it

Restarting a program is easy; **coming back after the restart is the hard part**. This plugin makes that a guarantee:

1. **A failed restart leaves DSH running, not dead.** Before letting DSH exit, the plugin (a) makes sure a *supervisor* — the process that will bring DSH back — is alive, and (b) writes the restart request to disk and **reads it back to prove it landed**. If either step fails, it refuses the restart, leaves DSH untouched, and says why. This is a real bug that used to happen: the port had not been released yet, one probe gave up, and DSH stayed down.

2. **No console window, ever.** DSH is launched attached to a **hidden console owned by the supervisor**, so every command DSH spawns shares it instead of creating a fresh Windows Terminal window — the old behaviour was one black window per tool call.

3. **The supervisor is not a watchdog.** It stays resident, but it only starts a replacement when the exit was a restart *you asked for*. Close DSH yourself and it quietly finishes — a process you cannot stop is worse than a service that occasionally does not come back.

4. **Disabling or uninstalling never ambushes the DSH you are using.** Disabling autostart only removes the next-login entry; DSH keeps running for the rest of this session, and the supervisor steps aside after DSH exits on its own.

5. **Failures are diagnosable.** Every step is written to `service.log`, and a failure states its cause instead of silently doing nothing.

## Requirements

- Windows 10 / 11 (`Win32_Process.Create` must work through PowerShell — when you click restart and no supervisor is
  running yet, one is deliberately created by the WMI service, so that it is not killed together with the host)
- Node.js ≥ 20 (shipped with DSH)
- DeepSeek Harness ≥ `0.1.0-rc.6` (tested on `0.1.2-rc.1`; the job-object behaviour the restart depends on was measured on `0.1.5-rc.1`)
- A writable `HKCU\...\Run` for autostart — security software that blocks registry writes makes "enable" fail

### Environment and restart

DSH is started by a **resident supervisor** — `node service.js start --config <config.json>`, launched by
`bootstrap.vbs` at login (`start` is an alias of `supervise`, which is the real entry point; the generated
bootstrap.vbs uses `start`). The supervisor is what outlives DSH: it learns of DSH's exit from its child handle, and
starts the replacement when the exit was a restart you asked for.

When you click restart and **no supervisor is running yet** (for example you started DSH by hand), one has to be
created from inside DSH first. That is the only moment the **WMI service** is involved: DSH runs its
subprocesses inside a Windows Job Object created kill-on-close, so a merely "detached" process is killed the instant
DSH exits — leaving DSH down. Having WMI create the supervisor is what lets it out of that job and lets it outlive
the host. Once a supervisor exists (the normal case at login, and every restart after the first), WMI is not used.

One consequence: a process created that way does **not** inherit your environment. So:

- the supervisor is told where `config.json` lives explicitly (`--config <absolute path>`), instead of
  re-deriving the DSH home from `DSH_HOME` (which would be missing);
- the restarted instance re-asserts `DSH_HOME` from the `dshHome` captured in `config.json`.

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
| Restart service | Restarts after a confirmation; DSH is back within seconds. It first makes sure a supervisor is running to bring DSH back, and refuses the restart if none can be started |
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
    exitDelayMs: 800               # delay before the old host exits on restart; clamped to 5000 max (see below)
    waitForExitMs: 30000           # UNUSED since the supervisor replaced the old restart path — kept only so an
                                   # existing config.json that sets it still loads
    startTimeoutMs: 30000
    openBrowserOnBoot: false       # true = open the browser on boot
    blockWhenAgentsRunning: false  # true = refuse to restart while an agent is running
    allowedHosts: []               # for reverse-proxy access, add your domain (must be opted in), e.g. ['derp.example.com']
```

> **`exitDelayMs` is clamped at 5000 ms.** The delay only exists to let the restart response flush before the old host
> exits, and a freshly started supervisor waits only 30 s (`DEFAULT_TAKEOVER_EXIT_MS`) for that host to exit. A delay
> past that window would make the takeover give up, turning a restart into a shutdown — so values above 5000 are
> clamped to 5000 at the point of use, not rejected (`index.js`, `MAX_EXIT_DELAY_MS`).

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
> `hookScript`, `dshPort` and `startTimeoutMs` are **snapshotted into `config.json` when you click
> Enable**, and the supervisor reads `config.json`, not the plugin's live config. So after changing them you **must open the
> settings card and enable autostart again** (re-enabling is idempotent). Measured on a real install: changing
> `hookScript` and only restarting the service left the old value in `config.json`, so the hook never ran.
> `allowedHosts` is different — it only affects the plugin's route guard and takes effect on reload.
> `waitForExitMs` is snapshotted too, but is no longer read by anything (see the note in the config example above).
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
├── bootstrap.vbs             # boot entry point: launches the resident supervisor (wscript, no window)
├── dsh-web-server.log        # DSH stdout (contains the access URL)
├── dsh-web-server.err.log
├── service.log               # supervisor log; look here first when debugging
├── supervise.pid             # the supervisor's own pid (single-instance guard)
├── restart.request           # written by a restart; names the DSH the supervisor saw exit
└── supervise.stop            # tells a running supervisor to stop once DSH is gone
```

The last three are transient state files: they are created and deleted as needed (all best-effort), and their absence
is normal. They are not all cleared the same way, though. `supervise.pid` and `supervise.stop` are removed whenever
the supervisor that owns them acts on them, but a `restart.request` is consumed only when the DSH it names actually
exits — so a request from a restart that was refused, or that never reached that exit, can survive on disk until the
next matching exit picks it up.

## If the service will not start (recovery)

**The card lives inside DSH's page — so when DSH is down you cannot open the card.** Recovery therefore has to be
command-line. Work down this list.

### 0) Wait a few minutes first — the supervisor retries in place

DSH is started by the **resident supervisor** — the login autostart entry *is* the supervisor, so it is always there
when DSH is supposed to be. When a new instance does not come up, the supervisor does not simply give up:

1. It **retries in place**, with the interval growing 1s → 1.5s → 2.25s → …, up to **5 attempts** and a
   **5-minute budget**. Each attempt also waits `startTimeoutMs` (30s by default) for the port — so the budget plus
   the final attempt's own wait is the longest you can be waiting, and the loop normally ends earlier than the
   budget. It only retries once the failed child is **really gone** — while one is still alive it will not start a
   competitor for the same port.
2. Nothing is scheduled for later: **the supervisor itself outlives the attempt**, so the retry happens inside the
   one process that is already watching the port.

So after a failure, **wait a few minutes before intervening by hand** — the budget is 5 minutes, plus the last
attempt's `startTimeoutMs`. The supervisor says what it is doing:

```
spawned dsh pid=… (attempt 2/5)                        # retrying
giving up: DSH did not come up after 5 attempt(s); supervisor exiting
```

The `giving up` line reports the number of attempts **actually made**, which is not always the configured cap of 5.

Only if all of that fails, continue below.

### About the resident supervisor (two things you must know)

1. **Its life and DSH's are the same.** DSH is spawned *attached* to the supervisor's hidden console (that sharing is
   what stops each command from opening a visible window), so when the supervisor exits, DSH goes with it.
2. **Disabling autostart does not stop it.** Disabling cancels the *login* autostart only — the supervisor and your
   running DSH keep going for the rest of this session, and simply will not come back at the next login.
   - Uninstalling additionally writes a stop marker, so a running supervisor will not linger once DSH next goes away.
   - **To end both immediately, close DSH** — the supervisor deliberately does not linger when its child exits
     normally. It restarts DSH only for a restart you asked for from the settings page; it is not a watchdog.
   - There is no `stop` mode in the CLI, and writing the stop marker does **not** stop the supervisor on the spot:
     the supervisor reads that marker only after its child (DSH) exits. That ordering is deliberate — disabling
     autostart must not close the DSH you are using. The only modes are `supervise` and its alias `start`.

### 1) Read the logs first

```
~/.dsh/dsh-autostart/service.log            # the supervisor's log: start here
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

It runs `<node> <service.js> start --config <config.json>` (`start` is an alias of `supervise`). That becomes the
resident supervisor, which owns a **hidden** console — DSH is spawned attached to it, so DSH has no visible window,
and its stdout is written to `~/.dsh/dsh-autostart/dsh-web-server.log` — on success a fresh token URL appears there.

> The supervisor **stays running for as long as DSH does** and keeps owning it. Do not kill it: it is DSH's parent,
> and when it exits DSH goes with it.

#### If you would rather run the CLI directly

```
node "<path to the plugin>\service.js" start --config "<absolute path to config.json>"
```

Both paths must be absolute (a bare `service.js` only resolves if your shell's cwd happens to be the plugin
directory). This does the same thing as the `bootstrap.vbs` form, but it ties DSH's life to the console you ran it
from: DSH is spawned **attached**, so closing that window terminates DSH — and the supervisor stays in the foreground
until DSH exits. If you use this form, leave the window open for as long as you want DSH up; otherwise prefer the
`bootstrap.vbs` form above, which gives the supervisor its own hidden console and returns immediately.

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
- **Why waiting for the port uses conditional polling instead of a fixed `Start-Sleep`**: a fixed wait once made a single restart take over 80 seconds; conditional polling (`waitForPort`, 250ms apart, bounded by `startTimeoutMs`) brought it down to a few seconds. The supervisor does **not** poll the DSH process it owns — it holds that child's handle and waits for its `exit` event. (Pids are still polled where there is no handle to hold: waiting for the outgoing DSH to exit on a takeover, and waiting for a new supervisor to claim `supervise.pid`.)
- **Why the port check uses a TCP connection instead of a `netstat`/`:port` substring**: substring matching also hits `TIME_WAIT` and client connections, so it reported "already running" when nothing had actually started.
- **Why the logic is Node rather than PowerShell**: Chinese text in PowerShell scripts tends to hit encoding problems, and execution policy gets in the way.
- **Why `--no-open` is mandatory**: DSH `0.1.2-rc.1` mints a new token on every start and prints the access URL to stdout; the plugin captures it into the log and shows it in the settings page, so opening a browser at boot is neither needed nor wanted.
