# fleet-v3

A thin multi-machine execution runner and minimal agent behavior set on top of `@vercel/board`.

Read [VISION.md](VISION.md) for the design principles and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `prompts/` - always-loaded role prompts for Jarvis, domain mates, and workers (under 2,000 words total).
- `src/` - `fleet-runner` daemon claiming ready tasks for a host, managing git worktrees, `direnv`, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `fleet.example.yaml` - per-host runner configuration template. Copy to `fleet.yaml` (gitignored) on each execution host.
- `e2e/` - fast core-journey tests against `@vercel/board`'s in-memory backend and real git worktrees.

## Quick start

1. Start or point at any `@vercel/board` endpoint (`vb serve --tailscale <host>.ts.net` or hosted Vercel Board) and install the board skill (`npx skills add vercel/board --skill board -g`).
2. Copy `fleet.example.yaml` to `fleet.yaml` on each execution host and edit `host`, `boardUrl`, and `repos`.
3. Run `bun install && bun run check`.
4. Start the runner with `bun src/cli.ts run`.
5. Attach any harness (Pi, Claude Code, Codex, Grok Bot, Dots) as Jarvis or a domain mate using `prompts/jarvis.md` or `prompts/mate.md` and `BOARD_URL`.
