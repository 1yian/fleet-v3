# Fleet Setup Playbook (Agent-Executable & Harness-Agnostic)

This playbook is designed to be read and executed directly by any agent (Pi/`ypi`, Claude Code, Codex, Grok Bot, or a human operator) to set up `fleet-v3` on a local machine, on remote SSH execution hosts, and for `1stmate`, optional `2ndmate`s, and `crewmates`.

---

## 0. Explain Fleet & Interview the Captain First

Before writing any config or starting services, briefly explain what Fleet is to the user in plain language:

- **Card Server (`fleet serve`)**: one tiny SQLite HTTP + SSE server (lives under `~/.fleet`) that holds every card, thread, charter, and lease.
- **`1stmate`**: your single main entry point (`parent: captain`). You talk to `1stmate`; it can do quick work inline, delegate to domain `2ndmate`s, or spin up isolated `crewmates`.
- **`2ndmate`s (optional)**: a `2ndmate` is the exact same primitive as `1stmate`, except it explicitly owns a single domain/project with its own charter and escalates up to `1stmate`.
- **`crewmates`**: ephemeral coding workers launched by `fleet run` in isolated git worktrees (interactively visible in `herdr` panes on your workstation, headless on remote SSH hosts) with capped 4-round `no-mistakes` verification.

Then inspect the machine (`ls ~/Projects`, check installed tools: `node -v`, `bun`, `herdr`, `ypi`, `pi`, `claude`) and ask the captain **only** what you cannot infer:

1. **What harness do you want for `1stmate`?**
   - **Coding harness:** `pi` / `ypi` or **Claude Code** (you launch `1stmate` with one command right from the `fleet-v3` git checkout).
   - **Non-coding / chat harness:** **Grok Bot**, **Dots**, **Muse**, or another webhook-capable bot (wired via `fleet watch --mate 1stmate --webhook <url>`).
2. **What harness do you want for `crewmates`?**
   - **Coding harnesses only** (`pi` / `ypi` or **Claude Code** for now). Confirm whether local `crewmates` should open interactively in `herdr` panes (`viewport: herdr`, recommended on macOS/desktop) or run `headless`.
3. **Do you want any optional `2ndmate`s?**
   - Remind them that `2ndmate`s are just `1stmate`s scoped to one domain.
   - If yes: which domains/repos, and which harness per `2ndmate`? (Note: Grok Bot supports running multiple bot instances if they want non-coding `2ndmate`s there; Dots and Muse may be single-instance, so verify multi-bot support before promising multiple `2ndmate`s on Dots/Muse.)
4. **Which machines and repos?**
   - Is this machine the Control Host, an execution host, or both?
   - Any remote SSH execution hosts (e.g. GPU box or Linux dev VM)?
   - Which local repos to register under `repos:` and their default delivery (`no-mistakes`, `direct-pr`, or `local`).

### Non-negotiable hook hygiene rule

**Never install Fleet hooks or extensions globally** into `~/.pi/agent/extensions/` or `~/.claude/`.

- For **`1stmate`** on a coding harness: configure gitignored local files inside the `fleet-v3` checkout so running one command (`ypi` or `claude ...`) from the checkout opens `1stmate` directly.
- For **`2ndmate`s** and **`crewmates`** on coding harnesses: inject adapters/channels/prompts **strictly via their launch command** in `~/.fleet/fleet.yaml`.
- All mutable runtime state (`fleet.yaml`, `board/`, `mates/`, `optchat/`, `workspaces/`, `logs/`) lives under **`~/.fleet`** (never inside the `fleet-v3` git checkout, so worker worktrees never inherit `fleet-v3/AGENTS.md` or `node_modules/`).

---

## 1. Install `fleet` on a Machine (Local or Remote SSH Host)

Prerequisites:

- Node.js >= 24 (for built-in `node:sqlite`) and `bun`
- `git`
- Optional: `herdr` (interactive `crewmate` & `2ndmate` panes), `direnv`, `docker` (Linux) or Apple `container` (macOS 26+ Apple Silicon), and `no-mistakes`

Install:

```bash
git clone https://github.com/1yian/fleet-v3.git ~/Projects/fleet-v3
cd ~/Projects/fleet-v3
bun install
mkdir -p ~/.local/bin
ln -sf "$PWD/src/bin.ts" ~/.local/bin/fleet
chmod +x "$PWD/src/bin.ts"
fleet --version
```

Verify `node -v` is >= 24 and `~/.local/bin` is on `PATH`.

---

## 2. Create `~/.fleet/fleet.yaml` and Start the Control Host

Once `~/.fleet/fleet.yaml` exists, bare `fleet`, `fleet serve`, `fleet run`, and `fleet mates up` discover it automatically (no `--config` flag required). Relative paths inside `fleet.yaml` resolve against `~/.fleet` regardless of `cwd`.

Initialize `~/.fleet`:

```bash
mkdir -p ~/.fleet/logs ~/.fleet/workspaces ~/.fleet/mates ~/.fleet/board
fleet init --config ~/.fleet/fleet.yaml
```

