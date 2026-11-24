import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board, MessageView, ThreadSummaryView } from "@vercel/board";
import {
  AxiError,
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type SessionStartHookScope,
} from "axi-sdk-js";
import { DELIVERIES, loadConfig } from "../config.ts";
import { runLoop } from "../runner/loop.ts";
import { boolFlag, parseStrictFlags, stringFlag } from "./parse.ts";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../../fleet.example.yaml", import.meta.url));
const TRUNCATE_CHARS = 600;
const HOME_TASK_LIMIT = 25;
const LIST_DEFAULT_LIMIT = 50;

const BOARD_STATES = [
  "all",
  "waiting",
  "ready",
  "claimed",
  "blocked",
  "failed",
  "completed",
  "canceled",
] as const;

type BoardState = (typeof BOARD_STATES)[number];
type TaskStateFilter = "open" | BoardState;

const OPTIONAL_FIELDS = [
  "owner",
  "claimedBy",
  "project",
  "host",
  "delivery",
  "pr",
  "epoch",
  "replies",
  "result",
] as const;

type OptionalField = (typeof OPTIONAL_FIELDS)[number];

const FIELD_READERS: Record<OptionalField, (item: ThreadSummaryView) => string | number> = {
  owner: (item) => item.message.task?.owner ?? "",
  claimedBy: (item) => item.message.task?.by ?? "",
  project: (item) => item.message.labels["project"] ?? "",
  host: (item) => item.message.labels["host"] ?? "",
  delivery: (item) => item.message.labels["delivery"] ?? "",
  pr: (item) => item.message.labels["pr"] ?? "",
  epoch: (item) => item.message.task?.epoch ?? 0,
  replies: (item) => item.replies,
  result: (item) => item.message.task?.result ?? "",
};

export interface FleetAxiContext {
  readonly board: () => Board;
  readonly boardUrl: string | undefined;
  readonly metaChannel: string;
}

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  tasks: `fleet tasks - list tasks across channels
Usage:
  fleet tasks [--channel <ch>] [--state <state>] [--fields <cols>] [--limit <n>]
Flags:
  --channel <ch>     Filter to one channel or prefix (e.g. cleo)
  --state <state>    open (default), all, waiting, ready, claimed, blocked, failed, completed, canceled
  --fields <cols>    Extra columns: ${OPTIONAL_FIELDS.join(", ")}
  --limit <n>        Max rows to show (default: ${String(LIST_DEFAULT_LIMIT)})
Examples:
  fleet tasks
  fleet tasks --channel cleo --state blocked
  fleet tasks --state all --fields project,host,pr`,
  view: `fleet view - inspect one task and its thread
Usage:
  fleet view <id> [--full]
Flags:
  --full             Show untruncated task body and replies
Examples:
  fleet view 412
  fleet view 412 --full`,
  dispatch: `fleet dispatch - create a task on the board
Usage:
  fleet dispatch --channel <ch> --title "<text>" [--body "<spec>"] [--project <p>] [--host <h>] [--delivery <mode>] [--needs <ids>] [--for <profile>]
Flags:
  --channel <ch>     Required domain channel
  --title <text>     Required task title or intent
  --body <spec>      Optional additional spec text
  --project <repo>   Repository label for fleet-runner
  --host <host>      Execution host label (e.g. p620, maverick)
  --delivery <mode>  ${DELIVERIES.join(" | ")}
  --needs <ids>      Comma-separated prerequisite task IDs
  --for <profile>    Assign to a specific agent profile
Examples:
  fleet dispatch --channel cleo --project Cleo --host p620 --title "Fix webhook timeout"
  fleet dispatch --channel growth --title "Audit Google Ads CPA"`,
  reply: `fleet reply - post a reply on a task thread
Usage:
  fleet reply <id> --text "<message>" [--internal]
Flags:
  --text <message>   Required reply text
  --internal         Keep reply on board only (--no-sync)
Examples:
  fleet reply 412 --text "PR is green: https://github.com/org/repo/pull/9"
  fleet reply 412 --text "Running checks" --internal`,
  block: `fleet block - hold a task for human judgment
Usage:
  fleet block <id> --reason "<question and recommendation>" [--kind <kind>]
Flags:
  --reason <text>    Required question, evidence, and recommendation
  --kind <kind>      Optional free-text label (e.g. needs_input, awaiting_approval)
Examples:
  fleet block 412 --reason "PR #9 is green. Merge to main? Rec: merge."`,
  unblock: `fleet unblock - lift a block on a task (optionally posting an answer)
Usage:
  fleet unblock <id> [--reply "<answer>"]
Flags:
  --reply <text>     Optional reply to post before unblocking
Examples:
  fleet unblock 412 --reply "merge"
  fleet unblock 412`,
  cancel: `fleet cancel - cancel an open or obsolete task
Usage:
  fleet cancel <id> --reason "<why>"
Flags:
  --reason <text>    Required cancellation reason
Examples:
  fleet cancel 412 --reason "Superseded by #419"`,
  hosts: `fleet hosts - list runner hosts advertised in meta
Usage:
  fleet hosts
Examples:
  fleet hosts`,
  charter: `fleet charter - read or update a domain charter on the board
Usage:
  fleet charter <channel> [--set "<text>"]
Flags:
  --set <text>       Publish a new charter message to <channel>
Examples:
  fleet charter cleo
  fleet charter growth --set "Full autopilot within $150/day ad cap."`,
  prefs: `fleet prefs - read or update operator-wide preferences in meta
Usage:
  fleet prefs [--set "<text>"]
Flags:
  --set <text>       Publish updated preferences to meta
Examples:
  fleet prefs
  fleet prefs --set "Prefer smallest diff; no unit tests."`,
  init: `fleet init - copy fleet.example.yaml to ./fleet.yaml (idempotent)
Usage:
  fleet init [--config <path>]
Flags:
  --config <path>    Target config path (default: ./fleet.yaml)
Examples:
  fleet init`,
  setup: `fleet setup - install or inspect session-start hooks (Claude Code, Codex, OpenCode)
Usage:
  fleet setup hooks [--scope <user|project>] [--status] [--uninstall]
Flags:
  --scope <scope>    user (default) or project
  --status           Show current hook installation status
  --uninstall        Remove installed session-start hooks
Examples:
  fleet setup hooks --status
  fleet setup hooks --scope user`,
  run: `fleet run - start the fleet-runner execution loop for this host
Usage:
  fleet run [--config <path>] [--once]
Flags:
  --config <path>    Path to fleet.yaml (default: $FLEET_CONFIG or ./fleet.yaml)
  --once             Claim and run at most one ready task, then exit
Examples:
  fleet run
  fleet run --config ./fleet.yaml --once`,
};

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((each) => each.trim())
      .find((each) => each !== "") ?? "";
  return line.length <= 100 ? line : `${line.slice(0, 97)}...`;
}

