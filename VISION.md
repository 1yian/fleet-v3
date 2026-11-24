# Vision

`fleet-v3` exists so that one operator can run parallel, high-autonomy agents across multiple machines without being the bottleneck or babysitting their terminals.
It serves any single individual whose ambitions outrun their attention, turning stated intent into durable, verified, self-driving work across both solo domains and team codebases.
It owns two thin, cohesive halves on top of `@vercel/board`: a multi-machine execution runner and a minimal agent behavior set that turns bring-your-own harnesses and modality-agnostic interfaces into a unified Jarvis experience.

## Autonomy is the goal

Autonomy is earned per domain as the operator builds trust: agents move smoothly from human-guided collaboration on shared repositories to full autopilot where they choose and execute the next best step on their own.
Boundaries live in plain-English domain charters, agent judgment, and external payment or provider rails, never in hardcoded approval state machines, verbatim quote checks, billing proxies, or enumerated gate taxonomies.
A worker never pages the operator directly; it reports to its domain mate, which resolves what it can, consults Jarvis when cross-life context might answer it, and blocks for the operator only when human judgment is genuinely required.
Jarvis stays proactive without becoming a chatter firehose: it wakes only on high-signal events - explicit `@jarvis` mentions, blocked or failed tasks, and triggers from its own life context - and drops answers straight into the relevant thread.
Peace of mind comes from a zero-inbox decision feed where every item genuinely needs the operator and vanishes the moment it is answered or made obsolete.

## The board is the conversation

`@vercel/board` owns the durable record of channels, threads, tasks, dependencies, claim leases, and visual inspection through `vb inspect`.
`fleet-v3` stays backend-agnostic across self-hosted tailnet SQLite and hosted Vercel boards, and writes no custom task state machine, custom web board UI, custom delivery queue, persistent scheduler daemon, or incident-recovery subsystem on top of it.
Every human interface is a replaceable viewport onto the same board threads: a `herdr` TUI at the desk, `vb inspect` for visual overview, and optional chat adapters such as Discord, Slack, or iMessage.
`fleet-v3` may ship Discord as an optional adapter package while keeping the core completely chat-agnostic so Slack, web, iMessage, or any future client works equally well.
Formatting belongs to each modality adapter, never to global agent prompts.
The board is the agent's communication channel, not a terminal scraper: if the operator intervenes directly in a live pane, the agent reports the pivot on the thread and `fleet-v3` trusts it.
A restart, session reset, or agent swap is a non-event because durable work state lives on the board, not in any agent's conversation history.

## Agents are black boxes

`fleet-v3` is bring-your-own-harness on `@vercel/board`: it coordinates agents through one small board contract and never polices their internals, memory, compaction, life connectors, or subagents.
Any harness that speaks the board - Pi with OptChat, Claude Code, Codex, Grok Bot, or Dots - is a first-class mate or Jarvis without custom harness plumbing.
Fast local work stays inside a mate's own subagents; isolated multi-machine repository work routes through a thin runner daemon that wraps git worktrees, `herdr` panes, and `no-mistakes` around `@vercel/board` leases.
Worker isolation defaults to lightweight git worktrees and process groups on the host; stronger sandboxing comes from running a runner inside a separate VM or sandbox host rather than building virtualization into `fleet-v3`.
Recovery relies on board lease expiration, runner process timeouts, and a simple retry cap rather than polling watchdogs or live session-reload waves.

## Simplicity is defended by subtraction

Behavioral regression in agentic systems cannot always be measured directly, so minimalism - especially in always-loaded agent instructions - is our primary defense against it.
Always-loaded mate instructions stay lean and under 2,000 words; any behavior that requires a 500-word prompt protocol is a design flaw to delete, not a rule to document.
Verification rigor belongs to `no-mistakes` and repository CI, with `fleet-runner` capping `no-mistakes` review loops at four rounds so runs converge instead of spiraling into speculative guards.
When a run still has open findings after four rounds, `fleet-runner` never force-ships an unpassed branch: it hands the summary back to the domain mate to dismiss nitpicks with a recorded reason, rescope the task, or block for the operator.
A fast domain mate may bypass `no-mistakes` on a code change only when the repository is configured for direct PRs or when Jarvis concurs that the change is bounded enough to ship directly.
An agent's judgment mistake is addressed by tightening judgment or simplifying the surface, never by bolting on another rigid validator or state-machine guard.

## Scope

`fleet-v3` is not a custom database or task server, not a custom web Kanban app, not a persistent cron daemon, not a spend proxy, not a browser viewer, not a file explorer, not a CI system, and not a life-integration platform.
Recurring schedules belong to host schedulers (`launchd`, `systemd`, `cron`) or the board backend itself; personal life connectors belong to whatever external harness or skills the operator brings.
`fleet-v3` stays generic and public while personal domain charters, projects, and credentials stay private to each operator's setup.
Changes to `fleet-v3` itself are validated against this `VISION.md` through `no-mistakes`: operator-initiated PRs that pass may auto-merge, while external contributors' PRs remain gated under operator authority.

A change aligns when it increases parallel shipped throughput per unit of human attention, preserves `@vercel/board` as the single modality-agnostic source of truth, makes another harness or host plug in cleanly, or deletes code and prompt weight without losing durability.
A change should be resisted when it adds a custom state machine, scheduler, web UI, or approval lock on top of `@vercel/board`, couples the system to one operator's setup, harness, or chat client, scrapes live terminal panes, grows always-loaded prompts to patch agent judgment, turns mechanical liveness into LLM polling turns, or pulls external life integrations or workshop tools into the core.
