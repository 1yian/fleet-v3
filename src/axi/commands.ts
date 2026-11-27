import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AxiError,
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type SessionStartHookScope,
} from "axi-sdk-js";
import { askCaptain, nextCaptainDecision } from "../board/ask.ts";
import { createHttpBoardClient, type BoardClient } from "../board/client.ts";
import {
  CARD_STATES,
  DELIVERIES,
  type Card,
  type CardState,
  type Delivery,
  type OptionalFenceInput,
  parseDurationMs,
} from "../board/types.ts";
import { loadConfig } from "../config.ts";
import { runLoop } from "../runner/loop.ts";
import { boolFlag, parseStrictFlags, stringFlag } from "./parse.ts";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../../fleet.example.yaml", import.meta.url));
const LIST_DEFAULT_LIMIT = 30;
const HOME_CARD_LIMIT = 15;
const BODY_PREVIEW_LIMIT = 240;

type CardStateFilter = CardState | "open" | "all";

const OPTIONAL_FIELDS = ["project", "host", "delivery", "epoch", "entries", "result"] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

const FIELD_READERS: Record<OptionalField, (card: Card) => string | number> = {
  project: (card) => card.project ?? "",
  host: (card) => card.host ?? "",
  delivery: (card) => card.delivery ?? "",
  epoch: (card) => card.epoch,
  entries: (card) => card.entryCount,
  result: (card) => card.result,
};

