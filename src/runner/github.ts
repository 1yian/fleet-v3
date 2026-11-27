import { execFile } from "node:child_process";
import { z } from "zod";
import type { BoardClient } from "../board/client.ts";
import { BoardError, runnerActor, type Card } from "../board/types.ts";

const PR_FIELDS = "url,state,statusCheckRollup";
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const CheckSchema = z.object({
  status: z.string().optional(),
  conclusion: z.string().optional(),
  state: z.string().optional(),
});

const PullRequestSchema = z.object({
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  statusCheckRollup: z.array(CheckSchema).default([]),
});

export interface PullRequest {
  readonly url: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly green: boolean;
}

function toPullRequest(raw: z.infer<typeof PullRequestSchema>): PullRequest {
  const green =
    raw.statusCheckRollup.length > 0 &&
    raw.statusCheckRollup.every((check) =>
      check.state !== undefined
        ? check.state === "SUCCESS"
        : check.status === "COMPLETED" && PASSING_CONCLUSIONS.has(check.conclusion ?? ""),
    );
  return { url: raw.url, state: raw.state, green };
}

function runGh(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { timeout: 60_000, encoding: "utf8", ...(cwd !== undefined ? { cwd } : {}) },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function viewPullRequest(url: string): Promise<PullRequest> {
  const stdout = await runGh(["pr", "view", url, "--json", PR_FIELDS]);
  return toPullRequest(PullRequestSchema.parse(JSON.parse(stdout)));
}

export async function findBranchPullRequest(
  cwd: string,
  branch: string,
): Promise<PullRequest | undefined> {
  const stdout = await runGh(
    ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS],
    cwd,
  );
  const [first] = z.array(PullRequestSchema).parse(JSON.parse(stdout));
  return first === undefined ? undefined : toPullRequest(first);
}

async function closePullRequest(url: string): Promise<void> {
  await runGh(["pr", "close", url]);
}

export async function cancelCardWithPullRequest(
  client: BoardClient,
  id: string,
  input: Parameters<BoardClient["cancelCard"]>[1],
): Promise<Card> {
  const { card } = await client.getThread(id);
  if (card.pr === null) return client.cancelCard(id, input);
  if ((input.words?.trim() ?? "").length === 0) return client.cancelCard(id, input);
  const pullRequest = await viewPullRequest(card.pr);
  if (pullRequest.state === "MERGED") {
    throw new BoardError(
      409,
      "pr_merged",
      `PR ${card.pr} is already merged; close the card with fleet close ${id}`,
    );
  }
  if (pullRequest.state === "OPEN") await closePullRequest(card.pr);
  return client.cancelCard(id, input);
}

export async function closeMergedPullRequestCards(
  client: BoardClient,
  host: string,
  projects: ReadonlySet<string>,
): Promise<void> {
  const { cards } = await client.listCards({ state: "held" });
  for (const card of cards) {
    if (card.pr === null || card.project === null || !projects.has(card.project)) continue;
    await client
      .closeCard(card.id, {
        result: `PR merged: ${card.pr}`,
        actor: runnerActor(host),
      })
      .catch(() => undefined);
  }
}
