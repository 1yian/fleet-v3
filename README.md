# fleet-v3

An Agent eXperience Interface (AXI), thin multi-machine execution runner, and minimal agent behavior set on top of `@vercel/board`.

Read [VISION.md](VISION.md) for the design principles and [AGENTS.md](AGENTS.md) before contributing.

## Layout

- `src/bin.ts` + `src/cli.ts` + `src/axi/` - the `fleet` AXI CLI (TOON output, content-first home view, `--version` fast path, strict flag validation, idempotent mutations, and opt-in session-start hooks via `axi-sdk-js`).
- `src/runner/` - `fleet-runner` claiming ready tasks for a host, managing git worktrees, `direnv`, process-group timeouts, and 4-round capped `no-mistakes` verification.
- `prompts/` - always-loaded role prompts for Jarvis, domain mates, and workers (under 1,000 words total).
- `fleet.example.yaml` - per-host runner configuration template. Copy to `fleet.yaml` (gitignored) via `fleet init`.
- `e2e/` - fast core-journey tests against `@vercel/board`'s in-memory backend and real git worktrees.

## Quick start

1. Point `BOARD_URL` at any `@vercel/board` endpoint (`vb serve --tailscale <host>.ts.net` or hosted Vercel Board).
2. Run `bun install && bun run check`.
3. Run `fleet` (no args) for a live TOON overview of counts, advertised hosts, and open tasks, or `fleet setup hooks` to inject ambient context at session start in Claude Code, Codex, and OpenCode.
4. On each execution host, run `fleet init`, edit `fleet.yaml`, and start the runner with `fleet run`.
5. Attach any harness (Pi, Claude Code, Codex, Grok Bot, Dots) as Jarvis or a domain mate using `prompts/jarvis.md` or `prompts/mate.md`.