export interface FleetAxiContext {
  readonly board: () => BoardClient;
  readonly boardUrl: string;
  readonly defaultHost?: string;
  readonly actor: string;
  readonly fence: OptionalFenceInput;
}

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  cards: `fleet cards - list cards across mates and holders
Usage:
  fleet cards [--mate <name>] [--holder <name>] [--state <state>] [--fields <cols>] [--limit <n>]
Flags:
  --mate <name>      Filter to cards owned by one mate (e.g. 1stmate, docs)
  --holder <name>    Filter to cards currently held by one actor (e.g. captain, 1stmate, docs)
  --state <state>    open (default), all, waiting, queued, running, held, done, canceled
  --fields <cols>    Extra columns: ${OPTIONAL_FIELDS.join(", ")}
  --limit <n>        Max rows to show (default: ${String(LIST_DEFAULT_LIMIT)})
Examples:
  fleet cards
  fleet cards --holder captain
  fleet cards --mate docs --state all --fields project,host,result`,
  view: `fleet view - inspect one card and its thread
Usage:
  fleet view <id> [--full]
Flags:
  --full             Show untruncated card body and entries
Examples:
  fleet view 42
  fleet view 42 --full`,
  dispatch: `fleet dispatch - delegate a card to a child mate or spawn a worker for yourself
Usage:
  fleet dispatch [--mate <name>] --title "<text>" [--body "<spec>"] [--project <repo>] [--host <host>] [--delivery <mode>] [--needs <ids>]
Flags:
  --mate <name>      Target mate (defaults to $FLEET_MATE; omit --project/--host when delegating to a child mate)
  --title <text>     Required card title or intent
  --body <spec>      Optional additional spec text
  --project <repo>   Repository name for fleet-runner (mates spawn workers only for themselves)
  --host <host>      Execution host name (e.g. macbook, build-server; defaults to defaultHost in fleet.yaml; requires --project)
  --delivery <mode>  ${DELIVERIES.join(" | ")}
  --needs <ids>      Comma-separated prerequisite card IDs
Examples:
  fleet dispatch --mate docs --title "Investigate recent conversion drop"
  fleet dispatch --project example-app --host build-server --title "Fix webhook timeout"
  fleet dispatch --project example-app --title "Fix webhook timeout"   (uses defaultHost)`,
  ask: `fleet ask - put a question or decision to the captain as a captain-held card
Usage:
  fleet ask --title "<ask>" --evidence "<text>" --consequence "<text>" --recommendation "<text>" [--mate <name>]
Flags:
  --title <text>           Required one-line ask the captain must answer
  --evidence <text>        Required facts the decision rests on
  --consequence <text>     Required what happens depending on the answer
  --recommendation <text>  Required your recommended answer
  --mate <name>            Asking mate (defaults to $FLEET_MATE)
Notes:
  The card is held by the captain, so \`fleet cards --holder captain\` lists everything that awaits the captain.
  The command never produces chat text. Run \`fleet captain next\` to get the decision brief to relay to the captain.
  Record the captain's reply with \`fleet answer <id> --text "<answer>"\`, which closes the card.
Examples:
  fleet ask --title "Ship the pricing change?" --evidence "Churn is up 4%" --consequence "A ships Monday, B delays a week" --recommendation "A"`,
  captain: `fleet captain - produce the captain-facing decision text
Usage:
  fleet captain next
Notes:
  Prints plain text: exactly one decision brief (evidence, consequence, recommendation, ask) from the cards the captain holds in your subtree, then \`+N more waiting\` when others remain.
  Cards never shown come first, otherwise the least recently shown. Each showing is recorded as an internal entry on that card's thread.
  Relay the output to the captain verbatim. Do not rewrite, summarize, or add to it.
  Record the captain's reply with \`fleet answer <id> --text "<answer>"\`.
Examples:
  fleet captain next`,
  queue: `fleet queue - put a held card in the runner queue for a worker (resets retry attempts on held cards)
Usage:
  fleet queue <id> [--project <repo>] [--host <host>] [--delivery <mode>]
Flags:
  --project <repo>   Repository name for fleet-runner
  --host <host>      Execution host name (defaults to the card's host, then defaultHost in fleet.yaml)
  --delivery <mode>  ${DELIVERIES.join(" | ")}`,
  snooze: `fleet snooze - defer stale-card chases on a held card while waiting on an external event
Usage:
  fleet snooze <id> --for <duration> [--reason "<why>"]
Flags:
  --for <duration>   Duration such as 30s, 15m, 2h, or 1d (at most 2h on cards held by the captain)
  --reason <text>    Optional reason (e.g. waiting on external PR review)
Examples:
  fleet snooze 42 --for 2h --reason "Waiting for Stripe support reply"`,
  reply: `fleet reply - post an entry without transferring the card
Usage:
  fleet reply <id> --text "<message>" [--internal]
Flags:
  --text <message>   Required reply text
  --internal         Mark entry internal (quiet coordination note)
A public reply wakes only the current holder, not yourself. Use fleet answer or fleet handoff to pass work back.`,
  escalate: `fleet escalate - hand a card up to the parent mate (or captain)
Usage:
  fleet escalate <id> --reason "<evidence, question, and recommendation>" 
Flags:
  --reason <text>    Required question, evidence, and recommendation`,
  handoff: `fleet handoff - pass a card to a mate (default: its home mate)
Usage:
  fleet handoff <id> [--to <mate>] [--text "<context>"]
Flags:
  --to <mate>        Target holder (default: card's home mate)
  --text <message>   Optional handoff note`,
  answer: `fleet answer - answer an escalated card and hand it back to its mate; answering a \`fleet ask\` card records the answer and closes it
Usage:
  fleet answer <id> --text "<answer>"
Flags:
  --text <message>   Required answer text`,
  close: `fleet close - mark a card done and unblock waiting dependents (captain and mates only; workers exit cleanly or hand off)
Usage:
  fleet close <id> [--result "<summary>"]
Flags:
  --result <text>    Optional completion summary`,
  cancel: `fleet cancel - cancel an open or obsolete card
Usage:
  fleet cancel <id> --reason "<why>"
Flags:
  --reason <text>    Required cancellation reason`,
  hosts: `fleet hosts - list runner hosts advertised on the Card Server
Usage:
  fleet hosts`,
  charter: `fleet charter - read or update a mate's plain-Markdown charter
Usage:
  fleet charter <mate> [--set "<charter text>"]
Flags:
  --set <text>       Write or replace the mate's charter`,
  prefs: `fleet prefs - read or update captain-wide preferences
Usage:
  fleet prefs [--set "<preferences text>"]
Flags:
  --set <text>       Write or replace captain-wide preferences`,
  serve: `fleet serve - run the minimal 3-table SQLite Card Server (HTTP + SSE)
Usage:
  fleet serve [--dir <path>] [--host <addr>] [--port <n>] [--config <path>]
Flags:
  --dir <path>       Data directory for fleet.db, charters/, and prefs.md
  --host <addr>      Bind host (default: 127.0.0.1)
  --port <n>         Bind port (default: 4100)
  --config <path>    Path to fleet.yaml for defaults and mate parent hierarchy`,
  init: `fleet init - create fleet.yaml from fleet.example.yaml
Usage:
  fleet init [--config <path>]`,
  setup: `fleet setup - install or inspect session-start hooks
Usage:
  fleet setup hooks [--scope user|project] [--status | --uninstall]`,
  run: `fleet run - run fleet-runner for this host
Usage:
  fleet run [--config <path>] [--once]`,
  web: `fleet web - serve the visual Kanban viewport proxying to the Card Server
Usage:
  fleet web [--host <addr>] [--port <n>]`,
};

