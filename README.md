# fleet-v3

An Agent eXperience Interface (AXI), minimal 3-table SQLite Card Server, multi-machine execution runner, and unified `Mate` hierarchy (`1stmate`, optional domain `2ndmate`s, and isolated `crewmates`).

**Set up with your agent:** tell your coding agent:

> "Read `SETUP.md` in `https://github.com/1yian/fleet-v3` and set up fleet on this machine."

Read [VISION.md](VISION.md) for the design principles, [SETUP.md](SETUP.md) for the agent-executable onboarding and setup guide, [EXTERNAL_BOT.md](EXTERNAL_BOT.md) for external bot (`Grok Bot`, `Dots`, `Muse`) self-setup, and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `src/board/` - minimal 3-table `node:sqlite` Card Server (`cards`, `entries`, `events`) + plain-Markdown charters/prefs, HTTP + SSE push, shared wake loop (`wake.ts`), leases with epoch fencing, subtree scoping, dependencies, snooze, and stateless stale-ball chase (`fleet serve`).
- `src/bin.ts` + `src/cli.ts` + `src/axi/` - the `fleet` AXI CLI (TOON output, content-first home view, `chat`, `doctor`, unified `dispatch` for `2ndmate`s and `crewmates`, `queue`, `snooze`, `watch`, `channel`, `mcp`, `--version` fast path, strict flag validation, idempotent `close`, `cancel`, and `init`, and opt-in session-start hooks via `axi-sdk-js`).
- `src/runner/` - `fleet-runner` claiming queued cards for a host, managing git worktrees, `direnv`, container isolation (`docker` on Linux or Apple `container` on macOS), ephemeral interactive `herdr` panes, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `src/mates.ts` - `fleet chat`, `fleet doctor`, and `fleet mates` manage `1stmate` (`parent: captain`) and domain `2ndmate`s (`parent: 1stmate`) with launch-command hook injection (`{adapter}`, `{mcpConfig}`, `{prompt}`) and explicit `mode: external` support for webhook bots.
- `src/adapters/` - thin optional viewports and wake bridges: the Pi/ypi native extension (`pi.ts`), Claude Code native stdio Channel MCP server (`channel.ts`, invoked via `fleet channel`), Fleet MCP tool server (`mcp.ts`, stdio or Streamable HTTP via `fleet mcp`), and visual Kanban UI (`kanban.ts`, served only by `fleet web`).
- `prompts/` - always-loaded role prompts for mates and workers (`prompts/mate.md`, `prompts/worker.md` - under 1,000 words total).
- `fleet.example.yaml` - configuration template. One shared `~/.fleet/fleet.yaml` can serve every command (`fleet serve`, `fleet run`, `fleet mates up`) with relative paths resolved against `fleet.yaml`'s directory.
- `e2e/` - end-to-end tests against real `node:sqlite`, live HTTP/SSE servers, real webhook + MCP stdio channel processes, real git worktrees, Apple containers, and isolated Herdr sessions.

## Worker names

Each worker gets its own Herdr workspace in the configured session. The workspace label uses the first four ASCII alphanumeric runs from the lowercased card title, joined with hyphens and capped at 40 characters. A title with no ASCII alphanumeric runs falls back to `c-<card-id>`, so `修复登录` on card 19 becomes `c-19`. Permanent mate names are unchanged.

The worktree directory and Git branch use `c-<card-id>-a<claim-epoch>`. If that name is already taken by a local branch (or a branch under the same name prefix) or by an occupied path or Git worktree registration in the shared workspaces root, a short suffix is added to both. Uniqueness covers local refs and local checkout paths only, including boards that share them; remote branches are not consulted. For example, the first claim of card #19, `Restore original worker names today`, opens a Herdr workspace named `restore-original-worker-names` with worktree and branch `c-19-a1`.

Failed setup only rolls back a checkout registered for that attempt's branch. If Git refuses checkout removal, the runner still attempts scratch and reservation cleanup and reports each failure. Teardown after a claim ends adds an internal card status without changing the claim outcome. If the status cannot be posted, the runner writes the teardown and reporting errors to stderr.

## Quick start

1. Run `bun install && bun run check`.
2. Follow [SETUP.md](SETUP.md) (or have your agent follow it) to create `~/.fleet/fleet.yaml`, start `fleet serve`, start `fleet run`, verify with `fleet doctor`, and talk to `1stmate`:
   - **Pi / `ypi`:** launch `1stmate` from any directory with `fleet chat` (adapter injected via `-e {adapter}`, zero global or repo hooks); launch `2ndmate`s via `fleet mates up`.
   - **Claude Code:** configure `1stmate` or `2ndmate`s with `--mcp-config {mcpConfig} --dangerously-load-development-channels server:fleet` and launch with `fleet chat` or `fleet mates up` (`mcp.json` is written automatically).
   - **Grok Bot / Dots / Muse / webhook bots:** set `mode: external` on the mate in `fleet.yaml`. Fleet routes cards to it by name as usual but does not launch it. Forward its wakes with `fleet watch --mate <name> --webhook <url>` (or omit `--webhook` for NDJSON stdout). The bot uses `fleet` CLI or, without shell access, `fleet mcp --http`. See [EXTERNAL_BOT.md](EXTERNAL_BOT.md).
3. Run `fleet` (no args) for a live TOON overview of counts, advertised hosts, and open cards.
