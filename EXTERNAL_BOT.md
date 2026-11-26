# External Bot Setup Guide (`1stmate` / `2ndmate`)

This guide is for non-coding and chat-based agent platforms (such as **Grok Bot**, **Dots**, **Muse**, or any webhook-capable bot) acting as a Fleet **`1stmate`** or domain **`2ndmate`**.

**If you are an external bot reading this page for the captain:** follow the steps below to create and configure the captain's dedicated Fleet mate bot (`1stmate`, or the requested domain `2ndmate`), wire its prompt and Card Server access, and return its incoming webhook URL so the captain's Control Host can push wakes to it via `fleet watch`.

---

## 1. Create or Configure the Mate Bot

Ask the captain only for anything missing from their message:

- **Mate name:** defaults to `1stmate` (or a domain name like `cleo` for a `2ndmate`).
- **Option A (shell access):** `BOARD_URL`, the HTTP URL of the captain's Fleet Card Server reachable from your runtime (for example `http://127.0.0.1:4100` on the same machine, or a private Tailscale/tunnel URL).
- **Option B (no shell access):** the Fleet MCP URL only (for example `http://<reachable-ip>:4102/mcp?mate=<mate>`). You do not need the Card Server URL; `BOARD_URL` stays on the Control Host process that runs `fleet mcp`.

Then create or configure a dedicated bot instance for that mate:

1. **System instructions:** load and follow [`prompts/mate.md`](https://raw.githubusercontent.com/1yian/fleet-v3/main/prompts/mate.md) as the bot's operating prompt.
2. **Identity & board config:** with Option A, bind `FLEET_MATE=<mate>` and `BOARD_URL=<url>` in the bot's environment or instructions. With Option B, attach the MCP URL for `<mate>` instead.
3. **Domain charter & preferences:** at startup (or when checking context), read your charter and the captain's preferences from Fleet (`fleet charter <mate>` / `fleet prefs` via CLI, or the read-only `fleet_charter` / `fleet_prefs` via MCP).

---

## 2. How the Bot Talks to Fleet

Prefer **Option A (`fleet` CLI)** whenever your runtime has shell access. Otherwise use **Option B (MCP)** - never call raw Card Server REST endpoints manually.

### Option A (Preferred): Shell access (`fleet` CLI on `PATH`)

Run `fleet` commands with `FLEET_MATE=<mate>` and `BOARD_URL=<url>`:

- `fleet` - live overview of open cards, counts, and advertised runner hosts
- `fleet cards --mate <mate>` / `fleet cards --holder <mate>` - list cards in your subtree or currently held by you
- `fleet view <id> --full` - inspect a card and its full thread
- `fleet dispatch --title "..." --body "..." [--mate <child>] [--project <repo> --host <host> --delivery no-mistakes|direct-pr|local]` - delegate to a `2ndmate` or spawn an isolated `crewmate` on a runner host
- `fleet queue <id> --project <repo> --host <host>` - send an existing held card to a `crewmate`
- `fleet reply <id> --text "..."` - post a thread entry
- `fleet escalate <id> --reason "..."` - escalate to your parent (`captain` for `1stmate`, or `1stmate` for a `2ndmate`)
- `fleet handoff <id> --to <mate> [--text "..."]` - pass a card to another mate
- `fleet answer <id> --text "..."` - answer an escalated card from a child mate
- `fleet snooze <id> --for 30m` - pause stale-card chases while waiting externally
- `fleet close <id> [--text "..."]` / `fleet cancel <id> --reason "..."` - finish or cancel a card
- `fleet hosts` / `fleet charter <mate>` / `fleet prefs`

### Option B (Fallback without shell access): Fleet MCP Server (`fleet mcp`)

Connect your bot to Fleet's MCP tool server instead of shelling out:

- **Streamable HTTP MCP (for remote/cloud bots such as Grok Bot, Dots, Muse):**
  Ask the captain (or their local setup agent) to run `fleet mcp --http --host <reachable-ip> --port 4102` on the Control Host with `BOARD_URL` pointing at the Card Server, then attach your bot to:
  ```text
  http://<reachable-ip>:4102/mcp?mate=<mate>
  ```
- **Stdio MCP (for local MCP-capable bots):**
  Configure an MCP server entry running:
  ```json
  {
    "command": "fleet",
    "args": ["mcp", "--mate", "1stmate"]
  }
  ```

Both MCP transports expose the exact same scoped tools for `<mate>`: `fleet_overview`, `fleet_cards`, `fleet_view`, `fleet_dispatch`, `fleet_queue`, `fleet_reply`, `fleet_escalate`, `fleet_handoff`, `fleet_answer`, `fleet_snooze`, `fleet_close`, `fleet_cancel`, `fleet_hosts`, and the read-only `fleet_charter` and `fleet_prefs`.

---

## 3. Wire Incoming Wakes (`fleet watch`)

Fleet pushes actionable wakes (new cards, escalations, answers, crewmate handbacks, completions, and stale-card chases) without polling:

1. **Create an inbound webhook endpoint** on your bot platform (plus an optional secret header such as `Authorization: Bearer <token>`) that triggers a turn on the `<mate>` bot when hit with an HTTP `POST`.
2. **Give the captain (or their local setup agent) the webhook URL and header** so they run on the Control Host:

```bash
fleet watch --mate <mate> --webhook <webhook-url> --header "Authorization: Bearer <token>"
```

Every wake arrives as `POST <webhook-url>` with `Content-Type: application/json` and this exact JSON envelope:

```json
{
  "mate": "1stmate",
  "notice": "Card #12 ...",
  "eventType": "card.created",
  "cardId": "12",
  "actor": "captain"
}
```

When a wake arrives:

- Deliver `notice` (and `cardId` if present) to the `<mate>` bot.
- The bot inspects the card (`fleet view <cardId> --full` via CLI, or `fleet_view` via MCP), handles/delegates/closes it, and only pings the captain when a real decision is needed or final work is ready.
- Return HTTP `2xx` once the wake is accepted.

_(If your bot runs on the same host and consumes a local stream instead of HTTP webhooks, run bare `fleet watch --mate <mate>` to receive the same JSON envelope as NDJSON lines on stdout.)_

---

## 4. Optional Domain `2ndmate`s on Multi-Bot Platforms

If the captain also wants domain `2ndmate`s on this platform (for example multiple bots on Grok Bot):

- Create one separate bot instance per `2ndmate` (`FLEET_MATE=<domain>`).
- On the Control Host, each `2ndmate` is registered in `~/.fleet/fleet.yaml` with `parent: 1stmate` and `mode: external`, and gets its own `fleet watch --mate <domain> --webhook <bot-webhook-url>` service.

---

## 5. Smoke Test

Once the Control Host has `fleet watch` running, confirm end-to-end delivery:

1. On the Control Host, dispatch a test card:
   ```bash
   fleet dispatch --mate <mate> --title "Smoke test: reply ok and close this card"
   ```
2. Confirm the bot receives the webhook wake, replies `ok` on the card, and closes it.
3. Verify on the Control Host with `fleet view <card-id> --full` that the card is `done`.