function requireBoard(ctx: FleetAxiContext | undefined): FleetAxiContext {
  if (ctx === undefined) {
    throw new AxiError("No Card Server configured", "config", [
      "Set BOARD_URL or create fleet.yaml with `fleet init`",
    ]);
  }
  return ctx;
}

function truncateText(text: string, maxChars: number): string {
  const single = text.replaceAll(/\s+/gu, " ").trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatCardRow(card: Card, extraFields: readonly OptionalField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: card.id,
    mate: card.mate,
    state: card.state,
    holder: card.holder,
    title: truncateText(card.title, 96),
  };
  for (const field of extraFields) {
    row[field] = FIELD_READERS[field](card);
  }
  return row;
}

function scopeOf(active: FleetAxiContext): string | undefined {
  if (active.fence.epoch !== undefined) return undefined;
  return active.actor === "captain" ? undefined : active.actor;
}

export async function homeCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  parseStrictFlags("fleet", args, {}, "Run `fleet --help` for commands.");
  const overview = await active.board().getOverview(scopeOf(active));

  const summaryParts: string[] = [];
  if (overview.counts.needsCaptain > 0) {
    summaryParts.push(`${String(overview.counts.needsCaptain)} needs captain`);
  }
  if (overview.counts.held > 0) summaryParts.push(`${String(overview.counts.held)} held`);
  if (overview.counts.running > 0) summaryParts.push(`${String(overview.counts.running)} running`);
  if (overview.counts.queued > 0) summaryParts.push(`${String(overview.counts.queued)} queued`);
  if (overview.counts.waiting > 0) summaryParts.push(`${String(overview.counts.waiting)} waiting`);

  const countsLine =
    overview.counts.open === 0
      ? "0 open cards"
      : `${summaryParts.join(", ")} (${String(overview.counts.open)} open total)`;

  const hosts = overview.hosts.map((host) => ({
    host: host.host,
    mode: host.mode,
    viewport: host.viewport,
    repos: host.repos.join(", "),
  }));

  const cards = overview.cards.slice(0, HOME_CARD_LIMIT).map((card) => formatCardRow(card, []));
  const help = [
    "Run `fleet view <id>` to inspect a card and its thread",
    'Run `fleet dispatch --mate <name> --title "<text>" [--project <repo>] [--host <host>]` to create a card',
  ];
  if (overview.counts.needsCaptain > 0) {
    help.unshift("Run `fleet cards --holder captain` to inspect cards waiting on the captain");
  }
  if (overview.cards.length > HOME_CARD_LIMIT) {
    help.push(`Run \`fleet cards --limit ${String(overview.cards.length)}\` to see all open cards`);
  }

  return {
    board: active.boardUrl,
    counts: countsLine,
    hosts: hosts.length > 0 ? hosts : "0 runner hosts advertised yet",
    cards: cards.length > 0 ? cards : "0 open cards",
    help,
  };
}