function truncate(
  text: string,
  full: boolean,
): { readonly value: string; readonly truncated: boolean } {
  if (full || text.length <= TRUNCATE_CHARS) {
    return { value: text, truncated: false };
  }
  return {
    value: `${text.slice(0, TRUNCATE_CHARS).trimEnd()}...\n... (truncated, ${String(text.length)} chars total)`,
    truncated: true,
  };
}

function parseHosts(messages: readonly MessageView[]): Record<string, string>[] {
  const byHost = new Map<string, Record<string, string>>();
  for (const msg of messages) {
    if (msg.labels["kind"] !== "host") continue;
    const host = msg.labels["host"] ?? "";
    if (host === "") continue;
    const modeMatch = /\bmode=(\S+)/u.exec(msg.text);
    const reposMatch = /\brepos=(\S+)/u.exec(msg.text);
    byHost.set(host, {
      host,
      mode: modeMatch?.[1] ?? "unknown",
      repos: reposMatch?.[1] ?? "none",
    });
  }
  return [...byHost.values()].toSorted((a, b) => (a["host"] ?? "").localeCompare(b["host"] ?? ""));
}

function formatTaskRow(
  item: ThreadSummaryView,
  extraFields: readonly OptionalField[],
): Record<string, string | number> {
  const row: Record<string, string | number> = {
    id: item.message.id,
    channel: item.message.channel,
    state: item.message.task?.state ?? "unknown",
    title: firstLine(item.message.text),
  };
  for (const field of extraFields) {
    row[field] = FIELD_READERS[field](item);
  }
  return row;
}

