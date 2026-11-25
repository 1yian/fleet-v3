import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { AxiError, runAxiCli } from "axi-sdk-js";
import {
  answerCommand,
  cancelCommand,
  cardsCommand,
  charterCommand,
  closeCommand,
  COMMAND_HELP,
  dispatchCommand,
  escalateCommand,
  handoffCommand,
  homeCommand,
  hostsCommand,
  initCommand,
  prefsCommand,
  queueCommand,
  replyCommand,
  runCommand,
  setupCommand,
  snoozeCommand,
  viewCommand,
  type FleetAxiContext,
} from "./axi/commands.ts";
import { boolFlag, parseStrictFlags, stringFlag } from "./axi/parse.ts";
import { createHttpBoardClient } from "./board/client.ts";
import { startBoardServer } from "./board/server.ts";
import { CardStore } from "./board/store.ts";
import type { OptionalFenceInput } from "./board/types.ts";
import { extractMateParents, loadFleetConfig, type FleetConfig } from "./config.ts";
import { ensureMatesUp, listMates, stopMates } from "./mates.ts";
import { VERSION } from "./version.ts";

const DESCRIPTION = "Coordinate parallel multi-machine mates and workers on a minimal Card Server";

const TOP_LEVEL_HELP = `fleet - ${DESCRIPTION}

Usage:
  fleet                        Live overview of open cards, counts, and advertised hosts
  fleet serve [flags]          Run the minimal 3-table SQLite Card Server
  fleet cards [flags]          List cards across mates and holders
  fleet view <id> [--full]     Inspect a card and its thread
  fleet dispatch [flags]       Delegate a card to a child mate or spawn a worker
  fleet queue <id> [flags]     Put a held card into the runner queue for a worker
  fleet reply <id> [flags]     Post an entry on a card thread
  fleet escalate <id> [flags]  Escalate a card to the parent mate (or captain)
  fleet handoff <id> [flags]   Pass a card to a mate (default: home mate)
  fleet answer <id> [flags]    Answer an escalated card and hand it back to its mate
  fleet snooze <id> [flags]    Defer stale-card chases while waiting externally
  fleet close <id> [flags]     Mark a card done and unblock waiting dependents
  fleet cancel <id> [flags]    Cancel an open or obsolete card
  fleet hosts                  List runner hosts advertised on the Card Server
  fleet charter <mate> [flags] Read or update a mate's plain-Markdown charter
  fleet prefs [flags]          Read or update captain-wide preferences
  fleet run [flags]            Run fleet-runner for this host
  fleet mates [subcommand]     Manage permanent interactive mate panes in Herdr
  fleet web [flags]            Serve a standalone Kanban viewport proxying to the Card Server
  fleet init [flags]           Create fleet.yaml from fleet.example.yaml
  fleet setup hooks [flags]    Install or check session-start hooks

Run \`fleet <command> --help\` for per-command flags and examples.`;

export interface RunFleetCliOptions {
  readonly argv?: string[];
  readonly boardUrl?: string;
  readonly actor?: string;
  readonly stdout?: { write: (chunk: string) => unknown };
}

function findDefaultConfig(): string | undefined {
  const candidates = [
    process.env["FLEET_CONFIG"],
    resolvePath(process.cwd(), "fleet.yaml"),
    resolvePath(homedir(), ".fleet", "fleet.yaml"),
    resolvePath(homedir(), ".config", "fleet", "fleet.yaml"),
  ];
  return candidates.find((path): path is string => path !== undefined && existsSync(path));
}

function fenceFromEnv(): OptionalFenceInput {
  const epochRaw = process.env["FLEET_CLAIM_EPOCH"];
  const token = process.env["FLEET_CLAIM_TOKEN"];
  if (epochRaw === undefined && token === undefined) return {};
  const epoch = Number(epochRaw);
  if (token === undefined || token === "" || !Number.isInteger(epoch) || epoch < 1) {
    throw new AxiError(
      "FLEET_CLAIM_EPOCH and FLEET_CLAIM_TOKEN must be set together",
      "VALIDATION_ERROR",
      ["Unset both to act without a claim fence"],
    );
  }
  return { epoch, token };
}

function resolveBoardUrl(explicit: string | undefined): string {
  let boardUrl = explicit ?? process.env["BOARD_URL"];
  const configPath = findDefaultConfig();
  if (boardUrl === undefined && configPath !== undefined) {
    boardUrl = loadFleetConfig(configPath).boardUrl;
  }
  return boardUrl ?? "http://127.0.0.1:4100";
}

function boardContext(options: RunFleetCliOptions): FleetAxiContext {
  const boardUrl = resolveBoardUrl(options.boardUrl);
  const fence = fenceFromEnv();
  const mate = process.env["FLEET_MATE"];
  const envActor =
    fence.epoch === undefined
      ? (mate ?? "captain")
      : mate === undefined
        ? "worker"
        : `worker:${mate}`;
  return {
    board: () => createHttpBoardClient(boardUrl),
    boardUrl,
    actor: options.actor ?? envActor,
    fence,
  };
}

function parsePort(raw: string, helpBlock: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AxiError("--port must be an integer between 1 and 65535", "VALIDATION_ERROR", [
      helpBlock,
    ]);
  }
  return port;
}