export async function cardsCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["cards"] ?? "";
  const parsed = parseStrictFlags(
    "cards",
    args,
    {
      mate: { type: "string" },
      holder: { type: "string" },
      state: { type: "string" },
      fields: { type: "string" },
      limit: { type: "string" },
    },
    helpBlock,
  );

  const stateArg = stringFlag(parsed.values, "state") ?? "open";
  const allStates: readonly CardStateFilter[] = ["open", "all", ...CARD_STATES];
  const state = allStates.find((each) => each === stateArg);
  if (state === undefined) {
    throw new AxiError(`invalid --state "${stateArg}"`, "VALIDATION_ERROR", [
      `valid values: ${allStates.join(", ")}`,
    ]);
  }

  const fieldsRaw = stringFlag(parsed.values, "fields");
  const requestedFields =
    fieldsRaw === undefined
      ? []
      : fieldsRaw
          .split(",")
          .map((each) => each.trim())
          .filter((each) => each !== "");
  const unknownFields = requestedFields.filter(
    (field) => !OPTIONAL_FIELDS.some((allowed) => allowed === field),
  );
  if (unknownFields.length > 0) {
    throw new AxiError(`unknown --fields: ${unknownFields.join(", ")}`, "VALIDATION_ERROR", [
      `valid fields: ${OPTIONAL_FIELDS.join(", ")}`,
    ]);
  }
  const extraFields: OptionalField[] = requestedFields.flatMap((field) => {
    const matched = OPTIONAL_FIELDS.find((allowed) => allowed === field);
    return matched === undefined ? [] : [matched];
  });

  const limitRaw = stringFlag(parsed.values, "limit");
  const limit = limitRaw === undefined ? LIST_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AxiError("--limit must be a positive integer", "VALIDATION_ERROR", [helpBlock]);
  }

  const mate = stringFlag(parsed.values, "mate");
  const holder = stringFlag(parsed.values, "holder");
  const scope = scopeOf(active);
  const page = await active.board().listCards({
    ...(mate !== undefined ? { mate } : {}),
    ...(holder !== undefined ? { holder } : {}),
    ...(scope !== undefined ? { scope } : {}),
    state,
    limit,
  });

  if (page.total === 0) {
    return {
      cards: `0 ${state} cards found`,
      help: [
        'Run `fleet dispatch --mate <name> --title "<text>"` to create a card',
        ...(state === "open" ? ["Run `fleet cards --state all` to include closed cards"] : []),
      ],
    };
  }

  const shown = page.cards.map((card) => formatCardRow(card, extraFields));
  const help = ["Run `fleet view <id>` to inspect a card and its thread"];
  if (page.total > shown.length) {
    const continuation = [
      "fleet cards",
      ...(mate !== undefined ? [`--mate ${mate}`] : []),
      ...(holder !== undefined ? [`--holder ${holder}`] : []),
      ...(state === "open" ? [] : [`--state ${state}`]),
      ...(extraFields.length > 0 ? [`--fields ${extraFields.join(",")}`] : []),
      `--limit ${String(page.total)}`,
    ].join(" ");
    help.push(`Run \`${continuation}\` to see all ${String(page.total)}`);
  }
  return {
    count: `${String(shown.length)} of ${String(page.total)} total`,
    cards: shown,
    help,
  };
}

