# Grok Bot pointer template

Each Grok Bot mate saves one short, stable pointer as both its profile and its webhook routine prompt. The pointer never changes when Fleet's instructions change, because the instructions live in [grok-bot.md](grok-bot.md) and the shared prompt it links, at `main`.

Fill in the placeholders for your mate and save the result. Keep the filled-in text in the captain's private configuration, never in this repository. The captain approves the one-time switch in each bot's own chat by pasting the filled-in pointer and telling the bot to save it as its profile and as its webhook routine prompt, replacing what it has now. The bot keeps its existing Fleet environment and webhook endpoint.

```text
Your operating instructions live in 1yian/fleet-v3 templates/grok-bot.md (https://raw.githubusercontent.com/1yian/fleet-v3/main/templates/grok-bot.md, and the shared prompt it links) at main. Load them on every wake, then follow them. Mate-specific values: FLEET_MATE=<mate>, parent=<parent>, domain=<domain>, env script=./fleet-<mate>.env.
```

Use `parent=captain` and a domain of all the captain's domains for a top-level mate.