function summarizeCounts(tasks: readonly ThreadSummaryView[]): string {
  const tally: Record<string, number> = {
    blocked: 0,
    claimed: 0,
    ready: 0,
    waiting: 0,
    failed: 0,
  };
  for (const item of tasks) {
    const state = item.message.task?.state;
    if (state !== undefined && Object.hasOwn(tally, state)) {
      tally[state] = (tally[state] ?? 0) + 1;
    }
  }
  const parts = Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${String(n)} ${state}`);
  if (parts.length === 0) return "0 open tasks";
  return `${parts.join(", ")} (${String(tasks.length)} open total)`;
}

function requireBoard(ctx: FleetAxiContext | undefined): FleetAxiContext {
  if (ctx === undefined) {
    throw new AxiError("No board context configured", "config", [
      "Set BOARD_URL or create fleet.yaml with `fleet init`",
    ]);
  }
  return ctx;
}

async function listAllTasks(
  client: Board,
  params: { readonly channel?: string; readonly state?: TaskStateFilter },
): Promise<ThreadSummaryView[]> {
  const state = params.state === undefined || params.state === "open" ? undefined : params.state;
  const page = await client.tasks.list({
    limit: 100,
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
    ...(state !== undefined ? { state } : {}),
  });
  return page.tasks;
}

export async function homeCommand(
  _args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const client = active.board();
  const [openTasks, metaPage] = await Promise.all([
    listAllTasks(client, { state: "open" }),
    client
      .channel(active.metaChannel)
      .messages({ limit: 50 })
      .catch(() => ({ messages: [] })),
  ]);
  const hosts = parseHosts(metaPage.messages);
  const shown = openTasks.slice(0, HOME_TASK_LIMIT).map((task) => formatTaskRow(task, []));
  const hasBlocked = openTasks.some((task) => task.message.task?.state === "blocked");
  const help: string[] = [];
  if (shown.length > 0) help.push("Run `fleet view <id>` to inspect a task and its thread");
  if (hasBlocked) help.push('Run `fleet unblock <id> --reply "<answer>"` to answer a blocked task');
  if (openTasks.length > HOME_TASK_LIMIT) {
    help.push(`Run \`fleet tasks\` to see all ${String(openTasks.length)} open tasks`);
  }
  help.push(
    'Run `fleet dispatch --channel <ch> --title "<text>" [--project <repo>] [--host <host>]` to create a task',
  );

  return {
    ...(active.boardUrl !== undefined ? { board: active.boardUrl } : {}),
    counts: summarizeCounts(openTasks),
    hosts: hosts.length === 0 ? "0 runner hosts advertised in meta" : hosts,
    tasks: shown.length === 0 ? "0 open tasks found" : shown,
    help,
  };
}