export async function viewCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["view"] ?? "";
  const parsed = parseStrictFlags("view", args, { full: { type: "boolean" } }, helpBlock);
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `view`", "VALIDATION_ERROR", [helpBlock]);
  }
  const full = boolFlag(parsed.values, "full");
  const { card, entries } = await active.board().getThread(id, scopeOf(active));

  let truncated = false;
  const body =
    full || card.body.length <= BODY_PREVIEW_LIMIT
      ? card.body
      : (() => {
          truncated = true;
          return truncateText(card.body, BODY_PREVIEW_LIMIT);
        })();

  const formattedEntries = entries.map((entry) => {
    const text =
      full || entry.text.length <= BODY_PREVIEW_LIMIT
        ? entry.text
        : (() => {
            truncated = true;
            return truncateText(entry.text, BODY_PREVIEW_LIMIT);
          })();
    const formatted: Record<string, unknown> = {
      id: entry.id,
      by: entry.by,
      kind: entry.kind,
      text,
    };
    if (entry.internal) formatted["internal"] = true;
    return formatted;
  });

  return {
    card: {
      id: card.id,
      mate: card.mate,
      state: card.state,
      holder: card.holder,
      title: card.title,
      ...(body.length > 0 ? { body } : {}),
      ...(card.project !== null ? { project: card.project } : {}),
      ...(card.host !== null ? { host: card.host } : {}),
      ...(card.delivery !== null ? { delivery: card.delivery } : {}),
      ...(card.needs.length > 0 ? { needs: card.needs } : {}),
      epoch: card.epoch,
      ...(card.snoozeUntil !== null
        ? { snoozeUntil: new Date(card.snoozeUntil).toISOString() }
        : {}),
      ...(card.result.length > 0 ? { result: card.result } : {}),
    },
    entries: formattedEntries.length > 0 ? formattedEntries : "0 entries",
    ...(truncated ? { help: [`Run \`fleet view ${card.id} --full\` for untruncated text`] } : {}),
  };
}

function parseDeliveryFlag(raw: string | undefined, helpBlock: string): Delivery | undefined {
  if (raw === undefined) return undefined;
  const matched = DELIVERIES.find((each) => each === raw);
  if (matched === undefined) {
    throw new AxiError(`invalid --delivery "${raw}"`, "VALIDATION_ERROR", [
      `valid values: ${DELIVERIES.join(", ")}`,
      helpBlock,
    ]);
  }
  return matched;
}

async function resolveDefaultHost(
  active: FleetAxiContext,
  helpBlock: string,
): Promise<string | undefined> {
  const { defaultHost } = active;
  if (defaultHost === undefined) return undefined;
  const hosts = await active.board().listHosts();
  if (!hosts.some((each) => each.host === defaultHost)) {
    throw new AxiError(
      `defaultHost "${defaultHost}" in fleet.yaml is not an advertised runner host`,
      "VALIDATION_ERROR",
      [`Known hosts: ${hosts.map((each) => each.host).join(", ") || "none"}`, helpBlock],
    );
  }
  return defaultHost;
}

export async function dispatchCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["dispatch"] ?? "";
  const parsed = parseStrictFlags(
    "dispatch",
    args,
    {
      mate: { type: "string" },
      title: { type: "string", required: true },
      body: { type: "string" },
      project: { type: "string" },
      host: { type: "string" },
      delivery: { type: "string" },
      needs: { type: "string" },
    },
    helpBlock,
  );

  const explicitMate = stringFlag(parsed.values, "mate");
  const inferredMate = scopeOf(active);
  const mate = explicitMate ?? inferredMate ?? "";
  if (mate.length === 0) {
    throw new AxiError("--mate is required when dispatching as captain", "VALIDATION_ERROR", [
      helpBlock,
    ]);
  }
  const title = stringFlag(parsed.values, "title") ?? "";
  const body = stringFlag(parsed.values, "body");
  const project = stringFlag(parsed.values, "project");
  const host =
    stringFlag(parsed.values, "host") ??
    (project === undefined ? undefined : await resolveDefaultHost(active, helpBlock));
  const delivery = parseDeliveryFlag(stringFlag(parsed.values, "delivery"), helpBlock);
  const needsRaw = stringFlag(parsed.values, "needs");
  const needs =
    needsRaw === undefined
      ? undefined
      : needsRaw
          .split(",")
          .map((each) => each.trim())
          .filter((each) => each !== "");

  const card = await active.board().createCard({
    mate,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(needs !== undefined && needs.length > 0 ? { needs } : {}),
    actor: active.actor,
  });

  return {
    card: {
      id: card.id,
      mate: card.mate,
      state: card.state,
      holder: card.holder,
      title: card.title,
    },
    help: [`Run \`fleet view ${card.id}\` to track progress`],
  };
}

