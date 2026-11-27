# fleet-v3

An Agent eXperience Interface (AXI), minimal 3-table SQLite Card Server, multi-machine execution runner, and unified `Mate` hierarchy (`1stmate`, optional domain `2ndmate`s, and isolated `crewmates`).

**Set up with your agent:** tell your coding agent:

> "Read `SETUP.md` in `https://github.com/1yian/fleet-v3` and set up fleet on this machine."

Read [VISION.md](VISION.md) for the design principles, [SETUP.md](SETUP.md) for the agent-executable onboarding and setup guide, [EXTERNAL_BOT.md](EXTERNAL_BOT.md) for external bot (`Grok Bot`, `Dots`, `Muse`) self-setup, and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `src/board/` - minimal 3-table `node:sqlite` Card Server (`cards`, `entries`, `events`) + plain-Markdown charters/prefs, HTTP + SSE push, shared wake loop (`wake.ts`), leases with epoch fencing, subtree scoping, dependencies, snooze, and stateless stale-ball chase (`fleet serve`).
- `src/bin.ts` + `src/cli.ts` + `src/axi/` - the `fleet` AXI CLI (TOON output, content-first home view, `chat`, `doctor`, unified `dispatch` for `2ndmate`s and `crewmates`, `queue`, `snooze`, `watch`, `channel`, `events`, `--version` fast path, strict flag validation, idempotent `close`, `cancel`, and `init`, and opt-in session-start hooks via `axi-sdk-js`).
- `src/runner/` - `fleet-runner` claiming queued cards for a host, managing git worktrees, `direnv`, container isolation (`docker` on Linux or Apple `container` on macOS), ephemeral interactive `herdr` panes, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `src/mates.ts` - `fleet chat`, `fleet doctor`, and `fleet mates` manage `1stmate` (`parent: captain`) and domain `2ndmate`s (`parent: 1stmate`) with launch-command hook injection (`{adapter}`, `{mcpConfig}`, `{prompt}`) and explicit `mode: external` support for webhook bots.
- `src/adapters/` - thin optional viewports and wake bridges: the Pi/ypi native extension (`pi.ts`), Claude Code native stdio Channel MCP server (`channel.ts`, invoked via `fleet channel`), the MCP Events wake bridge for ChatGPT Dots (`events.ts` and `events-delivery.ts`, served by `fleet events`, events capability only and no tools), and visual Kanban UI (`kanban.ts`, served only by `fleet web`).
- `prompts/` - always-loaded role prompts for mates and workers (`prompts/mate.md`, `prompts/worker.md` - under 1,000 words total).
- `fleet.example.yaml` - configuration template. One shared `~/.fleet/fleet.yaml` can serve every command (`fleet serve`, `fleet run`, `fleet mates up`) with relative paths resolved against `fleet.yaml`'s directory.
- `e2e/` - end-to-end tests against real `node:sqlite`, live HTTP/SSE servers, real webhook + MCP Events + MCP stdio channel processes, real git worktrees, Apple containers, and isolated Herdr sessions.

## Worker names

Each worker gets its own Herdr workspace in the configured session. The workspace label uses the first four ASCII alphanumeric runs from the lowercased card title, joined with hyphens and capped at 40 characters. A title with no ASCII alphanumeric runs falls back to `c-<card-id>`, so `修复登录` on card 19 becomes `c-19`. Permanent mates are long-lived: each local mate gets its own Herdr workspace labeled with the mate name (set `workspace` on a mate or under `mates` to share one), and `fleet mates up` reuses a running pane, restarts an idle shell in place, and closes duplicate tabs. `fleet mates stop` closes the mate's workspace.

The worktree directory and Git branch use `c-<card-id>-a<claim-epoch>`. If that name is already taken by a local branch (or a branch under the same name prefix) or by a worktree directory in the project's managed `worktrees` directory, a short suffix is added to both. Uniqueness covers local refs and local checkout paths only, including boards that share them; remote branches are not consulted. For example, the first claim of card #19, `Restore original worker names today`, opens a Herdr workspace named `restore-original-worker-names` with worktree and branch `c-19-a1`.

## Herdr pane lifecycle

A card has at most one worker workspace at a time. A new attempt closes the panes of every earlier attempt of the same card before it opens its own, so a retried card never leaves two. While a worker runs or verifies, the pane reports `working`. A clean finish, a handoff, a lost lease, an abort, and a superseded attempt all close the pane. Only a crash, a timeout, a failed launch, or a stopped verification keeps the pane, reporting `blocked` with the reason, when `keepPane` is `on-failure`.

The runner reaps stale panes at start, after every claim, and on each idle poll. It closes any pane whose card is done, canceled, waiting, running without a live claim on this runner, or older than the card's newest attempt. Panes of held and queued cards survive until the card moves on.

## Quick start

1. Run `bun install && bun run check`.
2. Follow [SETUP.md](SETUP.md) (or have your agent follow it) to create `~/.fleet/fleet.yaml`, start `fleet serve`, start `fleet run`, verify with `fleet doctor`, and talk to `1stmate`:
   - **Pi / `ypi`:** launch `1stmate` from any directory with `fleet chat` (adapter injected via `-e {adapter}`, zero global or repo hooks); launch `2ndmate`s via `fleet mates up`.
   - **Claude Code:** configure `1stmate` or `2ndmate`s with `--mcp-config {mcpConfig} --dangerously-load-development-channels server:fleet` and launch with `fleet chat` or `fleet mates up` (`mcp.json` is written automatically).
   - **Grok Bot / Muse / webhook bots:** set `mode: external` on the mate in `fleet.yaml`. Fleet routes cards to it by name as usual but does not launch it. Forward its wakes with `fleet watch --mate <name> --webhook <url>` (or omit `--webhook` for NDJSON stdout). The bot acts through the `fleet` CLI; see [EXTERNAL_BOT.md](EXTERNAL_BOT.md).
   - **ChatGPT Dots:** set `mode: external` the same way, run `fleet events --mate <name>` behind a public HTTPS tunnel so the Dot is woken through MCP Events, and let the Dot act through the `fleet` CLI on a computer connected to it; see [EXTERNAL_BOT.md](EXTERNAL_BOT.md).
3. Run `fleet` (no args) for a live TOON overview of counts, advertised hosts, and open cards.
