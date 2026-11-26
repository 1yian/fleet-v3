import type { RunnerConfig } from "../config.ts";
import { runIsolatedCommand } from "./spawn.ts";

export type VerifyOutcome =
  | { readonly status: "passed"; readonly rounds: number; readonly output: string }
  | {
      readonly status: "needs-mate";
      readonly rounds: number;
      readonly reason: string;
      readonly output: string;
    };

interface GateFinding {
  readonly id: string;
  readonly action: string;
}

const GATE_PATTERN = /^gate:\s*\S+/mu;
const FINDINGS_HEADER_PATTERN = /^findings\[\d+\]\{([^}]*)\}:[ \t]*$/mu;

function splitRow(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row.charAt(index);
    if (quoted && char === "\\") {
      index += 1;
      field += row.charAt(index);
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field.trim());
  return fields;
}

function parseGateFindings(output: string): GateFinding[] | undefined {
  if (!GATE_PATTERN.test(output)) return undefined;
  const header = FINDINGS_HEADER_PATTERN.exec(output);
  if (header === null) return [];
  const columns = (header[1] ?? "").split(",").map((column) => column.trim());
  const idColumn = columns.indexOf("id");
  const actionColumn = columns.indexOf("action");
  const findings: GateFinding[] = [];
  const lines = output.slice(header.index + header[0].length).split("\n");
  for (const line of lines.slice(1)) {
    if (!/^[ \t]+\S/u.test(line)) break;
    const fields = splitRow(line);
    const id = fields[idColumn];
    if (idColumn !== -1 && id !== undefined && id !== "") {
      findings.push({ id, action: fields[actionColumn] ?? "" });
    }
  }
  return findings;
}

function respondArgs(findings: readonly GateFinding[]): string[] {
  const fix = findings.filter((finding) => finding.action !== "no-op").map(({ id }) => id);
  if (fix.length === 0) return ["--action", "approve"];
  const ignore = findings.filter((finding) => finding.action === "no-op").map(({ id }) => id);
  return [
    "--action",
    "fix",
    "--findings",
    fix.join(","),
    ...(ignore.length > 0 ? ["--ignore", ignore.join(",")] : []),
  ];
}

export async function runBoundedVerification(params: {
  readonly config: RunnerConfig;
  readonly cwd: string;
  readonly intent: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
}): Promise<VerifyOutcome> {
  const maxRounds = params.config.maxReviewRounds;
  let argv = [...params.config.verify.command, "--intent", params.intent];
  let lastOutput = "";

  for (let round = 1; round <= maxRounds; round += 1) {
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

    const gate = parseGateFindings(lastOutput);
    if (gate === undefined) {
      if (result.exitCode === 0) return { status: "passed", rounds: round, output: lastOutput };
      return {
        status: "needs-mate",
        rounds: round,
        reason: `Verification exited ${String(result.exitCode)} in round ${String(round)} without an open gate.`,
        output: lastOutput,
      };
    }

    if (gate.length === 0) {
      return {
        status: "needs-mate",
        rounds: round,
        reason: `Verification gate in round ${String(round)} listed no readable findings, so the fix round cannot name finding IDs.`,
        output: lastOutput,
      };
    }

    argv = [...params.config.verify.respondCommand, ...respondArgs(gate)];
  }

  return {
    status: "needs-mate",
    rounds: maxRounds,
    reason: `Did not converge after ${String(maxRounds)} verification rounds (open review findings); handing back to domain mate without force-shipping.`,
    output: lastOutput,
  };
}