export async function askCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["ask"] ?? "";
  const parsed = parseStrictFlags(
    "ask",
    args,
    {
      mate: { type: "string" },
      title: { type: "string" },
      evidence: { type: "string" },
      consequence: { type: "string" },
      recommendation: { type: "string" },
    },
    helpBlock,
  );
  const mate = stringFlag(parsed.values, "mate") ?? scopeOf(active) ?? "";
  const title = stringFlag(parsed.values, "title") ?? "";
  const evidence = stringFlag(parsed.values, "evidence") ?? "";
  const consequence = stringFlag(parsed.values, "consequence") ?? "";
  const recommendation = stringFlag(parsed.values, "recommendation") ?? "";
  if (
    [mate, title, evidence, consequence, recommendation].some((value) => value.trim().length === 0)
  ) {
    throw new AxiError(
      "--title, --evidence, --consequence, and --recommendation are required (and --mate when asking as captain)",
      "VALIDATION_ERROR",
      [helpBlock],
    );
  }
  const card = await askCaptain(active.board(), {
    mate,
    title,
    evidence,
    consequence,
    recommendation,
  });
  return {
    card: { id: card.id, holder: card.holder, title: card.title },
    help: ["Run `fleet captain next` to get the decision brief to relay to the captain"],
  };
}

export async function captainCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<string> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["captain"] ?? "";
  const parsed = parseStrictFlags("captain", args, {}, helpBlock);
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "next") {
    throw new AxiError("`captain` takes exactly one subcommand: next", "VALIDATION_ERROR", [
      helpBlock,
    ]);
  }
  const decision = await nextCaptainDecision(active.board(), active.actor, scopeOf(active));
  return decision === null ? "No decisions waiting for the captain" : decision.text;
}

export async function queueCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["queue"] ?? "";
  const parsed = parseStrictFlags(
    "queue",
    args,
    {
      project: { type: "string" },
      host: { type: "string" },
      delivery: { type: "string" },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `queue`", "VALIDATION_ERROR", [helpBlock]);
  }
  const project = stringFlag(parsed.values, "project");
  let host = stringFlag(parsed.values, "host");
  if (host === undefined) {
    const { card: existing } = await active.board().getThread(id, scopeOf(active));
    if (existing.host === null) host = await resolveDefaultHost(active, helpBlock);
  }
  const delivery = parseDeliveryFlag(stringFlag(parsed.values, "delivery"), helpBlock);
  const card = await active.board().queueCard(id, {
    ...active.fence,
    ...(project !== undefined ? { project } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    actor: active.actor,
  });
  return {
    card: {
      id: card.id,
      state: card.state,
      holder: card.holder,
      host: card.host,
      project: card.project,
    },
  };
}

export async function replyCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["reply"] ?? "";
  const parsed = parseStrictFlags(
    "reply",
    args,
    {
      text: { type: "string", required: true },
      internal: { type: "boolean" },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `reply`", "VALIDATION_ERROR", [helpBlock]);
  }
  const text = stringFlag(parsed.values, "text") ?? "";
  const internal = boolFlag(parsed.values, "internal");
  const { entry, holder } = await active.board().postEntry(id, {
    ...active.fence,
    text,
    by: active.actor,
    internal,
  });
  const isHolder =
    holder !== undefined &&
    (holder === entry.by || (holder === "worker" && active.fence.epoch !== undefined));
  return {
    reply: { id: entry.id, cardId: entry.cardId, internal: entry.internal },
    ...(!entry.internal && isHolder
      ? {
          warning:
            "Reply saved, but nobody was woken because you hold this card. Use fleet answer or fleet handoff to pass work back.",
        }
      : {}),
  };
}

export async function escalateCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["escalate"] ?? "";
  const parsed = parseStrictFlags(
    "escalate",
    args,
    {
      reason: { type: "string", required: true },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `escalate`", "VALIDATION_ERROR", [helpBlock]);
  }
  const reason = stringFlag(parsed.values, "reason") ?? "";
  const card = await active.board().escalateCard(id, {
    ...active.fence,
    reason,
    actor: active.actor,
  });
  return {
    card: { id: card.id, state: card.state, holder: card.holder, reason: card.result },
  };
}

export async function handoffCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["handoff"] ?? "";
  const parsed = parseStrictFlags(
    "handoff",
    args,
    {
      to: { type: "string" },
      text: { type: "string" },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `handoff`", "VALIDATION_ERROR", [helpBlock]);
  }
  const to = stringFlag(parsed.values, "to");
  const text = stringFlag(parsed.values, "text");
  const card = await active.board().handoffCard(id, {
    ...active.fence,
    ...(to !== undefined ? { to } : {}),
    ...(text !== undefined ? { text } : {}),
    actor: active.actor,
  });
  return { card: { id: card.id, state: card.state, holder: card.holder } };
}

export async function answerCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["answer"] ?? "";
  const parsed = parseStrictFlags(
    "answer",
    args,
    { text: { type: "string", required: true } },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `answer`", "VALIDATION_ERROR", [helpBlock]);
  }
  const text = stringFlag(parsed.values, "text") ?? "";
  const card = await active.board().answerCard(id, {
    ...active.fence,
    text,
    actor: active.actor,
  });
  return { card: { id: card.id, state: card.state, holder: card.holder } };
}

