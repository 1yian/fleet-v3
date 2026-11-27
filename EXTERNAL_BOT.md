# External Bot Setup Guide (`1stmate` / `2ndmate`)

This guide is for non-coding and chat-based agent platforms (such as **Grok Bot**, **Dots**, **Muse**, or any webhook-capable bot) acting as a Fleet **`1stmate`** or domain **`2ndmate`**.

**If you are an external bot reading this page for the captain:** follow the steps below to create a dedicated Fleet mate bot (`1stmate`, or a new separate bot for the requested domain `2ndmate`), wire its prompt and Fleet access, and return the wake path the captain's Control Host needs (an incoming webhook URL for `fleet watch`, or a `card.wake` subscription for `fleet events`). If you also have shell access on the Control Host and the captain asked you to set up Fleet itself, run [`SETUP.md`](https://github.com/1yian/fleet-v3/blob/main/SETUP.md) together with this guide directly.

Fleet has one way to act and two ways to be woken:

- **Act:** the `fleet` CLI. Fleet exposes no tool server; never call raw Card Server REST endpoints.
- **Wake with a webhook:** `fleet watch --webhook` for bots that have an inbound webhook (section 3).
- **Wake with MCP Events:** `fleet events` for ChatGPT Dots and any MCP Events client (section 4).

---

## 1. Create or Configure the Mate Bot

Ask the captain only for anything missing from their message:

- **Mate name:** defaults to `1stmate` (or a domain name like `cleo` for a `2ndmate`).
- **`BOARD_URL`:** the HTTP URL of the captain's Fleet Card Server as reachable from the machine where the bot runs `fleet` (for example `http://127.0.0.1:4100` on the same machine).

Then create or configure a dedicated bot instance for that mate:

1. **System instructions:** use the [Grok Bot template](templates/grok-bot.md) for your configured parent. Save the profile, shared operating prompt, and one-line webhook routine as directed there. Other bot platforms can use the same template.
2. **Identity & board config:** create a bot-local file `fleet-<mate>.env` in the working directory of the machine where the bot runs `fleet`, containing `export FLEET_MATE=<mate>` and `export BOARD_URL=<url>`.
3. **Domain charter & preferences:** at startup (or when checking context), read your charter and the captain's preferences with `fleet charter <mate>` and `fleet prefs`.

---

## 2. How the Bot Talks to Fleet

Run each `fleet` command as `. ./fleet-<mate>.env && fleet ...` in one shell invocation (it exports `FLEET_MATE=<mate>` and `BOARD_URL=<url>`):

- `fleet` - live overview of open cards, counts, and advertised runner hosts
- `fleet cards --mate <mate>` / `fleet cards --holder <mate>` - list cards in your subtree or currently held by you
- `fleet view <id> --full` - inspect a card and its full thread
- `fleet dispatch --title "..." --body "..." [--mate <child>] [--project <repo> --host <host> --delivery no-mistakes|direct-pr|local]` - delegate to a `2ndmate` or spawn an isolated `crewmate` on a runner host
- `fleet queue <id> --project <repo> --host <host>` - send an existing held card to a `crewmate`
- `fleet reply <id> --text "..." [--internal]` - post a thread entry (use `--internal` for quiet coordination notes)
- `fleet escalate <id> --reason "..."` - escalate to your parent (`captain` for `1stmate`, or `1stmate` for a `2ndmate`)
- `fleet handoff <id> --to <mate> [--text "..."]` - pass a card to another mate
- `fleet answer <id> --text "..."` - answer an escalated card from a child mate
- `fleet snooze <id> --for 30m` - pause stale-card chases while waiting externally
- `fleet close <id> [--result "..."]` / `fleet cancel <id> --reason "..."` - finish or cancel a card
- `fleet hosts` / `fleet charter <mate>` / `fleet prefs`

A bot that cannot run the `fleet` CLI anywhere cannot act as a mate. Section 4 explains how a ChatGPT Dot gets the CLI.

---

## 3. Wire Incoming Wakes with a Webhook (`fleet watch`)

