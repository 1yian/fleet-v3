# fleet-v3

An Agent eXperience Interface (AXI), minimal 3-table SQLite Card Server, multi-machine execution runner, and unified `Mate` hierarchy (`1stmate`, optional domain `2ndmate`s, and isolated `crewmates`).

**Set up with your agent:** tell your coding agent:

> "Read `SETUP.md` in `https://github.com/1yian/fleet-v3` and set up fleet on this machine."

Read [VISION.md](VISION.md) for the design principles, [SETUP.md](SETUP.md) for the agent-executable onboarding and setup guide, and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `src/board/` - minimal 3-table `node:sqlite` Card Server (`cards`, `entries`, `events`) + plain-Markdown charters/prefs, HTTP + SSE push, shared wake loop (`wake.ts`), leases with epoch fencing, subtree scoping, dependencies, snooze, and stateless stale-ball chase (`fleet serve`).
- `src/bin.ts` + `src/cli.ts` + `src/axi/` - the `fleet` AXI CLI (TOON output, content-first home view, unified `dispatch` for `2ndmate`s and `crewmates`, `queue`, `snooze`, `watch`, `channel`, `--version` fast path, strict flag validation, idempotent `close`, `cancel`, and `init`, and opt-in session-start hooks via `axi-sdk-js`).
- `src/runner/` - `fleet-runner` claiming queued cards for a host, managing git worktrees, `direnv`, container isolation (`docker` on Linux or Apple `container` on macOS), ephemeral interactive `herdr` panes, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `src/mates.ts` - `fleet mates` idempotently manages permanent interactive mate panes in `herdr` (`1stmate` with `parent: captain` and domain `2ndmate`s with `parent: 1stmate` are the exact same primitive).
- `src/adapters/` - thin optional viewports and wake bridges: the Pi/ypi native extension (`pi.ts`), Claude Code native stdio Channel MCP server (`channel.ts`, invoked via `fleet channel`), and visual Kanban UI (`kanban.ts`, served only by `fleet web`).
- `prompts/` - always-loaded role prompts for mates and workers (`prompts/mate.md`, `prompts/worker.md` - under 750 words total).
- `fleet.example.yaml` - configuration template. One shared `~/.fleet/fleet.yaml` can serve every command (`fleet serve`, `fleet run`, `fleet mates up`) with relative paths resolved against `fleet.yaml`'s directory.
- `e2e/` - end-to-end tests against real `node:sqlite`, live HTTP/SSE servers, real webhook + MCP stdio channel processes, real git worktrees, Apple containers, and isolated Herdr sessions.

## Quick start

1. Run `bun install && bun run check`.
2. Follow [SETUP.md](SETUP.md) (or have your agent follow it) to create `~/.fleet/fleet.yaml`, start `fleet serve`, start `fleet run`, and wire `1stmate` + optional `2ndmate`s:
   - **Pi / `ypi`:** native extension (`src/adapters/pi.ts`); launch `1stmate` with `ypi` from the checkout or launch `2ndmate`s via `fleet mates up`.
   - **Claude Code:** native Channel MCP (`fleet channel --mate <name>`).
   - **Grok Bot / Dots / Muse / webhook bots:** `fleet watch --mate <name> --webhook <url>` (or bare `fleet watch --mate <name>` for NDJSON stdout).
3. Run `fleet` (no args) for a live TOON overview of counts, advertised hosts, and open cards.