function resolveServeOptions(
  values: Record<string, string | boolean | undefined>,
  helpBlock: string,
): {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly parents: Record<string, string>;
  readonly chaseIntervalMs: number;
  readonly staleAfterMs: number;
} {
  const configPath = stringFlag(values, "config") ?? findDefaultConfig();
  const cfg: FleetConfig | undefined =
    configPath === undefined ? undefined : loadFleetConfig(configPath);
  const serverCfg = cfg?.server;
  const dataDir =
    stringFlag(values, "dir") ?? serverCfg?.dataDir ?? resolvePath(homedir(), ".fleet", "board");
  const host = stringFlag(values, "host") ?? serverCfg?.host ?? "127.0.0.1";
  const port = parsePort(stringFlag(values, "port") ?? String(serverCfg?.port ?? 4100), helpBlock);
  return {
    dataDir,
    host,
    port,
    parents: extractMateParents(cfg),
    chaseIntervalMs: (serverCfg?.chaseIntervalSeconds ?? 120) * 1000,
    staleAfterMs: (serverCfg?.staleAfterSeconds ?? 120) * 1000,
  };
}

async function serveCommand(args: string[]): Promise<Record<string, unknown>> {
  const helpBlock = COMMAND_HELP["serve"] ?? "";
  const parsed = parseStrictFlags(
    "serve",
    args,
    {
      dir: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      config: { type: "string" },
    },
    helpBlock,
  );
  const opts = resolveServeOptions(parsed.values, helpBlock);
  const store = new CardStore({ dataDir: opts.dataDir, parents: opts.parents });
  const started = await startBoardServer({
    store,
    host: opts.host,
    port: opts.port,
    chaseIntervalMs: opts.chaseIntervalMs,
    staleAfterMs: opts.staleAfterMs,
  });

  process.stderr.write(`fleet card server listening at ${started.url} (dir: ${opts.dataDir})\n`);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void started.stop().finally(() => {
        store.close();
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return { server: { url: started.url, stopped: true } };
}

async function webCommand(
  args: string[],
  ctx: FleetAxiContext | undefined,
): Promise<Record<string, unknown>> {
  const helpBlock = COMMAND_HELP["web"] ?? "";
  const parsed = parseStrictFlags(
    "web",
    args,
    {
      host: { type: "string" },
      port: { type: "string" },
    },
    helpBlock,
  );
  const boardUrl = ctx?.boardUrl ?? resolveBoardUrl(undefined);
  const host = stringFlag(parsed.values, "host") ?? "127.0.0.1";
  const port = parsePort(stringFlag(parsed.values, "port") ?? "4101", helpBlock);
  const { startKanbanServer } = await import("./adapters/kanban.ts");
  const { url, stop } = await startKanbanServer({ boardUrl, host, port });
  process.stderr.write(`fleet kanban listening at ${url} (upstream: ${boardUrl})\n`);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void stop().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return { web: { url, stopped: true } };
}

const MATES_HELP = `fleet mates - Manage permanent interactive mate panes in Herdr

Usage:
  fleet mates [status] [--config <path>]           Show status of configured mates
  fleet mates up [name] [--all] [--config <path>]  Idempotently start permanent mate panes
  fleet mates stop <name|--all> [--config <path>]  Close mate pane(s) in Herdr`;

async function matesCommand(args: string[]): Promise<Record<string, unknown>> {
  const parsed = parseStrictFlags(
    "mates",
    args,
    {
      config: { type: "string" },
      all: { type: "boolean" },
    },
    MATES_HELP,
  );
  const sub = parsed.positionals[0] ?? "status";
  const target = parsed.positionals[1];
  const all = boolFlag(parsed.values, "all");
  const configPath = stringFlag(parsed.values, "config") ?? findDefaultConfig();
  if (configPath === undefined) {
    throw new AxiError("No fleet.yaml found", "config", [
      "Pass --config <path> or run `fleet init`",
    ]);
  }
  const config = loadFleetConfig(configPath);

  if (sub === "status" || sub === "list") {
    return { mates: await listMates(config) };
  }
  if (sub === "up" || sub === "start") {
    return {
      mates: await ensureMatesUp(config, {
        ...(target !== undefined ? { name: target } : {}),
        all,
      }),
    };
  }
  if (sub === "stop") {
    if (target === undefined && !all) {
      throw new AxiError("Specify a mate name or pass --all", "VALIDATION_ERROR", [MATES_HELP]);
    }
    return {
      mates: await stopMates(config, {
        ...(target !== undefined ? { name: target } : {}),
        all,
      }),
    };
  }
  throw new AxiError(`Unknown mates subcommand "${sub}"`, "VALIDATION_ERROR", [MATES_HELP]);
}

export async function runFleetCli(options: RunFleetCliOptions = {}): Promise<void> {
  const ctx = boardContext(options);

  await runAxiCli<FleetAxiContext>({
    description: DESCRIPTION,
    version: VERSION,
    ...(options.argv !== undefined ? { argv: options.argv } : {}),
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (cmd) => (cmd === "mates" ? MATES_HELP : COMMAND_HELP[cmd]),
    resolveContext: () => ctx,
    home: homeCommand,
    commands: {
      serve: serveCommand,
      cards: cardsCommand,
      view: viewCommand,
      dispatch: dispatchCommand,
      queue: queueCommand,
      reply: replyCommand,
      escalate: escalateCommand,
      handoff: handoffCommand,
      answer: answerCommand,
      snooze: snoozeCommand,
      close: closeCommand,
      cancel: cancelCommand,
      hosts: hostsCommand,
      charter: charterCommand,
      prefs: prefsCommand,
      init: initCommand,
      setup: setupCommand,
      run: runCommand,
      mates: matesCommand,
      web: webCommand,
    },
  });
}

export async function main(): Promise<void> {
  await runFleetCli();
}
