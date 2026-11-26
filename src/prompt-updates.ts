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
  const dispatched: Card[] = [];
  for (const mate of mates) {
    const { cards } = await client.listCards({ mate: mate.name, state: "all" });
    const last = cards.find((card) => card.createdBy === SERVER_ACTOR && card.title === TITLE);
    const previous = lastPublishedCommit(last?.body ?? "");
    if (previous === commit || (previous !== undefined && contentHash(previous) === hash)) {
      continue;
    }
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
