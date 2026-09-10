# dsh-autostart

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

- Windows 10 / 11
- Node.js ≥ 20 (shipped with DSH)
- DeepSeek Harness ≥ `0.1.0-rc.6` (tested on `0.1.2-rc.1`)

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

> **Changing this plugin's config disposes the plugin.** Adding `allowedHosts` (or editing any other field) causes DSH to
> reload the plugin: the old instance is disposed, and **dispose removes the `DSH autostart` registry entry** it owns.
> That is intentional — the entry must never outlive the plugin — but it means you have to **open the settings card and
> enable autostart again** after any config change. Re-enabling is idempotent.

## Generated files

```
~/.dsh/dsh-autostart/
├── config.json               # the real launch command, read by service.js
├── bootstrap.vbs             # boot entry point (wscript, no window)
├── dsh-web-server.log        # DSH stdout (contains the access URL)
├── dsh-web-server.err.log
└── service.log               # helper log; look here first when debugging
```

## Uninstall

1. **Disable boot autostart in the settings page first** (this removes the registry entry)

   > If the plugin is uninstalled while the registry entry is still there, that entry points at a script that no longer exists. On `dispose` the plugin removes the entry **only when it still points at this plugin's `bootstrap.vbs`**; otherwise it leaves it alone.
2. Remove the plugin: `dsh plugin --profile web remove dsh-autostart`
3. To clean up completely, delete `~/.dsh/dsh-autostart/` by hand

## Why it is built this way

- **Why `wscript.exe` instead of `powershell -WindowStyle Hidden`**: the latter is unreliable for long-running scripts and leaves an empty console window that cannot be closed.
- **Why waiting uses conditional polling instead of a fixed `Start-Sleep`**: a fixed wait once made a single restart take over 80 seconds; conditional polling brought it down to a few seconds.
- **Why the port check uses a TCP connection instead of a `netstat`/`:port` substring**: substring matching also hits `TIME_WAIT` and client connections, so it reported "already running" when nothing had actually started.
- **Why the logic is Node rather than PowerShell**: Chinese text in PowerShell scripts tends to hit encoding problems, and execution policy gets in the way.
- **Why `--no-open` is mandatory**: DSH `0.1.2-rc.1` mints a new token on every start and prints the access URL to stdout; the plugin captures it into the log and shows it in the settings page, so opening a browser at boot is neither needed nor wanted.
