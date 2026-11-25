# fleet-v3

An Agent eXperience Interface (AXI), minimal 3-table SQLite Card Server, multi-machine execution runner, and unified `Mate` hierarchy.

Read [VISION.md](VISION.md) for the design principles, [SETUP.md](SETUP.md) for the harness-agnostic machine, SSH host, and mate setup guide, and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `src/board/` - minimal 3-table `node:sqlite` Card Server (`cards`, `entries`, `events`) + plain-Markdown charters/prefs, HTTP + SSE push, leases with epoch fencing, subtree scoping, dependencies, snooze, and stateless stale-ball chase (`fleet serve`).
- `src/bin.ts` + `src/cli.ts` + `src/axi/` - the `fleet` AXI CLI (TOON output, content-first home view, unified `dispatch` for child mates and workers, `queue`, `snooze`, `--version` fast path, strict flag validation, idempotent `close`, `cancel`, and `init`, and opt-in session-start hooks via `axi-sdk-js`).
- `src/runner/` - `fleet-runner` claiming queued cards for a host, managing git worktrees, `direnv`, container isolation (`docker` on Linux or Apple `container` on macOS), ephemeral interactive `herdr` panes, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `src/mates.ts` - `fleet mates` idempotently manages permanent interactive mate panes in `herdr` (Jarvis with `parent: captain` and domain mates with `parent: jarvis` are the same primitive).
- `src/adapters/` - thin optional viewports: the unified Pi/ypi SSE mate adapter (`pi.ts`) and visual Kanban UI (`kanban.ts`, served only by `fleet web`, which proxies the Card Server API).
- `prompts/` - always-loaded role prompts for mates and workers (`prompts/mate.md`, `prompts/worker.md` - under 700 words total).
- `fleet.example.yaml` - configuration template. One shared file can serve every command: `fleet serve` and `fleet mates` read only `boardUrl`, `server`, and `mates`, while `fleet run` also requires `host`, `spawn`, and `repos`. Copy to `fleet.yaml` (gitignored) via `fleet init`.
- `e2e/` - end-to-end tests against real `node:sqlite`, live HTTP/SSE servers, real git worktrees, Apple containers, and isolated Herdr sessions.

## Quick start

1. Run `bun install && bun run check`.
2. Run `fleet init`, edit `fleet.yaml`, and start the Card Server with `fleet serve` (serves API + SSE at `http://127.0.0.1:4100`; run `fleet web` for the Kanban viewport).
3. Start the host runner with `fleet run` to claim queued cards and run isolated ephemeral workers. The example config runs workers locally in per-card git worktrees against the loopback Card Server. To isolate workers in `docker` or Apple `container`, set `spawn.mode` and give `boardUrl` an address the guest can reach (a LAN, bridge, or Tailscale address, with `server.host: 0.0.0.0`), because the guest's `127.0.0.1` is not the host.
4. Start permanent interactive mates in Herdr with `fleet mates up` (or attach any harness - ypi/Pi, Claude Code, Codex, Grok Bot - with `prompts/mate.md`, `FLEET_MATE`, and `BOARD_URL`; workers also receive `FLEET_CLAIM_EPOCH` and `FLEET_CLAIM_TOKEN`, which the `fleet` CLI forwards automatically).
5. Run `fleet` (no args) for a live TOON overview of counts, advertised hosts, and open cards.