export async function tasksCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["tasks"] ?? "";
  const parsed = parseStrictFlags(
    "tasks",
    args,
    {
      channel: { type: "string" },
      state: { type: "string" },
      fields: { type: "string" },
      limit: { type: "string" },
    },
    helpBlock,
  );

  const stateArg = stringFlag(parsed.values, "state") ?? "open";
  const allStates: readonly TaskStateFilter[] = ["open", ...BOARD_STATES];
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
    throw new AxiError(`--limit must be a positive integer`, "VALIDATION_ERROR", [helpBlock]);
  }

  const channel = stringFlag(parsed.values, "channel");
  const all = await listAllTasks(active.board(), {
    ...(channel !== undefined ? { channel } : {}),
    state,
  });

  if (all.length === 0) {
    const scope = channel === undefined ? "" : ` in channel ${channel}`;
    return {
      tasks: `0 ${state} tasks found${scope}`,
      help: [
        'Run `fleet dispatch --channel <ch> --title "<text>"` to create a task',
        ...(state === "open" ? ["Run `fleet tasks --state all` to include completed tasks"] : []),
      ],
    };
  }

  const shown = all.slice(0, limit).map((task) => formatTaskRow(task, extraFields));
  const help = ["Run `fleet view <id>` to inspect a task and its thread"];
  if (all.length > limit) {
    help.push(`Run \`fleet tasks --limit ${String(all.length)}\` to see all ${String(all.length)}`);
  }
  return {
    count: `${String(shown.length)} of ${String(all.length)} total`,
    tasks: shown,
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
    throw new AxiError("task <id> is required for `view`", "VALIDATION_ERROR", [helpBlock]);
  }

  const full = boolFlag(parsed.values, "full");
  const thread = await active.board().thread(id);
  const root = thread.message;
  const body = truncate(root.text, full);
  let anyTruncated = body.truncated;
  const replies = thread.replies.map((reply) => {
    const clipped = truncate(reply.text, full);
    anyTruncated ||= clipped.truncated;
    return {
      id: reply.id,
      by: reply.by.actor,
      text: clipped.value,
    };
  });

  const result: Record<string, unknown> = {
    task: {
      id: root.id,
      channel: root.channel,
      state: root.task?.state ?? "unknown",
      epoch: root.task?.epoch ?? 0,
      owner: root.task?.owner ?? "",
      claimedBy: root.task?.by ?? "",
      labels: root.labels,
      ...(root.task?.result !== undefined && root.task.result !== null
        ? { result: root.task.result }
        : {}),
      body: body.value,
    },
    replies: replies.length === 0 ? "0 replies" : replies,
  };

  if (anyTruncated) {
    result["help"] = [`Run \`fleet view ${id} --full\` to see complete text`];
  }
  return result;
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
      channel: { type: "string", required: true },
      title: { type: "string", required: true },
      body: { type: "string" },
      project: { type: "string" },
      host: { type: "string" },
      delivery: { type: "string" },
      needs: { type: "string" },
      for: { type: "string" },
    },
    helpBlock,
  );

  const channel = stringFlag(parsed.values, "channel") ?? "";
  const title = stringFlag(parsed.values, "title") ?? "";
  const body = stringFlag(parsed.values, "body");
  const project = stringFlag(parsed.values, "project");
  const host = stringFlag(parsed.values, "host");
  const delivery = stringFlag(parsed.values, "delivery");
  const needsRaw = stringFlag(parsed.values, "needs");
  const assignFor = stringFlag(parsed.values, "for");

  if (delivery !== undefined && !DELIVERIES.some((each) => each === delivery)) {
    throw new AxiError(`invalid --delivery "${delivery}"`, "VALIDATION_ERROR", [
      `valid values: ${DELIVERIES.join(", ")}`,
    ]);
  }

  const labels: Record<string, string> = {};
  if (project !== undefined) labels["project"] = project;
  if (host !== undefined) labels["host"] = host;
  if (delivery !== undefined) labels["delivery"] = delivery;

  const needs =
    needsRaw === undefined
      ? undefined
      : needsRaw
          .split(",")
          .map((each) => each.trim())
          .filter((each) => each !== "");

  const text = body === undefined ? title : `${title}\n\n${body}`;
  const created = await active.board().tasks.create(channel, {
    text,
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(needs !== undefined && needs.length > 0 ? { needs } : {}),
    ...(assignFor !== undefined ? { for: assignFor } : {}),
  });

  return {
    task: {
      id: created.task.id,
      channel: created.task.channel,
      state: created.task.task?.state ?? "ready",
      title: firstLine(created.task.text),
    },
    help: [
      `Run \`fleet view ${created.task.id}\` to inspect the task`,
      `Run \`fleet reply ${created.task.id} --text "<note>"\` to add context`,
    ],
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
    throw new AxiError("task <id> is required for `reply`", "VALIDATION_ERROR", [helpBlock]);
  }
  const text = stringFlag(parsed.values, "text") ?? "";
  const internal = boolFlag(parsed.values, "internal");
  const posted = await active.board().reply(id, { text, ...(internal ? { noSync: true } : {}) });
  return {
    reply: {
      id: posted.id,
      task: id,
      internal,
    },
  };
}

export async function blockCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["block"] ?? "";
  const parsed = parseStrictFlags(
    "block",
    args,
    {
      reason: { type: "string", required: true },
      kind: { type: "string" },
    },
    helpBlock,
  );
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("task <id> is required for `block`", "VALIDATION_ERROR", [helpBlock]);
  }
  const reason = stringFlag(parsed.values, "reason") ?? "";
  const kind = stringFlag(parsed.values, "kind");
  const client = active.board();
  const current = await client.thread(id);
  if (current.message.task?.state === "blocked") {
    return { task: `#${id} already blocked (no-op)` };
  }
  await client.tasks.block(id, reason, kind === undefined ? {} : { kind });
  return {
    task: { id, state: "blocked", reason },
    help: [`Run \`fleet unblock ${id} --reply "<answer>"\` once answered`],
  };
}

