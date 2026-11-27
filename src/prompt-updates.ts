import { execFileSync } from "node:child_process";
import { createHttpBoardClient } from "./board/client.ts";
import { SERVER_ACTOR, type Card } from "./board/types.ts";
import type { FleetConfig } from "./config.ts";

const TITLE = "Update your system prompt";
const INSTRUCTION = `${TITLE} to https://github.com/1yian/fleet-v3/blob/`;
const TEMPLATE = "templates/grok-bot.md";
const PROMPT_FILES = ["prompts/mate.md", TEMPLATE];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function contentHash(commit: string): string {
  return git("rev-parse", "--end-of-options", ...PROMPT_FILES.map((file) => `${commit}:${file}`));
}

function referencedCommands(commit: string): string[] {
  const text = PROMPT_FILES.map((file) =>
    git("show", "--end-of-options", `${commit}:${file}`),
  ).join("\n");
  return [...new Set([...text.matchAll(/`fleet ([a-z][a-z-]*)/gu)].map((match) => match[1] ?? ""))];
}

function missingCommands(fleetBin: string, required: string[]): string[] {
  let help: string;
  try {
    help = execFileSync(fleetBin, ["--help"], { encoding: "utf8" });
  } catch (error) {
    throw new Error(
      `Cannot run "${fleetBin} --help" to verify the CLI install: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const available = new Set([...help.matchAll(/^\s*fleet ([a-z][a-z-]*)/gmu)].map((m) => m[1]));
  return required.filter((command) => !available.has(command));
}

function lastPublishedCommit(body: string): string | undefined {
  if (!body.startsWith(INSTRUCTION) || !body.endsWith(`/${TEMPLATE}`)) return undefined;
  const commit = body.slice(INSTRUCTION.length, -(TEMPLATE.length + 1));
  return /^[a-f0-9]{40}$/u.test(commit) ? commit : undefined;
}

export async function publishPromptUpdates(config: FleetConfig, revision: string): Promise<Card[]> {
  const mates = config.mates?.items.filter((mate) => mate.mode === "external") ?? [];
  if (mates.length === 0) return [];

  const commit = git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`);
  const hash = contentHash(commit);
  const client = createHttpBoardClient(config.boardUrl);
  const pending: typeof mates = [];
  for (const mate of mates) {
    const { cards } = await client.listCards({ mate: mate.name, state: "all" });
    const last = cards.find((card) => card.createdBy === SERVER_ACTOR && card.title === TITLE);
    const previous = lastPublishedCommit(last?.body ?? "");
    if (previous === commit || (previous !== undefined && contentHash(previous) === hash)) {
      continue;
    }
    pending.push(mate);
  }

  const required = referencedCommands(commit);
  const stale =
    required.length === 0
      ? []
      : pending.flatMap((mate) => {
          const fleetBin = mate.fleetBin ?? "fleet";
          const missing = missingCommands(fleetBin, required);
          return missing.length === 0
            ? []
            : [
                `${mate.name} (${fleetBin}) lacks: ${missing.map((name) => `fleet ${name}`).join(", ")}`,
              ];
        });
  if (stale.length > 0) {
    throw new Error(
      `Prompt update ${commit} not published because external mate CLI installs are behind it. Update each checkout (git pull) or set the mate's fleetBin, then rerun.\n${stale.join("\n")}`,
    );
  }

  const dispatched: Card[] = [];
  for (const mate of pending) {
    dispatched.push(
      await client.createCard({
        mate: mate.name,
        title: TITLE,
        body: `${INSTRUCTION}${commit}/${TEMPLATE}`,
        actor: SERVER_ACTOR,
      }),
    );
  }
  return dispatched;
}