Register the bot under `mates.items` in `fleet.yaml` with its `name`, `parent`, and `mode: external`. This keeps it in the same routing tree as a local mate without launching a Fleet terminal. Dispatch and handoff create the same Card Server events for either mode. Setting the mode alone does not deliver wakes: run `fleet watch` for the bot's mate name to forward its filtered events (new cards, handoffs, escalations, answers, crewmate handbacks, completions, and stale-card chases).

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

Pass the webhook body's `notice` and `cardId` (if present) to the bot and return HTTP `2xx` once the wake is accepted. Use the top-level or child wake line from the [Grok Bot template](templates/grok-bot.md).

_(If your bot runs on the same host and consumes a local stream instead of HTTP webhooks, run bare `fleet watch --mate <mate>` to receive the same JSON envelope as NDJSON lines on stdout.)_

---

## 4. ChatGPT Dots: Wake with MCP Events, Act with the CLI

A Dot is woken by [MCP Events](https://developers.openai.com/plugins/build/mcp-events) and acts with the `fleet` CLI. `fleet events` is the wake half: an MCP server that advertises only the `events` capability (no tools) and delivers signed webhooks to the Dot.

### 4.1 How a Dot gets the `fleet` CLI

A Dot lives in OpenAI's cloud with its own cloud computer, so a plain Dot does not have `fleet` and cannot reach a private `BOARD_URL`. Findings from OpenAI's Dots documentation (checked 2026-11; not yet exercised against a live Dot):

- **Connected computer (recommended).** The captain connects their own computer to the Dot: ChatGPT desktop app, the dot's profile, **Computers**, **Allow**, **Allow access**. The Dot then runs commands on that computer through local tasks, where `fleet` is on `PATH` and `BOARD_URL` can stay `http://127.0.0.1:4100`. The computer must be online with the ChatGPT app open, and workspace admins must allow local computer access (it is off by default on Enterprise). Nothing about the Card Server is exposed.
- **Dot cloud computer (not recommended).** The Dot can run code and shell commands there, but internet access for those commands is a workspace setting (**Cloud network access**), OpenAI does not document installing software, and the cloud computer cannot reach `localhost` or a private network. It would need `fleet` installed from the repository plus a public `BOARD_URL`. The Card Server has no authentication, so do not publish it for this.

Tell the Dot to run `fleet` through its connected computer, with `FLEET_MATE=<mate>` and `BOARD_URL=<url>` set there.

### 4.2 Run the wake bridge

On the Control Host, run one bridge per mate:

```bash
FLEET_EVENTS_TOKEN="$(openssl rand -hex 24)" fleet events --mate <mate> --port 4102
```

- `FLEET_EVENTS_TOKEN` is required (24 or more characters of letters, digits, `.`, `_`, `~`, `-`). The endpoint answers `401` without it.
- It binds `127.0.0.1` by default. Publish it through a public HTTPS tunnel that forwards to that port (for example `cloudflared tunnel --url http://127.0.0.1:4102` or `tailscale funnel 4102`). ChatGPT only calls HTTPS endpoints, and the bridge only delivers to public HTTPS callbacks.
- Subscriptions persist in `~/.fleet/events/<mate>.json` (mode `0600`, includes the signing secrets) so they survive restarts. Override with `--state <path>`.
- Add `--allow-local-callbacks` only to test against a local receiver; it accepts `http` and private-address callbacks.

### 4.3 Authentication

ChatGPT connects to an MCP server with OAuth or with no authentication; it cannot send a custom API key or static header. The bridge therefore accepts the token either way:

- `Authorization: Bearer <token>` for MCP Events clients that can send it.
- The URL path `/mcp/<token>` for ChatGPT. Add the plugin with the URL `https://<tunnel-host>/mcp/<token>` and **No authentication**. Treat the URL as a secret.

To lock it down further, enforce OpenAI's client certificate (mTLS) or an egress IP allowlist at the tunnel; see [Authentication](https://developers.openai.com/plugins/build/auth). Anyone holding the token can subscribe their own callback and read wake summaries, so rotate it by restarting with a new `FLEET_EVENTS_TOKEN` and updating the plugin URL.

### 4.4 Subscribe the Dot

1. In ChatGPT, add the plugin with the URL above and rescan it. The `card.wake` event appears next to the plugin.
2. Tell the Dot, in the chat where it should react:

   > Subscribe to the Fleet `card.wake` event. When it fires, run `fleet view <cardId> --full` on my connected computer to read the card, handle it as my `<mate>` mate per `fleet charter <mate>`, and only message me when I need to decide something.

3. ChatGPT calls `events/subscribe`; the bridge verifies the callback with a signed challenge and stores the subscription. ChatGPT refreshes it before `refreshBefore` (default lifetime 24 hours) and `events/unsubscribe` removes it.

### 4.5 What a wake looks like

```json
{
  "eventId": "evt_6f1c...",
  "name": "card.wake",
  "timestamp": "2026-11-26T23:59:00.000Z",
  "data": {
    "mate": "1stmate",
    "eventType": "card.created",
    "cardId": "12",
    "actor": "captain",
    "summary": "[fleet] New card #12 in your court: ..."
  },
  "cursor": null
}
```

Deliveries are signed with the Standard Webhooks scheme using the subscription's `whsec_` secret, retried up to three times with exponential backoff (never on `410` or `413`), and capped at 256 KiB. `410` drops the subscription. A refresh with a new secret signs with both secrets for ten minutes.

Dots currently may not receive the event `data` at all ([openai/codex#50714](https://github.com/openai/codex/issues/50714)). The `data` only names the card, so the Dot must always re-read the card with `fleet view <cardId> --full` and never act on the summary alone. If a wake arrives with no data, the Dot should run `fleet cards --holder <mate>` to find what needs attention.

Events missed while the bridge is down are not replayed (`cursor` is `null`). Open cards still surface through Fleet's stale-card chase, which wakes the mate again.

---

## 5. Optional Domain `2ndmate`s on Multi-Bot Platforms

If the captain also wants domain `2ndmate`s on this platform (for example multiple bots on Grok Bot):

- **Create a new, separate bot instance** for each `2ndmate` (`FLEET_MATE=<domain>`, `parent: 1stmate`) with its own domain charter and its own incoming webhook URL - do not reuse the `1stmate` bot for a `2ndmate`.
- On the Control Host, each `2ndmate` is registered in `~/.fleet/fleet.yaml` with `parent: 1stmate` and `mode: external`, and gets its own `fleet watch --mate <domain> --webhook <bot-webhook-url>` service (or its own `fleet events --mate <domain>` bridge on its own port and token for a Dot).

---

## 6. Publish Prompt Updates from the Control Host

Add `fleet mates prompt-updates HEAD --config <fleet.yaml>` to the Control Host's Fleet deployment hook, after the checkout moves to the published revision. To follow merges without a deployment hook, schedule this with the host scheduler instead:

```bash
cd /path/to/fleet-v3 &&
git fetch origin main &&
fleet mates prompt-updates FETCH_HEAD --config /path/to/fleet.yaml
```

Run this as the Control Host operator, without `FLEET_MATE`, from a full checkout of `1yian/fleet-v3`. Use a single hook or scheduled job per Card Server and run it serially. The revision must already be on GitHub because each card links to that exact revision.

Fleet sends one card to each configured external mate on its first run and thereafter only when the Git content hash of `prompts/mate.md` or the Grok Bot template differs from the last version sent to that mate. Closed cards still count as delivery records. Unrelated merges or releases send nothing. Each recipient applies the linked instructions to its own saved profile and routine, then closes the card.

---

## 7. Smoke Test

Once the Control Host has `fleet watch` or `fleet events` running, confirm end-to-end delivery:

1. On the Control Host, dispatch a test card:
   ```bash
   fleet dispatch --mate <mate> --title "Smoke test: reply ok and close this card"
   ```
2. Confirm the bot receives the wake, replies `ok` on the card, and closes it.
3. Verify on the Control Host with `fleet view <card-id> --full` that the card is `done`.