export async function snoozeCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["snooze"] ?? "";
  const parsed = parseStrictFlags(
    "snooze",
    args,
    {
      for: { type: "string", required: true },
      reason: { type: "string" },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `snooze`", "VALIDATION_ERROR", [helpBlock]);
  }
  const rawDuration = stringFlag(parsed.values, "for") ?? "";
  const durationMs = parseDurationMs(rawDuration);
  if (durationMs === undefined) {
    throw new AxiError(
      `invalid --for duration "${rawDuration}" (use e.g. 30s, 15m, 2h, 1d)`,
      "VALIDATION_ERROR",
      [helpBlock],
    );
  }
  const reason = stringFlag(parsed.values, "reason");
  const until = Date.now() + durationMs;
  const card = await active.board().snoozeCard(id, {
    ...active.fence,
    until,
    ...(reason !== undefined ? { reason } : {}),
    actor: active.actor,
  });
  return {
    card: {
      id: card.id,
      state: card.state,
      holder: card.holder,
      snoozeUntil: card.snoozeUntil !== null ? new Date(card.snoozeUntil).toISOString() : null,
    },
  };
}

export async function closeCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["close"] ?? "";
  const parsed = parseStrictFlags("close", args, { result: { type: "string" } }, helpBlock);
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `close`", "VALIDATION_ERROR", [helpBlock]);
  }
  const result = stringFlag(parsed.values, "result");
  const card = await active.board().closeCard(id, {
    ...active.fence,
    ...(result !== undefined ? { result } : {}),
    actor: active.actor,
  });
  return { card: { id: card.id, state: card.state, result: card.result } };
}

export async function cancelCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["cancel"] ?? "";
  const parsed = parseStrictFlags(
    "cancel",
    args,
    { reason: { type: "string", required: true } },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("card <id> is required for `cancel`", "VALIDATION_ERROR", [helpBlock]);
  }
  const reason = stringFlag(parsed.values, "reason") ?? "";
  const card = await active.board().cancelCard(id, {
    ...active.fence,
    reason,
    actor: active.actor,
  });
  return { card: { id: card.id, state: card.state, reason: card.result } };
}

export async function hostsCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  parseStrictFlags("hosts", args, {}, COMMAND_HELP["hosts"] ?? "");
  const hosts = await active.board().listHosts();
  if (hosts.length === 0) {
    return {
      hosts: "0 runner hosts advertised yet",
      help: ["Start a host runner with `fleet run --config fleet.yaml`"],
    };
  }
  return {
    hosts: hosts.map((host) => ({
      host: host.host,
      mode: host.mode,
      viewport: host.viewport,
      repos: host.repos.join(", "),
    })),
  };
}

