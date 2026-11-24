import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { board, type Board, type BoardEventView, type MessageView } from "@vercel/board";
import { homeCommand, prefsCommand } from "../axi/commands.ts";
import { loadConfig } from "../config.ts";

interface BeforeAgentStartEvent {
  readonly systemPrompt: string;
}

interface PiExtensionApi {
  readonly on: {
    (
      event: "before_agent_start",
      handler: (
        event: BeforeAgentStartEvent,
      ) => Promise<{ systemPrompt: string } | undefined> | { systemPrompt: string } | undefined,
    ): void;
    (event: "session_start" | "session_shutdown", handler: () => Promise<void> | void): void;
  };
  readonly sendMessage: (
    message: { readonly customType: string; readonly content: string; readonly display: boolean },
    options: { readonly triggerTurn: boolean; readonly deliverAs: "followUp" | "steer" },
  ) => void;
}

function resolveBoardClient(): {
  readonly client: Board;
  readonly boardUrl: string | undefined;
  readonly metaChannel: string;
  readonly profile: string;
} {
  let boardUrl = process.env["BOARD_URL"];
  let metaChannel = "meta";
  const candidates = [
    process.env["FLEET_CONFIG"],
    resolve(process.cwd(), "fleet.yaml"),
    resolve(homedir(), ".config", "fleet", "fleet.yaml"),
    resolve(homedir(), ".fleet-v3", "fleet.yaml"),
  ];
  const cfgPath = candidates.find((p): p is string => p !== undefined && existsSync(p));
  if (boardUrl === undefined && cfgPath !== undefined) {
    const cfg = loadConfig(cfgPath);
    boardUrl = cfg.boardUrl;
    metaChannel = cfg.metaChannel;
  }
  if (boardUrl !== undefined && process.env["BOARD_URL"] === undefined) {
    process.env["BOARD_URL"] = boardUrl;
  }
  const profile = process.env["BOARD_PROFILE"] ?? "jarvis";
  return {
    client: board(boardUrl !== undefined ? { url: boardUrl } : {}),
    boardUrl,
    metaChannel,
    profile,
  };
}

function formatTaskEvent(type: string, msg: MessageView): string | undefined {
  const title = msg.text.split("\n")[0] ?? "";
  const detail = msg.task?.result ?? "";
  if (type === "task.blocked") {
    const reason = detail === "" ? "" : `\nReason: ${detail}`;
    return `[fleet] Task #${msg.id} (${msg.channel}) blocked: ${title}${reason}\nRun \`fleet view ${msg.id} --full\` and \`fleet charter ${msg.channel}\` before deciding whether to act or escalate.`;
  }
  if (type === "task.failed") {
    const reason = detail === "" ? "" : `\nReason: ${detail}`;
    return `[fleet] Task #${msg.id} (${msg.channel}) failed: ${title}${reason}\nRun \`fleet view ${msg.id} --full\` to diagnose and decide the next step.`;
  }
  if (type === "task.completed") {
    return `[fleet] Task #${msg.id} (${msg.channel}) completed: ${title}${detail === "" ? "" : ` (${detail})`}`;
  }
  return undefined;
}

function formatHighSignalEvent(event: BoardEventView, profile: string): string | undefined {
  const msg = event.message;
  if (msg === undefined || msg.by.profile === profile) return undefined;
  const taskNotice = formatTaskEvent(event.type, msg);
  if (taskNotice !== undefined) return taskNotice;
  if (event.type !== "message.posted" || msg.noSync) return undefined;
  const mention = new RegExp(`@${profile}\\b`, "iu");
  if (msg.channel === profile || mention.test(msg.text)) {
    const target = msg.re ?? msg.id;
    return `[fleet] Message in #${msg.channel} (thread #${target}) from ${msg.by.actor}:\n${msg.text}`;
  }
  return undefined;
}

export default function fleetPiAdapter(pi: PiExtensionApi): void {
  const { client, boardUrl, metaChannel, profile } = resolveBoardClient();
  let controller: AbortController | undefined;
  let ambientBlock = "";

  const loadAmbient = async (): Promise<void> => {
    const ctx = { board: () => client, boardUrl, metaChannel };
    const [home, prefs] = await Promise.all([
      homeCommand([], ctx).catch(() => undefined),
      prefsCommand([], ctx).catch(() => undefined),
    ]);
    const parts: string[] = [];
    if (home !== undefined) parts.push(`Live fleet snapshot:\n${JSON.stringify(home, null, 2)}`);
    if (prefs !== undefined) parts.push(`Operator preferences:\n${JSON.stringify(prefs, null, 2)}`);
    ambientBlock = parts.join("\n\n");
  };

  const watchEvents = async (signal: AbortSignal): Promise<void> => {
    try {
      for await (const event of client.events({}, { signal })) {
        const notice = formatHighSignalEvent(event, profile);
        if (notice === undefined) continue;
        pi.sendMessage(
          { customType: "fleet", content: notice, display: true },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch {
      controller = undefined;
    }
  };

  pi.on("session_start", async () => {
    await loadAmbient();
    controller = new AbortController();
    void watchEvents(controller.signal);
  });

  pi.on("before_agent_start", (event) => {
    if (ambientBlock === "") return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Ambient Fleet Context (live at session start)\n\n${ambientBlock}`,
    };
  });

  pi.on("session_shutdown", () => {
    controller?.abort();
  });
}
