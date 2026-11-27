import { execFile } from "node:child_process";

const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;
const GH_TIMEOUT_MS = 15_000;

export function extractPullRequestUrls(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => text.match(PULL_REQUEST_URL) ?? []))];
}

export function isPullRequestMerged(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", url, "--json", "state", "--jq", ".state"],
      { timeout: GH_TIMEOUT_MS, signal },
      (error, stdout) => {
        resolve(error === null && stdout.trim() === "MERGED");
      },
    );
  });
}
