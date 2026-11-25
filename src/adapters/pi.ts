import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpBoardClient, type BoardClient } from "../board/client.ts";
import { watchMateWakes } from "../board/wake.ts";
import { loadFleetConfig } from "../config.ts";

interface BeforeAgentStartEvent {
  readonly systemPrompt: string;
}

export interface PiExtensionApi {
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

export interface FleetPiAdapterOptions {
  readonly boardUrl?: string;
  readonly mate?: string;
  readonly reconnectDelayMs?: number;
}

const DEFAULT_MATE_PROMPT_PATH = fileURLToPath(new URL("../../prompts/mate.md", import.meta.url));
const ATTACHED_KEY = Symbol.for("fleet.piAdapterAttached");

function getAttachedSet(): WeakSet<PiExtensionApi> {
  const holder = globalThis as Record<PropertyKey, unknown>;
  const existing = holder[ATTACHED_KEY];
  if (existing instanceof WeakSet) return existing;
  const created = new WeakSet<PiExtensionApi>();
  holder[ATTACHED_KEY] = created;
  return created;
}

function loadDefaultMatePrompt(): string {
  if (!existsSync(DEFAULT_MATE_PROMPT_PATH)) return "";
  return readFileSync(DEFAULT_MATE_PROMPT_PATH, "utf8").trim();
}

function resolveBoardClient(overrides: FleetPiAdapterOptions = {}): {
  readonly client: BoardClient;
  readonly mate: string;
} {
  let boardUrl = overrides.boardUrl ?? process.env["BOARD_URL"];
  const candidates = [
    process.env["FLEET_CONFIG"],
    resolvePath(process.cwd(), "fleet.yaml"),
    resolvePath(homedir(), ".fleet", "fleet.yaml"),
    resolvePath(homedir(), ".config", "fleet", "fleet.yaml"),
  ];
  const cfgPath = candidates.find((p): p is string => p !== undefined && existsSync(p));
  if (boardUrl === undefined && cfgPath !== undefined) {
    const cfg = loadFleetConfig(cfgPath);
    boardUrl = cfg.boardUrl;
  }
  const effectiveUrl = boardUrl ?? "http://127.0.0.1:4100";
  const mate = overrides.mate ?? process.env["FLEET_MATE"];
  if (mate === undefined) {
    throw new Error("fleet Pi adapter requires FLEET_MATE (the configured mate this pane serves)");
  }
  return {
    client: createHttpBoardClient(effectiveUrl),
    mate,
  };
}

async function buildAmbientBlock(client: BoardClient, mate: string): Promise<string> {
  const [charter, heldCards, domainCards, hosts, prefs, parents] = await Promise.all([
    client.getCharter(mate).catch(() => ""),
    client
      .listCards({ holder: mate, state: "open", scope: mate })
      .then((page) => page.cards)
      .catch(() => []),
    client
      .listCards({ scope: mate, state: "open" })
      .then((page) => page.cards)
      .catch(() => []),
    client.listHosts().catch(() => []),
    client.getPrefs().catch(() => ""),
    client.getParents().catch((): Record<string, string> => ({})),
  ]);

  const parent = Object.hasOwn(parents, mate) ? (parents[mate] ?? "captain") : "captain";
  const children = Object.entries(parents)
    .filter(([, p]) => p === mate)
    .map(([name]) => name)
    .toSorted();

  const parts: string[] = [
    `Mate: ${mate} (parent: ${parent}${children.length > 0 ? `, subordinates: ${children.join(", ")}` : ""})`,
  ];
  if (charter.trim().length > 0) parts.push(`Charter:\n${charter.trim()}`);
  if (heldCards.length > 0) {
    parts.push(`Cards currently held by ${mate}:\n${JSON.stringify(heldCards, null, 2)}`);
  }
  if (domainCards.length > 0) {
    parts.push(`Open cards owned by ${mate}:\n${JSON.stringify(domainCards, null, 2)}`);
  }
  if (hosts.length > 0) {
    parts.push(`Available hosts:\n${JSON.stringify(hosts, null, 2)}`);
  }
  if (prefs.trim().length > 0) {
    parts.push(`Captain preferences:\n${prefs.trim()}`);
  }
  return parts.join("\n\n");
}

export function attachFleetPiAdapter(
  pi: PiExtensionApi,
  overrides: FleetPiAdapterOptions = {},
): void {
  const attached = getAttachedSet();
  if (attached.has(pi)) return;
  attached.add(pi);

  const { client, mate } = resolveBoardClient(overrides);
  const matePrompt = loadDefaultMatePrompt();
  let controller: AbortController | undefined;
  let ambientBlock = "";

  pi.on("session_start", async () => {
    const cursor = await client.latestEventId().catch(() => undefined);
    ambientBlock = await buildAmbientBlock(client, mate);
    controller = new AbortController();
    void watchMateWakes({
      client,
      mate,
      signal: controller.signal,
      ...(cursor !== undefined ? { initialCursor: cursor } : {}),
      ...(overrides.reconnectDelayMs !== undefined
        ? { reconnectDelayMs: overrides.reconnectDelayMs }
        : {}),
      async onRecovered() {
        ambientBlock = await buildAmbientBlock(client, mate);
      },
      onWake(wake) {
        pi.sendMessage(
          { customType: "fleet", content: wake.notice, display: true },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
    });
  });

  pi.on("before_agent_start", (event) => {
    const sections: string[] = [event.systemPrompt];
    if (matePrompt.length > 0 && !event.systemPrompt.includes(matePrompt)) {
      sections.push(matePrompt);
    }
    if (ambientBlock !== "") {
      sections.push(`## Ambient Fleet Context (live at session start)\n\n${ambientBlock}`);
    }
    if (sections.length === 1) return undefined;
    return { systemPrompt: sections.join("\n\n") };
  });

  pi.on("session_shutdown", () => {
    controller?.abort();
    controller = undefined;
  });
}

export default function fleetPiAdapter(pi: PiExtensionApi): void {
  attachFleetPiAdapter(pi);
}
