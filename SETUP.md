# Fleet Setup Guide (Harness-Agnostic)

This guide gives any agent or operator (Pi, Claude Code, Codex, Grok Bot, Dots, or a human) the exact steps to install and wire up `fleet-v3` on a local machine, on remote SSH execution hosts, and for permanent mates.

## Architecture at a glance

Three decoupled pieces talk only over HTTP + SSE:

1. **Card Server (`fleet serve`)** - one instance per fleet, owns SQLite (`cards`, `entries`, `events`), charters, prefs, leases, SSE, and stale chase. Default `http://127.0.0.1:4100`.
2. **Execution Runner (`fleet run`)** - one instance per execution host (local laptop, GPU box, remote SSH dev VM). Advertises its repos, claims queued cards for its `host`, runs ephemeral isolated workers, runs capped 4-round `no-mistakes` verification, and cleans up.
3. **Mates (`fleet mates up` or any BYO harness)** - persistent domain agents (`parent: captain` for top-level executive mate, `parent: <mate>` for child domain mates). Any harness that runs `fleet` CLI commands and wakes on `GET $BOARD_URL/api/events?holder=$FLEET_MATE` is a first-class mate.
4. **Kanban UI (`fleet web`, optional)** - standalone visual viewport proxying to `BOARD_URL`. Default `http://127.0.0.1:4101`.

---

## 1. Install `fleet` on a machine (local or SSH host)

Prerequisites:

- Node.js >= 24 (for built-in `node:sqlite`) and `bun` (for install/check)
- `git`
- Optional: `herdr` (for interactive terminal panes), `direnv`, `docker` (Linux) or Apple `container` (macOS 26+ Apple Silicon), and `no-mistakes` (for 4-round verification)

Install:

```bash
git clone https://github.com/1yian/fleet-v3.git ~/Projects/fleet-v3
cd ~/Projects/fleet-v3
bun install
ln -sf "$PWD/src/bin.ts" ~/.local/bin/fleet
chmod +x "$PWD/src/bin.ts"
fleet --version
```

Verify `node -v` is >= 24 and `~/.local/bin` is on `PATH`.

---

## 2. Set up the Control Host (Card Server + Kanban)

Create `~/.fleet-v3/fleet.yaml` (start from `fleet.example.yaml` via `fleet init --config ~/.fleet-v3/fleet.yaml`).
`fleet serve` only needs `server` and `mates` (it does not require runner `host`/`spawn`/`repos`):

```yaml
boardUrl: http://127.0.0.1:4100

server:
  host: 127.0.0.1
  port: 4100
  dataDir: ~/.fleet-v3/board
  chaseIntervalSeconds: 120
  staleAfterSeconds: 120

mates:
  items:
    - name: jarvis
      parent: captain
      cwd: ~/.fleet-v3
      autoStart: true
    - name: cleo
      parent: jarvis
      cwd: ~/fleet-projects/Cleo
      autoStart: true
    - name: cnp
      parent: jarvis
      cwd: ~/cnp
      autoStart: true
```

Start the Card Server and Kanban UI (in foreground for testing, or via `launchd` on macOS / `systemd` on Linux):

```bash
fleet serve --config ~/.fleet-v3/fleet.yaml
fleet web --host 127.0.0.1 --port 4101
```

Verify:

```bash
curl -sf http://127.0.0.1:4100/api/health
fleet
```

### Seed charters and captain preferences

Charters define each mate's autonomy boundaries, repos, hosts, and escalation rules in plain Markdown:

```bash
fleet prefs --set "Keep replies concise. Never force-ship unverified code."
fleet charter jarvis --set "You are Jarvis (parent: captain). Coordinate domain mates via fleet dispatch --mate <child>."
fleet charter cleo --set "You own Cleo. Handle fast ops/fixes inline; use fleet dispatch --project Cleo --host p620 for heavy PRs."
```

---

## 3. Set up a Local Execution Runner

Add `host`, `spawn`, `repos`, and limits to `~/.fleet-v3/fleet.yaml` (one file can serve `serve`, `mates`, and `run`, or keep them separate):

```yaml
host: macbook
boardUrl: http://127.0.0.1:4100
workspacesRoot: ~/fleet-workspaces
concurrency: 4
leaseSeconds: 900
idleTimeoutSeconds: 1800
maxWallSeconds: 7200
maxAttempts: 3
maxReviewRounds: 4

spawn:
  mode: local # local | container (macOS Apple container) | docker (Linux)
  viewport: herdr # herdr | headless
  direnv: true
  command:
    - ypi # or: claude -p, codex, etc.
    - --auto-exit
    - --no-session
    - --append-system-prompt
    - "{prompt}"
    - "Read card #{card} with `fleet view {card} --full` and execute it."
  herdr:
    workspace: workers
    keepPane: on-failure

repos:
  Cleo:
    path: ~/fleet-projects/Cleo
    baseBranch: main
    delivery: no-mistakes
```

Start the runner and verify it advertises its host and repos:

```bash
fleet run --config ~/.fleet-v3/fleet.yaml
fleet hosts
```

**Container / Docker workers note:** Inside a container or Apple `container` micro-VM, `127.0.0.1` is the guest loopback, not the host. If `spawn.mode` is `container` or `docker`, bind `server.host` to a reachable interface (e.g. Tailscale IP or `0.0.0.0` behind your private firewall) and set `boardUrl` to that reachable host address.