export async function charterCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["charter"] ?? "";
  const parsed = parseStrictFlags("charter", args, { set: { type: "string" } }, helpBlock);
  const [mate] = parsed.positionals;
  if (mate === undefined) {
    throw new AxiError("<mate> is required for `charter`", "VALIDATION_ERROR", [helpBlock]);
  }
  const setText = stringFlag(parsed.values, "set");
  if (setText !== undefined) {
    const text = await active.board().setCharter(mate, setText);
    return { charter: { mate, updated: true, text } };
  }
  const text = await active.board().getCharter(mate);
  if (text.trim().length === 0) {
    return {
      charter: `0 charter set for ${mate}`,
      help: [`Run \`fleet charter ${mate} --set "<autonomy rules>"\` to publish one`],
    };
  }
  return { charter: { mate, text } };
}

export async function prefsCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["prefs"] ?? "";
  const parsed = parseStrictFlags("prefs", args, { set: { type: "string" } }, helpBlock);
  const setText = stringFlag(parsed.values, "set");
  if (setText !== undefined) {
    const text = await active.board().setPrefs(setText);
    return { prefs: { updated: true, text } };
  }
  const text = await active.board().getPrefs();
  if (text.trim().length === 0) {
    return {
      prefs: "0 captain preferences set",
      help: ['Run `fleet prefs --set "<preferences>"` to publish them'],
    };
  }
  return { prefs: { text } };
}

export function initCommand(args: string[]): Record<string, unknown> {
  const helpBlock = COMMAND_HELP["init"] ?? "";
  const parsed = parseStrictFlags("init", args, { config: { type: "string" } }, helpBlock);
  const target = resolve(process.cwd(), stringFlag(parsed.values, "config") ?? "fleet.yaml");
  if (existsSync(target)) {
    return { config: `${target} already exists (no-op)` };
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(EXAMPLE_CONFIG, target);
  return {
    config: { path: target, created: true },
    help: [`Edit ${target}, then run \`fleet serve\` and \`fleet run --config ${target}\``],
  };
}

export function setupCommand(args: string[]): Record<string, unknown> {
  const helpBlock = COMMAND_HELP["setup"] ?? "";
  const parsed = parseStrictFlags(
    "setup",
    args,
    {
      scope: { type: "string" },
      status: { type: "boolean" },
      uninstall: { type: "boolean" },
    },
    helpBlock,
  );
  const [target] = parsed.positionals;
  if (target !== "hooks") {
    throw new AxiError('`fleet setup` requires subcommand "hooks"', "VALIDATION_ERROR", [
      helpBlock,
    ]);
  }
  const scopeRaw = stringFlag(parsed.values, "scope") ?? "user";
  if (scopeRaw !== "user" && scopeRaw !== "project") {
    throw new AxiError(`invalid --scope "${scopeRaw}"`, "VALIDATION_ERROR", [
      "valid values: user, project",
    ]);
  }
  const scope: SessionStartHookScope = scopeRaw;
  const opts = { marker: "fleet", scope };
  if (boolFlag(parsed.values, "status")) {
    return { hooks: sessionStartHookStatus(opts) };
  }
  if (boolFlag(parsed.values, "uninstall")) {
    uninstallSessionStartHooks(opts);
    return { hooks: { uninstalled: true, scope } };
  }
  installSessionStartHooks({ ...opts, binaryNames: ["fleet"] });
  return { hooks: sessionStartHookStatus(opts) };
}

export async function runCommand(args: string[]): Promise<Record<string, unknown>> {
  const helpBlock = COMMAND_HELP["run"] ?? "";
  const parsed = parseStrictFlags(
    "run",
    args,
    {
      config: { type: "string" },
      once: { type: "boolean" },
    },
    helpBlock,
  );
  const config = loadConfig(stringFlag(parsed.values, "config"));
  const client = createHttpBoardClient(config.boardUrl);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const handled = await runLoop(client, config, {
      once: boolFlag(parsed.values, "once"),
      signal: controller.signal,
    });
    return { runner: { host: config.host, handled } };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