Write `~/.fleet/fleet.yaml` (example for a single workstation running Card Server, local runner, `1stmate`, and one optional `2ndmate`):

```yaml
host: macbook
boardUrl: http://127.0.0.1:4100
matesFilter: []
workspacesRoot: ./workspaces
concurrency: 4
leaseSeconds: 900
idleTimeoutSeconds: 1800
maxWallSeconds: 7200
maxAttempts: 3
maxReviewRounds: 4

server:
  host: 127.0.0.1
  port: 4100
  dataDir: ./board
  chaseIntervalSeconds: 120
  staleAfterSeconds: 120

spawn:
  mode: local
  viewport: herdr
  direnv: true
  herdr:
    workspace: crewmates
    keepPane: on-failure
  command:
    - ypi
    - --auto-exit
    - --no-session
    - --append-system-prompt
    - "{prompt}"
    - "Read card #{card} with `fleet view {card} --full` and execute it."

mates:
  workspace: 2ndmates
  stateDir: ./mates
  command:
    - ypi
    - --model
    - tier/orchestrator
    - -e
    - "{adapter}"
    - --append-system-prompt
    - "{prompt}"
  items:
    - name: 1stmate
      parent: captain
      cwd: ~/Projects/fleet-v3
      autoStart: false
    - name: cleo
      parent: 1stmate
      cwd: ~/Projects/Cleo
      autoStart: true

repos:
  Cleo:
    path: ~/Projects/Cleo
    baseBranch: main
    delivery: no-mistakes
```

`spawn.mode` is `local`, `container` (macOS), or `docker` (Linux), and `spawn.viewport` is `herdr` or `headless`. The `spawn.command` above is the `ypi` / `pi` crewmate; replace it with the Claude Code form below when the captain chooses Claude Code.

**If the captain chose Claude Code for `crewmates`**, set `spawn.command` to inject the worker prompt via CLI flags (no global hooks):

```yaml
command:
  - claude
  - --append-system-prompt-file
  - "{prompt}"
  - -p
  - "Read card #{card} with `fleet view {card} --full` and execute it."
```

**Container / Docker workers note:** Inside a container or Apple `container` micro-VM, `127.0.0.1` is the guest loopback. Set `server.host` to a reachable interface (e.g. Tailscale IP or `0.0.0.0` behind your private firewall) and point `boardUrl` at that address.

Start and verify the Control Host + optional Kanban UI + local runner:

```bash
fleet serve
fleet web --host 127.0.0.1 --port 4101
fleet run
```

Verify:

```bash
curl -sf http://127.0.0.1:4100/api/health
fleet hosts
```

Seed captain preferences and charters:

```bash
fleet prefs --set "Keep replies concise. Never force-ship unverified code."
fleet charter 1stmate --set "You are 1stmate (parent: captain). Handle quick work inline, delegate domain work to 2ndmates, or dispatch crewmates."
fleet charter cleo --set "You are the Cleo 2ndmate (parent: 1stmate). Own ~/Projects/Cleo."
```

---

## 3. Wire Up `1stmate` (Main Entry Point)

Pick the block matching the captain's `1stmate` harness choice:

### Option A: `ypi` / `pi` as `1stmate` (single command from the git checkout)

Create gitignored local files inside `~/Projects/fleet-v3/.pi/` (never in `~/.pi/agent/extensions/`):

```bash
mkdir -p ~/Projects/fleet-v3/.pi/extensions
cat > ~/Projects/fleet-v3/.pi/extensions/fleet.ts <<'EOF'
process.env["FLEET_MATE"] ??= "1stmate";
export { default } from "../../src/adapters/pi.ts";
EOF
```

Now the captain simply runs:

```bash
cd ~/Projects/fleet-v3 && ypi
```

`src/adapters/pi.ts` automatically loads `prompts/mate.md`, injects live ambient context, subscribes to `1stmate`'s SSE stream, and stays idempotent if a `fleet-v3` `2ndmate` launches with `FLEET_MATE=fleet-v3`.

### Option B: Claude Code as `1stmate` (native Channel MCP from the git checkout)

Create gitignored `~/Projects/fleet-v3/.mcp.json` (never globally in `~/.claude/`):

```bash
cat > ~/Projects/fleet-v3/.mcp.json <<'EOF'
{
  "mcpServers": {
    "fleet": {
      "command": "fleet",
      "args": ["channel", "--mate", "1stmate"]
    }
  }
}
EOF
```

Launch `1stmate` from the checkout:

```bash
cd ~/Projects/fleet-v3 && FLEET_MATE=1stmate claude \
  --dangerously-load-development-channels server:fleet \
  --append-system-prompt-file ./prompts/mate.md
```

_(Claude Code Channels are in research preview; Team/Enterprise orgs must allow `channelsEnabled`.)_

### Option C: Non-coding harness (`Grok Bot`, `Dots`, `Muse`, or any webhook bot)

