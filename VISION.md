# Vision

`fleet-v3` exists so that one captain can run parallel, high-autonomy agents across multiple machines without being the bottleneck or babysitting their terminals.
It serves any single individual whose ambitions outrun their attention, turning stated intent into durable, verified, self-driving work across both solo domains and team codebases.
It is built from three small, decoupled halves where every arrow points one way into a minimal Card Server:

```
  Brains (permanent)               Muscle (ephemeral)              Viewports
  ┌──────────────────┐            ┌──────────────────┐           ┌────────────────┐
  │ Mates            │            │ fleet-runner     │           │ Kanban web UI  │
  │ (`fleet mates`)  │            │ (per execution   │           │ Discord bridge │
  │ + BYO harnesses  │            │  host)           │           │ `fleet` CLI    │
  └────────┬─────────┘            └────────┬─────────┘           └───────┬────────┘
           │                               │                             │
           └───────────────► ┌─────────────▼─────────────┐ ◄─────────────┘
                             │   Card Server (SQLite)    │
                             │   HTTP + SSE + Leases     │
                             │   (depends on NOTHING)    │
                             └───────────────────────────┘
```

## One recursive primitive: Mate

There is only one long-lived agent primitive in `fleet-v3`: a **mate** with a `parent` (`captain` at the root, or another mate).
A top-level mate whose parent is `captain` acts as the captain's executive across all domains (a "first mate", e.g. Jarvis); a mate whose parent is another mate owns one domain (casually a "second mate", e.g. `cleo` or `cnp`).
Functionally they are identical: same server model, same `fleet` CLI, same SSE subscription, same chase mechanism, same prompt, and same harness adapter - differing only in their `parent` and plain-Markdown charter.

Workers are not mates. Workers are ephemeral, isolated, single-card executors launched by `fleet-runner` in clean git worktrees (or containers) and torn down when the run ends.

## Explicit card ownership (the ball)

Every open card has **one unambiguous holder** at every instant:

```
waiting ──► queued (runner) ──► running (worker, leased + fenced)
                                      │
                   (worker done) ─────┴────► done (unblocks waiting needs)
                   (stuck/fail/cap)   │
                                      ▼
                    held (holder = mate ──escalate──► parent ... ──► captain)
                                      ▲                                │
                                      └─────── answer / handoff ───────┘
```

- **Leases + monotonic epoch + fencing tokens** protect `running` cards: a crashed or sleeping runner loses its lease automatically, the next claim bumps `epoch` with a fresh fencing token, and stale writes are rejected with `409 claim_lost`.
- **Worker failures never vanish and never page the captain:** a stuck, failed, timed-out, or 4-round verification handback always lands in `held` with `holder = card.mate`.
- **Escalation climbs the `parent` chain:** `fleet escalate` moves `holder -> parent(holder)` (e.g. `cleo -> jarvis -> captain`), so the captain's zero-inbox **Needs You** feed is strictly `state = 'held' AND holder = 'captain'`.
- **Answering hands back, never blindly launches:** `fleet answer` drops the card cleanly back to `held` for its mate (or specified holder), letting the mate decide whether to merge, close, or `fleet queue` a worker.
- **Stale-ball chase replaces delivery state machines:** SSE pushes instant updates with zero LLM polling, and one stateless periodic SQL query groups stale `held` (non-captain) and unclaimed `queued` cards by holder and emits a single `chase.due` SSE event - so restarts or missed events can never silently drop work.

## Minimal Card Server (hard red line)

The Card Server (`fleet serve`) owns **only** card state, threads, leases/fencing, dependencies, SSE push, and stale-ball chase on top of a single `node:sqlite` database with **three tables** (`cards`, `entries`, `events`) plus plain-Markdown charters (`charters/<mate>.md`) and preferences (`prefs.md`).

To keep the Card Server minimal forever and never recreate a monolithic daemon:
1. **Three tables max** (`cards`, `entries`, `events`). No delivery-ACK tables, no incident tables, no session tables, no separate holds or jobs tables.
2. **Zero harness or UI coupling:** the Card Server speaks only HTTP, JSON, and SSE. It never spawns processes, never touches Herdr, never knows what Pi, Claude Code, Codex, or containers are, and never scrapes terminal panes.
3. **Zero policy engines in the server:** autonomy boundaries live in plain-Markdown charters and mate judgment, never in hardcoded approval parsers, verbatim quote matchers, or billing proxies.

## Agents are black boxes

`fleet-v3` is bring-your-own-harness: any agent that can run the `fleet` CLI and receive HTTP/SSE events (ypi/Pi with OptChat, Claude Code, Codex, Grok Bot, Dots) is a first-class mate or worker.
Permanent mates live as interactive panes managed by the host's own launcher (`fleet mates up` in Herdr) or any terminal session; ephemeral workers live in per-task worktrees (optionally isolated in Apple `container` or Docker) with live interactive Herdr viewports when running locally and clean auto-exit on completion.
A restart, session reset, or harness swap is a non-event because durable work state lives in the Card Server and plain-Markdown charters, never inside an agent's conversation history.

## Simplicity is defended by subtraction

Always-loaded prompts stay lean and under 1,000 words total (`prompts/mate.md` and `prompts/worker.md`); any behavior that requires a 500-word prompt protocol is a design flaw to delete, not a rule to document.
Verification rigor belongs to `no-mistakes` and repository CI, with `fleet-runner` capping `no-mistakes` review loops at four rounds so runs converge instead of spiraling into speculative guards.
When a run still has open findings after four rounds, `fleet-runner` never force-ships an unpassed branch: it returns the card to `held (holder = card.mate)` so the mate can dismiss false positives with a recorded reason, rescope, or escalate.

## Scope

`fleet-v3` is not a persistent cron daemon, not a spend proxy, not a browser viewer, not a file explorer, not a CI system, and not a life-integration platform.
Recurring schedules belong to host schedulers (`launchd`, `systemd`, `cron`); personal life connectors belong to whatever external harness or skills the captain brings.
`fleet-v3` stays generic and public while personal charters, projects, and credentials stay private to each captain's setup.
Changes to `fleet-v3` itself are validated against this `VISION.md` through `no-mistakes`: captain-initiated PRs that pass may auto-merge, while external contributors' PRs remain gated under captain authority.

A change aligns when it increases parallel shipped throughput per unit of human attention, strengthens the single explicit-holder card model without breaking the three-table red line, makes another harness or host plug in cleanly, or deletes code and prompt weight without losing durability.
A change should be resisted when it adds a delivery-ACK state machine, scheduler, harness coupling, or policy lock to the Card Server, couples mates to the runner loop, scrapes live terminal panes, grows always-loaded prompts to patch agent judgment, or turns mechanical liveness into LLM polling turns.