---

## 4. Set up a Remote SSH Execution Host

A remote machine (e.g. `p620` or `cnp-devvm`) only needs the `fleet` CLI, a tunnel to the control host's Card Server, and `fleet run`:

### Step A: Tunnel the Card Server over SSH (from control host)

Forward the control host's `127.0.0.1:4100` to `127.0.0.1:4100` on the remote host (run via `autossh`, `launchd`, or `systemd`):

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:4100:127.0.0.1:4100 user@remote-host
```

_(Or expose the Card Server directly over your private Tailscale IP and point `boardUrl` at `http://<tailscale-ip>:4100` with no SSH tunnel.)_

### Step B: Configure and start `fleet run` on the remote host

1. Install `fleet` on the remote host (Section 1) and verify `curl -sf http://127.0.0.1:4100/api/health`.
2. Create `~/.fleet-v3/fleet.yaml` on the remote host with its unique `host:` name (e.g. `p620` or `cnp-devvm`), `boardUrl: http://127.0.0.1:4100`, `spawn.viewport: headless` (or `herdr` if Herdr runs there), and its local `repos:` paths.
   - Optional: set `matesFilter: [cnp]` if this host should only execute cards for specific mates.
3. Run `fleet run --config ~/.fleet-v3/fleet.yaml` (under `systemd --user` on Linux or `launchd` on macOS).
4. Back on any machine, verify `fleet hosts` now lists the remote host and its repos.

---

## 5. Set up Permanent Mates (First Mate & Second Mates)

Every mate in the hierarchy uses the exact same contract. You can mix harnesses freely (for example, Grok Bot as `jarvis` + `ypi` in Herdr as `cleo` + Claude Code as `cnp`).

### Option A: Interactive Herdr panes via `fleet mates up` (recommended for Pi / ypi)

Configure `mates:` in `~/.fleet-v3/fleet.yaml`:

```yaml
mates:
  workspace: mates
  stateDir: ~/.fleet-v3/mates
  command:
    - ypi
    - --model
    - tier/orchestrator
    - -e
    - "{adapter}"
    - --append-system-prompt
    - "{prompt}"
  env:
    YPI_OPTCHAT_CONFIG: "{stateDir}/optchat.json"
  items:
    - name: jarvis
      parent: captain
      workspace: jarvis
      cwd: ~/.fleet-v3
      autoStart: true
    - name: cleo
      parent: jarvis
      cwd: ~/fleet-projects/Cleo
      autoStart: true
    - name: cnp
      parent: jarvis
      cwd: ~/cnp
      env:
        PI_TIERS_RULE: cnp
      autoStart: true
```

Start or check mates idempotently:

```bash
fleet mates up --config ~/.fleet-v3/fleet.yaml
fleet mates status --config ~/.fleet-v3/fleet.yaml
```

Start an on-demand mate (`autoStart: false`) by name:

```bash
fleet mates up personal --config ~/.fleet-v3/fleet.yaml
```

### Option B: Any BYO harness (Grok Bot, Claude Code, Codex, Dots, OpenClaw)

To run any agent harness as a mate (e.g. `jarvis` or `cleo`):

1. Ensure `fleet` is on the harness's `PATH`.
2. Export two environment variables:
   ```bash
   export BOARD_URL=http://127.0.0.1:4100
   export FLEET_MATE=jarvis
   ```
3. Include `prompts/mate.md` in the agent's system prompt/instructions.
4. Connect a tiny stateless wake bridge to the mate's SSE stream (do **not** run an LLM cron loop):
   ```text
   GET $BOARD_URL/api/events?holder=$FLEET_MATE
   ```
   Pass `Last-Event-ID: <last_id>` on reconnect so zero events are lost. Forward each incoming JSON event (skipping `event.actor === FLEET_MATE` and internal replies) as a short wake message into the harness's ingress (webhook, Discord DM, RPC, or terminal input).

---

## 6. End-to-End Smoke Test

Verify the full chain without guessing:

```bash
# 1. Confirm Card Server and runners are healthy
fleet hosts

# 2. Dispatch a card to a domain mate (lands held with cleo; wakes cleo via SSE)
fleet dispatch --mate cleo --title "Smoke test: reply with current git HEAD and close"

# 3. Inspect progress and confirm cleo closes it cleanly
fleet cards
fleet view 1 --full
```

If using a runner, verify worker isolation with a harmless repo card:

```bash
FLEET_MATE=cleo fleet dispatch --project Cleo --host macbook --delivery local --title "Smoke test: print git status and exit cleanly"
```

---

## 7. Keep Services Running Across Reboots

- **macOS (`launchd`)**: create user agents under `~/Library/LaunchAgents/` for:
  - `fleet serve --config ~/.fleet-v3/fleet.yaml`
  - `fleet web --host 127.0.0.1 --port 4101`
  - `fleet run --config ~/.fleet-v3/fleet.yaml`
  - any SSH `-R` tunnels to remote execution hosts
- **Linux (`systemd --user`)**: create user services under `~/.config/systemd/user/` with `Restart=always` and enable lingering (`loginctl enable-linger "$USER"`).
- **Mates**: run `fleet mates up --config ~/.fleet-v3/fleet.yaml` on startup or anytime; it is idempotent and skips already-running panes.
