# Fleet Setup Playbook (Agent-Executable & Harness-Agnostic)

This playbook is designed to be executed directly by an agent (Pi/`ypi`, Claude Code, Grok Bot, Codex, or a human operator) setting up `fleet-v3`.

## Conversational Rules (Follow Strictly)

- **Ask ONE question at a time.** Never dump a multi-question survey or an upfront architecture lecture.
- **Explain a concept only when it is relevant to the current question** (1-2 plain sentences max).
- **Ask permission before installing dependencies** on any machine.
- **Never install Fleet hooks globally** into `~/.pi/agent/extensions/` or `~/.claude/`, and never commit mate hooks into the `fleet-v3` repo. All mutable state (`fleet.yaml`, `board/`, `1stmate/`, `mates/`, `optchat/`, `workspaces/`, `logs/`) lives under **`~/.fleet`**, except project clones, worktrees, and setup scripts, which live under `~/.fleet-v3/projects`.
- **Never download, install, or search for desktop installers for Grok Bot, Dots, or Muse.** Those are external bot platforms the captain already uses; hand them the [`EXTERNAL_BOT.md`](https://github.com/1yian/fleet-v3/blob/main/EXTERNAL_BOT.md) link so the bot configures itself (or if **you** are that bot running with shell access on the host, execute both `SETUP.md` and `EXTERNAL_BOT.md` directly without making the captain copy-paste).

---

## Step 1: Host the Fleet Service (Control Host)

Open the conversation with this exact framing (one question only):

> Welcome to Fleet. I'll set up the Fleet system for you. Fleet is a software factory runtime for your agents to do work (as crewmates) and orchestrate work (as firstmates).
>
> First, where do you want to host the Fleet service? This is where all work will be tracked, and it is recommended to host it on an always-on machine (this machine, or a remote SSH host).

Wait for the user's answer, then:

1. **Check connectivity and prerequisites** on the chosen host (`ssh` reachability if remote, plus `node -v` >= 24, `bun`, `git`).
2. Tell the user what is present vs. missing and **ask if it is OK to install missing dependencies and install `fleet`**.
3. Once approved, install `fleet` on the Control Host:
   ```bash
   git clone https://github.com/1yian/fleet-v3.git ~/Projects/fleet-v3
   cd ~/Projects/fleet-v3
   bun install
   mkdir -p ~/.local/bin
   ln -sf "$PWD/src/bin.ts" ~/.local/bin/fleet
   chmod +x "$PWD/src/bin.ts"
   fleet --version
   ```
   Verify `~/.local/bin` is on `PATH` and `node -v` >= 24.
4. Initialize `~/.fleet` and write the base `~/.fleet/fleet.yaml` (relative paths resolve against `~/.fleet` regardless of `cwd`):
   ```bash
   mkdir -p ~/.fleet/logs ~/.fleet/workspaces ~/.fleet/mates ~/.fleet/board
   fleet init --config ~/.fleet/fleet.yaml
   ```
   Configure `server:` (`host: 127.0.0.1` or private Tailscale IP if containers/remote bots need direct reachability, `port: 4100`, `dataDir: ./board`, `chaseIntervalSeconds: 120`, `staleAfterSeconds: 120`, `captainNagSeconds: 600`).
5. Start `fleet serve` (and install the `launchd` or `systemd` persistence unit from **Reference A** below so it stays up across reboots; optionally also start `fleet web --host 127.0.0.1 --port 4101` for Kanban) and verify:
   ```bash
   curl -sf http://127.0.0.1:4100/api/health
   ```
6. Seed default captain preferences if not yet set:
   ```bash
   fleet prefs --set "Keep replies concise. Never force-ship unverified code."
   ```

---

## Step 2: Set Up Firstmate (`1stmate`)

Now ask ONE question:

> Next, where do you want to run your Firstmate (`1stmate`)? Firstmate is the top-level coordinator for the fleet and has visibility into all work. It is recommended to use an always-on assistant that has context into your life (like Grok Bot or Dots), though it can also be a coding harness like Pi/`ypi` or Claude Code.

Wait for the user's answer, then follow the matching branch:

### Branch A: External / always-on bot (`Grok Bot`, `Dots`, `Muse`, or another webhook bot)

**Do NOT download or install Grok Bot, Dots, or Muse locally.**

1. Add `1stmate` with `mode: external` under `mates.items` in `~/.fleet/fleet.yaml`. The bot's platform runs it, so `fleet chat` reports status instead of launching it and `fleet mates up` skips it. `autoStart` defaults to `false` and cannot be `true`. Omit `mode` (or use `mode: local`) for a mate Fleet launches in a terminal.
   ```yaml
   mates:
     workspace: 2ndmates
     stateDir: ./mates
     items:
       - name: 1stmate
         parent: captain
         mode: external
   ```
2. Seed `1stmate`'s charter and run `fleet doctor`:
   ```bash
   fleet charter 1stmate --set "You are 1stmate (parent: captain). Handle quick work inline, delegate domain work to 2ndmates, or dispatch crewmates."
   fleet doctor
   ```
3. **Choose how the bot is woken.** Every external bot acts through the `fleet` CLI, so it needs `fleet` on `PATH` and a `BOARD_URL` it can reach. Only the wake path differs:
   - **Webhook bots (Grok Bot, Muse, any bot with an inbound webhook):** run `fleet watch --mate 1stmate --webhook <url>` on the Control Host.
   - **ChatGPT Dots (or any MCP Events client):** run `fleet events --mate 1stmate` on the Control Host and publish it through a public HTTPS tunnel. A Dot runs its shell in OpenAI's cloud, so give it the `fleet` CLI by connecting your own computer to the Dot (ChatGPT desktop app, dot profile, Computers, Allow) so `fleet` runs there with the local `BOARD_URL`. See [`EXTERNAL_BOT.md`](EXTERNAL_BOT.md) section 4 before exposing anything.
4. **Wire the bot:**
   - If **you are the external bot itself** running on the Control Host, read and execute [`EXTERNAL_BOT.md`](EXTERNAL_BOT.md) directly (create/configure the `1stmate` bot and its wake path) without asking the captain to copy-paste.
   - Otherwise, hand the captain this single ready-to-paste prompt (for Grok Bot, explicitly instructing it to create a dedicated `1stmate` bot):
     > Read `https://github.com/1yian/fleet-v3/blob/main/EXTERNAL_BOT.md` and create a dedicated `1stmate` bot for Fleet (`mate: 1stmate`). Use the `fleet` CLI for every action (`BOARD_URL: <board-url>`). Return the incoming webhook URL and auth header when ready (or, for a Dot, subscribe to the `card.wake` event of the Fleet events plugin).
5. Dispatch and hand off cards by mate name as usual. The `parent` field sets the mate's place in the routing tree, regardless of launch mode. To deliver that mate's Card Server wakes, start `fleet watch` once the bot returns its webhook URL (and install its persistence service from **Reference A**):

   ```bash
   fleet watch --mate 1stmate --webhook https://bot.example.com/wake --header "Authorization: Bearer <token>"
   ```

   _(Or bare `fleet watch --mate 1stmate` if the bot consumes NDJSON lines on stdout.)_ Use the matching [one-line wake prompt](templates/grok-bot.md) for each mate.

   For a Dot, start the events endpoint instead (and install its persistence service from **Reference A**), then publish it through your HTTPS tunnel:

   ```bash
   FLEET_EVENTS_TOKEN="$(openssl rand -hex 24)" fleet events --mate 1stmate --port 4102
   ```

6. Smoke-test `1stmate`:
   ```bash
   fleet dispatch --mate 1stmate --title "Smoke test: reply ok and close this card"
   ```
   Read the printed card ID, wait for `1stmate` to reply and close it, and confirm `state: done` with `fleet view <card-id> --full`.

### Branch B: Coding harness (`ypi`, stock `pi`, or Claude Code)

1. Check the harness binary on the machine; if missing, ask permission to install it first.
2. Add `1stmate` under `mates.items` in `~/.fleet/fleet.yaml` (`cwd: ./1stmate`, `autoStart: false`) with launch-command hook injection (zero global or repo hooks):
   - **`ypi`:** `command: ["ypi", "-e", "{adapter}", "--append-system-prompt", "{prompt}"]`
   - **Stock `pi`:** `command: ["pi", "-e", "{adapter}", "--append-system-prompt", "{prompt}"]`
   - **Claude Code:**
     ```yaml
     - name: 1stmate
       parent: captain
       cwd: ./1stmate
       autoStart: false
       command:
         - claude
         - --mcp-config
         - "{mcpConfig}"
         - --dangerously-load-development-channels
         - server:fleet
         - --append-system-prompt-file
         - "{prompt}"
     ```
     _(Claude Code Channels are in research preview; Team/Enterprise orgs must allow `channelsEnabled`.)_
3. Seed `1stmate`'s charter and verify everything with `fleet doctor`:
   ```bash
   fleet charter 1stmate --set "You are 1stmate (parent: captain). Handle quick work inline, delegate domain work to 2ndmates, or dispatch crewmates."
   fleet doctor
   ```
4. Tell the user they can launch `1stmate` from any directory with `fleet chat` (and pass extra harness flags after `--`, e.g. `fleet chat -- --resume`).

---

## Step 3: Set Up Crewmates (Execution Hosts & Repos)

Now ask ONE question:

> Next, what coding harness do you want to use for crewmates (for example `ypi` / `pi` or Claude Code), and which machine(s) should they run on (this machine, remote SSH hosts, or both)?

Wait for the user's answer, then:

1. Inspect the chosen machine(s) for installed tools (`node >= 24`, `bun`, `git`, chosen harness, `herdr`, `no-mistakes`, `direnv`, `docker` or Apple `container`) and existing project repos.
2. Confirm with the user:
   - Which repos to register under `repos:` (and default delivery: `no-mistakes`, `direct-pr`, or `local`), plus `herdr` panes (`viewport: herdr`, recommended on desktop) vs. `headless`.
   - Permission to install any missing dependencies on each execution host.
3. Once approved, configure `~/.fleet/fleet.yaml` on each execution host (`host:`, `boardUrl:`, `projectsRoot: ~/.fleet-v3/projects`, `spawn:`, `repos:`):
   - **`ypi` crewmate (`viewport: herdr`):**
     ```yaml
     spawn:
       mode: local
       viewport: herdr
       direnv: true
       herdr:
         keepPane: on-failure
       command:
         - ypi
         - --auto-exit
         - --no-session
         - --append-system-prompt
         - "{prompt}"
         - "Read card #{card} with `fleet view {card} --full` and execute it."
     ```
   - **Stock `pi` crewmate:**
     ```yaml
     command:
       - pi
       - --print
       - --no-session
       - --append-system-prompt
       - "{prompt}"
       - "Read card #{card} with `fleet view {card} --full` and execute it."
     ```
   - **Claude Code crewmate:**
     ```yaml
     command:
       - claude
       - --append-system-prompt-file
       - "{prompt}"
       - -p
       - "Read card #{card} with `fleet view {card} --full` and execute it."
     ```
   - **Container / Docker workers note:** Inside a container or Apple `container` micro-VM, `127.0.0.1` is the guest loopback. Bind `server.host` to a reachable interface (e.g. Tailscale IP) and point `boardUrl` there.
   - **Remote SSH execution host:** tunnel the Card Server from the Control Host to the remote host (or point `boardUrl` at a private Tailscale IP):
     ```bash
     ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 127.0.0.1:4100:127.0.0.1:4100 user@remote-host
     ```
     Install `fleet` on the remote host (same clone + `bun install` + symlink), verify `curl -sf http://127.0.0.1:4100/api/health`, and write its `~/.fleet/fleet.yaml` with its unique `host:` name and project remotes under `repos:`.
4. Start `fleet run` on each execution host (with `launchd` or `systemd` persistence from **Reference A**), verify `fleet hosts` lists every host, and smoke-test a real crewmate worktree run:
   ```bash
   FLEET_MATE=1stmate fleet dispatch --project <repo> --host <host> --delivery local --title "Smoke test: print git status and exit cleanly"
   ```
   Wait for the runner to claim and finish that exact card ID, and confirm completion with `fleet view <card-id> --full`.

### Managed Git checkouts and private bootstrap

Register each project by its upstream remote. To upgrade an existing host, wait for its running cards to finish before stopping the old runner. Replace `repos.<project>.path` with `remote`, using `git -C <old-path> remote get-url origin`. Remove `baseBranch` to follow the remote default, or keep it if the project intentionally starts from another branch. Restart the runner with the updated config. Fleet does not move or delete old worktrees, branches, or personal checkouts. Keep them until any unfinished work has been recovered. `workspacesRoot` only controls the default mate state directory.

```yaml
projectsRoot: ~/.fleet-v3/projects
repos:
  example-app:
    remote: git@github.com:example/example-app.git
    delivery: no-mistakes
```

Fleet stores a project's managed clone at `<projectsRoot>/<project>/repo`, attempts at `<project>/worktrees`, and attempt scratch and locks in sibling directories. It creates the clone on first use, fetches origin and fast-forwards the base before every worktree, and hands the card back if it cannot sync. Do not use the managed clone for personal changes. Configure non-interactive Git access on the runner host via a credential helper or SSH agent. Do not include credentials in remote URLs.

Put the optional `setup.sh` next to `repo/`, in the project's private Fleet directory, not in the project repository. Provision it on each runner host and keep it idempotent. Set `repos.<project>.bootstrap` to override the location with an absolute path or a path relative to `fleet.yaml`. Fleet sources the script with `sh` in the new worktree before starting the worker command. In Docker and Apple `container` mode, Fleet mounts the script read-only and runs it in the same container as the worker, so installs and exports remain available. Use an image with `sh` and an entrypoint that runs Fleet's command.

Supply credentials at runtime through private file mounts or environment injection. For containers, use `spawn.container.mounts` or `inheritEnv`. Do not put credentials in scripts, source control, images, or command arguments. The setup script checks that required inputs are present and returns nonzero if setup fails. For example, a private script can check an injected credential path and install the project's locked dependencies:

```sh
test -r "${PROJECT_CREDENTIAL_FILE:?inject the credential file path at launch}" || return 1
command -v uv >/dev/null || return 1
uv sync --locked || return 1
```

Fleet suppresses setup output and reports `Worker bootstrap failed.` without starting the worker. Debug the private script with the same runtime configuration if setup fails. Post-worker `no-mistakes` verification still runs on the host and needs its own tooling and credentials.

---

## Step 4: Optional Secondmates (`2ndmate`s)

Now ask ONE question:

> Finally, do you want any secondmates? Secondmates are firstmates who are responsible for a specific domain or project of your life. By default they can run on coding harnesses (`ypi`/`pi` or Claude Code in Herdr panes), and Grok Bot can also host secondmates because it supports multiple bots.

- If **no**: run `fleet doctor` and give a short summary of what is running.
- If **yes**: ask which domains/repos and which harness for each `2ndmate`, then configure each one:
  1. Add each `2ndmate` under `mates.items` in `~/.fleet/fleet.yaml` with `parent: 1stmate` and seed its charter via `fleet charter <name> --set "..."`.
  2. **Coding harness `2ndmate`s (`ypi`/`pi` or Claude Code in Herdr):**
     - For `ypi` / `pi`, inherit `mates.command` (or set per-mate `command`).
     - For Claude Code, override `command` with `--mcp-config "{mcpConfig}" --dangerously-load-development-channels server:fleet --append-system-prompt-file "{prompt}"` (`fleet mates up` writes `{stateDir}/mcp.json` automatically).
     - Start them with `fleet mates up` and verify with `fleet mates status`.
  3. **Grok Bot (or other multi-bot external platform) `2ndmate`s:**
     - Never install any bot app locally. Set `mode: external` on that mate in `~/.fleet/fleet.yaml` as in Step 2, Branch A. A parent routes cards to this child by name just as it would to a local child.
     - Hand the captain a ready-to-paste prompt explicitly instructing Grok Bot to **create another separate bot** for that domain (or if you are Grok Bot running on the host, create the separate bot directly):
       > Read `https://github.com/1yian/fleet-v3/blob/main/EXTERNAL_BOT.md` and create a new separate bot for my `<name>` secondmate (`mate: <name>`, `parent: 1stmate`, domain: `<domain>`). Use the `fleet` CLI for every action (`BOARD_URL: <board-url>`). Return its incoming webhook URL and auth header when ready.
     - Wire a dedicated `fleet watch --mate <name> --webhook <bot-webhook-url> [--header "..."]` service (with persistence from **Reference A**) once the bot returns its webhook URL.
  4. Finish with `fleet doctor` and a concise summary of running services and commands.

If any mates are external, configure the [prompt update hook](EXTERNAL_BOT.md#5-publish-prompt-updates-from-the-control-host) once on the Control Host.

---

## Reference A: Reboot Persistence Templates

### macOS (`launchd`)

Create `~/Library/LaunchAgents/dev.fleet.board.plist` using the template below. When copying it for other daemons, give **each** plist a distinct `<key>Label</key>`, matching `ProgramArguments`, and separate `StandardOutPath`/`StandardErrorPath` log file:

- `dev.fleet.board.plist`: Label `dev.fleet.board`, args `["/Users/YOU/.local/bin/fleet", "serve"]`, log `~/.fleet/logs/board.log`
- `dev.fleet.runner.plist`: Label `dev.fleet.runner`, args `["/Users/YOU/.local/bin/fleet", "run"]`, log `~/.fleet/logs/runner.log`
- `dev.fleet.kanban.plist`: Label `dev.fleet.kanban`, args `["/Users/YOU/.local/bin/fleet", "web", "--host", "<ip>", "--port", "4101"]`, log `~/.fleet/logs/kanban.log`
- `dev.fleet.events-<mate>.plist` (ChatGPT Dots only): Label `dev.fleet.events-<mate>`, args `["/Users/YOU/.local/bin/fleet", "events", "--mate", "<mate>", "--port", "4102"]`, an extra `FLEET_EVENTS_TOKEN` entry in `EnvironmentVariables`, log `~/.fleet/logs/events-<mate>.log`
- `dev.fleet.watch-<mate>.plist` (external webhook bots only): Label `dev.fleet.watch-<mate>`, args `["/Users/YOU/.local/bin/fleet", "watch", "--mate", "<mate>", "--webhook", "<url>"]`, log `~/.fleet/logs/watch-<mate>.log`

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

Make sure `PATH` includes the directory printed by `dirname "$(which node)"`. Load with `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/<label>.plist` (start `board` before `runner`, `kanban`, `events`, and `watch`).

### Linux (`systemd --user`)

Create `~/.config/systemd/user/fleet-board.service` (and matching units for `fleet-runner.service`, optional `fleet-events-<mate>.service`, and `fleet-watch-<mate>.service` with `After=fleet-board.service`):

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

Add `dirname "$(which node)"` to `PATH` in every unit if Node lives under `nvm` or `mise`. Enable with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now fleet-board fleet-runner
loginctl enable-linger "$USER"
```