1. Give the bot `prompts/mate.md` as its system instructions, `fleet` on `PATH`, `BOARD_URL` set to the Card Server address reachable from the bot (the `boardUrl` in `~/.fleet/fleet.yaml`), and `FLEET_MATE=1stmate`.
2. Run `fleet watch` to push filtered wakes straight to the bot's HTTP webhook:

```bash
fleet watch --mate 1stmate --webhook https://bot.example.com/wake --header "Authorization: Bearer <token>"
```

_(If your bot consumes a pipe instead of HTTP, run bare `fleet watch --mate 1stmate` for filtered NDJSON lines. Each line, and each webhook POST body, is exactly `{ mate, notice, eventType, cardId?, actor? }`.)_

---

## 4. Wire Up Optional `2ndmate`s

Each `2ndmate` uses `parent: 1stmate` in `~/.fleet/fleet.yaml` and gets its own charter via `fleet charter <name> --set "..."`:

- **`ypi` / `pi` `2ndmate`s in Herdr (launch-command injected):**
  Run:
  ```bash
  fleet mates up
  fleet mates status
  ```
- **Claude Code `2ndmate`s in Herdr (launch-command injected, no global hooks):**
  Write a per-mate MCP file at `~/.fleet/mates/<name>/mcp.json` with `fleet channel --mate <name>`, and override `command` on that mate item in `fleet.yaml`:
  ```yaml
  - name: cleo
    parent: 1stmate
    cwd: ~/Projects/Cleo
    command:
      - claude
      - --mcp-config
      - "{stateDir}/mcp.json"
      - --dangerously-load-development-channels
      - server:fleet
      - --append-system-prompt-file
      - "{prompt}"
  ```
- **Non-coding `2ndmate`s (e.g. multiple Grok Bot instances):**
  Add each bot to `mates.items` in `~/.fleet/fleet.yaml` with `autoStart: false` so `fleet mates up` never launches a second agent for the bot's identity, then run one `fleet watch --mate <name> --webhook <bot-webhook-url>` service per `2ndmate` bot instance.

---

## 5. Add Remote SSH Execution Hosts (Optional)

A remote host (e.g. `p620` or Linux dev VM) only needs `fleet` + a tunnel to the Control Host + `fleet run`:

1. **Tunnel Card Server from Control Host -> Remote Host:**
   ```bash
   ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:4100:127.0.0.1:4100 user@remote-host
   ```
   _(Or expose `server.host` on a private Tailscale IP and point `boardUrl` directly at `http://<tailscale-ip>:4100`.)_
2. **On the remote host:** follow Section 1 (`fleet --version`), verify `curl -sf http://127.0.0.1:4100/api/health`, write `~/.fleet/fleet.yaml` with that host's unique `host:` name, `boardUrl: http://127.0.0.1:4100`, `spawn.viewport: headless` (or `herdr`), and its local `repos:`, then run `fleet run`.
3. Verify `fleet hosts` lists both the local and remote hosts.

---

## 6. Reboot Persistence Templates

### macOS (`launchd`)

Create `~/Library/LaunchAgents/dev.fleet.board.plist` (repeat with `run` for `dev.fleet.runner.plist`, `web --host <ip> --port 4101` for `dev.fleet.kanban.plist`, and `watch --mate 1stmate --webhook <url>` if using a webhook bot):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.fleet.board</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>FLEET_CONFIG</key>
    <string>/Users/YOU/.fleet/fleet.yaml</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/fleet</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/Users/YOU/.fleet/logs/board.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.fleet/logs/board.log</string>
</dict>
</plist>
```

The `fleet` launcher finds `node` through the `PATH` above, so make sure that `PATH` includes the directory printed by `dirname "$(which node)"`.

Load with `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.fleet.board.plist` (start `board` before `runner` and `kanban`).

### Linux (`systemd --user`)

Create `~/.config/systemd/user/fleet-board.service` (and `fleet-runner.service` with `ExecStart=%h/.local/bin/fleet run`, `After=fleet-board.service`):

```ini
[Unit]
Description=Fleet Card Server
After=network-online.target

[Service]
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=FLEET_CONFIG=%h/.fleet/fleet.yaml
ExecStart=%h/.local/bin/fleet serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now fleet-board fleet-runner
loginctl enable-linger "$USER"
```

---

## 7. End-to-End Smoke Test

Verify every piece directly before handing back to the captain. First confirm the Card Server and runners are healthy:

```bash
curl -sf http://127.0.0.1:4100/api/health
fleet hosts
```

Then wake a mate (`1stmate` or a `2ndmate`) and confirm it handles and closes the card:

```bash
fleet dispatch --mate 1stmate --title "Smoke test: reply ok and close this card"
```

Read the card id printed by `dispatch`, wait for the mate to handle it, then inspect that exact card and confirm its state is closed:

```bash
fleet view <card-id> --full
```

Finally verify crewmate worktree execution on a local repo:

```bash
FLEET_MATE=1stmate fleet dispatch --project Cleo --host macbook --delivery local --title "Smoke test: print git status and exit cleanly"
```