export async function unblockCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["unblock"] ?? "";
  const parsed = parseStrictFlags("unblock", args, { reply: { type: "string" } }, helpBlock);
  const [id] = parsed.positionals;
  if (id === undefined) {
    throw new AxiError("task <id> is required for `unblock`", "VALIDATION_ERROR", [helpBlock]);
  }
  const replyText = stringFlag(parsed.values, "reply");
  const client = active.board();
  if (replyText !== undefined) {
    await client.reply(id, { text: replyText });
  }
  const current = await client.thread(id);
  if (current.message.task?.state !== "blocked") {
    return {
      task: `#${id} already ${current.message.task?.state ?? "unblocked"} (no-op)`,
    };
  }
  const updated = await client.tasks.unblock(id);
  return {
    task: { id, state: updated.task?.state ?? "ready" },
  };
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
    throw new AxiError("task <id> is required for `cancel`", "VALIDATION_ERROR", [helpBlock]);
  }
  const reason = stringFlag(parsed.values, "reason") ?? "";
  const client = active.board();
  const current = await client.thread(id);
  if (current.message.task?.state === "canceled") {
    return { task: `#${id} already canceled (no-op)` };
  }
  await client.tasks.cancel(id, reason);
  return {
    task: { id, state: "canceled", reason },
  };
}

export async function hostsCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  parseStrictFlags("hosts", args, {}, COMMAND_HELP["hosts"] ?? "");
  const page = await active
    .board()
    .channel(active.metaChannel)
    .messages({ limit: 50 })
    .catch(() => ({ messages: [] }));
  const hosts = parseHosts(page.messages);
  if (hosts.length === 0) {
    return {
      hosts: "0 runner hosts advertised in meta",
      help: ["Start a runner on a host with `fleet run` to advertise its repos"],
    };
  }
  return { hosts };
}

export async function charterCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["charter"] ?? "";
  const parsed = parseStrictFlags("charter", args, { set: { type: "string" } }, helpBlock);
  const [channel] = parsed.positionals;
  if (channel === undefined) {
    throw new AxiError("<channel> is required for `charter`", "VALIDATION_ERROR", [helpBlock]);
  }
  const nextText = stringFlag(parsed.values, "set");
  const client = active.board();
  if (nextText !== undefined) {
    const posted = await client.post(channel, {
      text: nextText,
      labels: { kind: "charter" },
      noSync: true,
    });
    return { charter: { channel, id: posted.id, updated: true } };
  }
  const page = await client
    .channel(channel)
    .messages({ limit: 50 })
    .catch(() => ({ messages: [] }));
  const latest = page.messages.findLast((msg) => msg.labels["kind"] === "charter");
  if (latest === undefined) {
    return {
      charter: `0 charters set in channel ${channel}`,
      help: [`Run \`fleet charter ${channel} --set "<autonomy and boundaries>"\` to set one`],
    };
  }
  return { charter: { channel, id: latest.id, text: latest.text } };
}

export async function prefsCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const active = requireBoard(ctx);
  const helpBlock = COMMAND_HELP["prefs"] ?? "";
  const parsed = parseStrictFlags("prefs", args, { set: { type: "string" } }, helpBlock);
  const nextText = stringFlag(parsed.values, "set");
  const client = active.board();
  if (nextText !== undefined) {
    const posted = await client.post(active.metaChannel, {
      text: nextText,
      labels: { kind: "prefs" },
      noSync: true,
    });
    return { prefs: { id: posted.id, updated: true } };
  }
  const page = await client
    .channel(active.metaChannel)
    .messages({ limit: 50 })
    .catch(() => ({ messages: [] }));
  const latest = page.messages.findLast((msg) => msg.labels["kind"] === "prefs");
  if (latest === undefined) {
    return {
      prefs: "0 operator preferences set in meta",
      help: ['Run `fleet prefs --set "<preferences>"` to publish them'],
    };
  }
  return { prefs: { id: latest.id, text: latest.text } };
}

export function initCommand(args: string[]): Record<string, unknown> {
  const helpBlock = COMMAND_HELP["init"] ?? "";
  const parsed = parseStrictFlags("init", args, { config: { type: "string" } }, helpBlock);
  const target = resolve(process.cwd(), stringFlag(parsed.values, "config") ?? "fleet.yaml");
  if (existsSync(target)) {
    return { config: `${target} already exists (no-op)` };
  }
  copyFileSync(EXAMPLE_CONFIG, target);
  return {
    config: { path: target, created: true },
    help: [`Edit ${target}, then run \`fleet run --config ${target}\``],
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
  const { board: makeBoard } = await import("@vercel/board");
  const client = makeBoard(config.boardUrl !== undefined ? { url: config.boardUrl } : {}).as(
    `runner-${config.host}`,
  );
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
