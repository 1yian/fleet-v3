import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { board, type Board } from "@vercel/board";
import { runAxiCli } from "axi-sdk-js";
import {
  blockCommand,
  cancelCommand,
  charterCommand,
  COMMAND_HELP,
  dispatchCommand,
  homeCommand,
  hostsCommand,
  initCommand,
  prefsCommand,
  replyCommand,
  runCommand,
  setupCommand,
  tasksCommand,
  unblockCommand,
  viewCommand,
  type FleetAxiContext,
} from "./axi/commands.ts";
import { loadConfig } from "./config.ts";
import { VERSION } from "./version.ts";

const DESCRIPTION = "Coordinate parallel multi-machine agents on @vercel/board";

const TOP_LEVEL_HELP = `fleet - ${DESCRIPTION}

Usage:
  fleet                        Live overview of open tasks, counts, and advertised hosts
  fleet tasks [flags]          List tasks across channels
  fleet view <id> [--full]     Inspect a task and its thread
  fleet dispatch [flags]       Create a task on the board
  fleet reply <id> [flags]     Post a reply to a task thread
  fleet block <id> [flags]     Hold a task for human judgment
  fleet unblock <id> [flags]   Unblock a task (optionally posting an answer)
  fleet cancel <id> [flags]    Cancel an open or obsolete task
  fleet hosts                  List runner hosts advertised in meta
  fleet charter <ch> [flags]   Read or update a domain charter
  fleet prefs [flags]          Read or update operator-wide preferences
  fleet run [flags]            Run fleet-runner for this host
  fleet init [flags]           Create fleet.yaml from fleet.example.yaml
  fleet setup hooks [flags]    Install or check session-start hooks

Run \`fleet <command> --help\` for per-command flags and examples.`;

export interface RunFleetCliOptions {
  readonly argv?: string[];
  readonly boardClient?: Board;
  readonly boardUrl?: string;
  readonly metaChannel?: string;
  readonly stdout?: { write: (chunk: string) => unknown };
}

function findDefaultConfig(): string | undefined {
  const candidates = [
    process.env["FLEET_CONFIG"],
    resolve(process.cwd(), "fleet.yaml"),
    resolve(homedir(), ".config", "fleet", "fleet.yaml"),
    resolve(homedir(), ".fleet-v3", "fleet.yaml"),
  ];
  return candidates.find((path): path is string => path !== undefined && existsSync(path));
}

function defaultBoardContext(): FleetAxiContext {
  const envUrl = process.env["BOARD_URL"];
  let boardUrl = envUrl;
  let metaChannel = "meta";
  const configPath = findDefaultConfig();
  if (boardUrl === undefined && configPath !== undefined) {
    const cfg = loadConfig(configPath);
    boardUrl = cfg.boardUrl;
    metaChannel = cfg.metaChannel;
  }
  if (boardUrl !== undefined && process.env["BOARD_URL"] === undefined) {
    process.env["BOARD_URL"] = boardUrl;
  }
  return {
    board: () => board(boardUrl !== undefined ? { url: boardUrl } : {}),
    boardUrl,
    metaChannel,
  };
}

export async function runFleetCli(options: RunFleetCliOptions = {}): Promise<void> {
  const provided = options.boardClient;
  const ctx: FleetAxiContext =
    provided !== undefined
      ? {
          board: () => provided,
          boardUrl: options.boardUrl,
          metaChannel: options.metaChannel ?? "meta",
        }
      : defaultBoardContext();

  await runAxiCli<FleetAxiContext>({
    description: DESCRIPTION,
    version: VERSION,
    ...(options.argv !== undefined ? { argv: options.argv } : {}),
    ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (cmd) => COMMAND_HELP[cmd],
    resolveContext: () => ctx,
    home: homeCommand,
    commands: {
      tasks: tasksCommand,
      view: viewCommand,
      dispatch: dispatchCommand,
      reply: replyCommand,
      block: blockCommand,
      unblock: unblockCommand,
      cancel: cancelCommand,
      hosts: hostsCommand,
      charter: charterCommand,
      prefs: prefsCommand,
      init: initCommand,
      setup: setupCommand,
      run: runCommand,
    },
  });
}

export async function main(): Promise<void> {
  await runFleetCli();
}
