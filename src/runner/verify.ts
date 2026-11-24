import type { RunnerConfig } from "../config.ts";
import { runIsolatedCommand } from "./spawn.ts";

export type VerifyOutcome =
  | { readonly status: "passed"; readonly rounds: number; readonly output: string }
  | { readonly status: "needs-mate"; readonly rounds: number; readonly reason: string; readonly output: string };

const FINDINGS_PATTERN = /\b(findings|ask-user|auto-fix|review-failed|gate)\b/i;

export async function runBoundedVerification(params: {
  readonly config: RunnerConfig;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
}): Promise<VerifyOutcome> {
  const maxRounds = params.config.maxReviewRounds;
  let lastOutput = "";

  for (let round = 1; round <= maxRounds; round += 1) {
    const argv = round === 1 ? params.config.verify.command : params.config.verify.respondCommand;
    const result = await runIsolatedCommand({
      argv,
      cwd: params.cwd,
      env: { ...params.env, FLEET_REVIEW_ROUND: String(round) },
      idleTimeoutMs: params.config.idleTimeoutSeconds * 1000,
      maxWallMs: params.config.maxWallSeconds * 1000,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });

    lastOutput = result.outputTail.trim();

    if (result.aborted) {
      return {
        status: "needs-mate",
        rounds: round,
        reason: `Verification aborted during round ${String(round)}`,
        output: lastOutput,
      };
    }

    if (result.timedOut !== null) {
      return {
        status: "needs-mate",
        rounds: round,
        reason: `Verification hit ${result.timedOut} timeout during round ${String(round)}`,
        output: lastOutput,
      };
    }

    if (result.exitCode === 0) {
      return { status: "passed", rounds: round, output: lastOutput };
    }

    if (round === maxRounds) {
      const kind = FINDINGS_PATTERN.test(lastOutput) ? "open review findings" : `exit ${String(result.exitCode)}`;
      return {
        status: "needs-mate",
        rounds: round,
        reason: `Did not converge after ${String(maxRounds)} verification rounds (${kind}); handing back to domain mate without force-shipping.`,
        output: lastOutput,
      };
    }
  }

  return {
    status: "needs-mate",
    rounds: maxRounds,
    reason: `Did not converge after ${String(maxRounds)} verification rounds.`,
    output: lastOutput,
  };
}
