import { execFile } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HerdrConfig, KeepPanePolicy, SpawnMode } from "../config.ts";
import { killProcessGroup, stopContainer, type SpawnResult } from "./spawn.ts";

const WorkspaceIdSchema = z.object({ workspace_id: z.string() });
const TabIdSchema = z.object({ tab_id: z.string() });
const PaneIdSchema = z.object({ pane_id: z.string() });

const WorkspaceCreatedResultSchema = z.object({
  workspace: WorkspaceIdSchema,
  tab: TabIdSchema,
  root_pane: PaneIdSchema,
});
const WorkspaceCreatedSchema = z.object({ result: WorkspaceCreatedResultSchema });

const PaneTokensSchema = z.object({ branch: z.string().optional() });
const PaneEntrySchema = z.object({
  pane_id: z.string(),
  tokens: PaneTokensSchema.optional(),
});
const PaneListSchema = z.object({ result: z.object({ panes: z.array(PaneEntrySchema) }) });

const BRANCH_CARD_PATTERN = /^(?:c-|fleet\/t-)(\d+)(?:-[ae](\d+))?(?:-|$)/u;

const ExitReceiptSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
});

const KNOWN_SIGNALS: ReadonlyMap<string, NodeJS.Signals> = new Map([
  ["SIGHUP", "SIGHUP"],
  ["SIGINT", "SIGINT"],
  ["SIGQUIT", "SIGQUIT"],
  ["SIGTERM", "SIGTERM"],
  ["SIGKILL", "SIGKILL"],
  ["SIGABRT", "SIGABRT"],
]);

function parseSignal(value: string | null): NodeJS.Signals | null {
  if (value === null) return null;
  return KNOWN_SIGNALS.get(value) ?? null;
}

export interface HerdrPaneHandle {
  readonly session: string | undefined;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

const PANE_WRAPPER_SCRIPT = `import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: "inherit",
});

writeFileSync(spec.pidFile, String(child.pid ?? process.pid));

const finish = (exitCode, signal) => {
  const tmp = spec.exitFile + ".tmp";
  writeFileSync(tmp, JSON.stringify({ exitCode, signal }));
  renameSync(tmp, spec.exitFile);
  process.exit(exitCode ?? 1);
};

child.on("error", (err) => {
  process.stderr.write(String(err) + "\\n");
  finish(1, null);
});

child.on("exit", (code, signal) => {
  finish(code, signal);
});
`;

export function runHerdr(
  session: string | undefined,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<string> {
  const fullArgs = session !== undefined ? ["--session", session, ...args] : [...args];
  return new Promise((resolve, reject) => {
    execFile(
      "herdr",
      fullArgs,
      { encoding: "utf8", timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function cardName(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/u, "");
}

export async function updateHerdrPaneStatus(
  handle: HerdrPaneHandle,
  state: "idle" | "working" | "blocked",
  message: string,
): Promise<void> {
  await runHerdr(handle.session, [
    "pane",
    "report-agent",
    handle.paneId,
    "--source",
    "fleet-runner",
    "--agent",
    "fleet",
    "--state",
    state,
    "--message",
    message.slice(0, 140),
  ]).catch(() => undefined);
}

export async function closePaneById(session: string | undefined, paneId: string): Promise<void> {
  await runHerdr(session, ["pane", "close", paneId]).catch(() => undefined);
}

export interface CardPane {
  readonly paneId: string;
  readonly cardId: string;
  readonly epoch: number;
}

export async function listCardPanes(session: string | undefined): Promise<readonly CardPane[]> {
  try {
    const raw = await runHerdr(session, ["pane", "list"]);
    const { result } = PaneListSchema.parse(JSON.parse(raw));
    return result.panes.flatMap((pane) => {
      const match = BRANCH_CARD_PATTERN.exec(pane.tokens?.branch ?? "");
      const cardId = match?.[1];
      if (cardId === undefined) return [];
      return [{ paneId: pane.pane_id, cardId, epoch: Number(match?.[2] ?? 0) }];
    });
  } catch {
    return [];
  }
}

export async function openHerdrPane(params: {
  readonly config: HerdrConfig;
  readonly cardId: string;
  readonly branch: string;
  readonly delivery: string;
  readonly mode: SpawnMode;
  readonly summary: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<HerdrPaneHandle | undefined> {
  const session = params.config.session;
  const slug = cardName(params.summary);
  const label = slug === "" ? `c-${params.cardId}` : slug;
  if (params.signal?.aborted === true) return undefined;

  for (const superseded of await listCardPanes(session)) {
    if (superseded.cardId === params.cardId) await closePaneById(session, superseded.paneId);
  }

  let handle: HerdrPaneHandle;
  try {
    const raw = await runHerdr(session, [
      "workspace",
      "create",
      "--label",
      label,
      "--cwd",
      params.cwd,
      "--no-focus",
    ]);
    const { result } = WorkspaceCreatedSchema.parse(JSON.parse(raw));
    handle = {
      session,
      workspaceId: result.workspace.workspace_id,
      tabId: result.tab.tab_id,
      paneId: result.root_pane.pane_id,
    };
  } catch {
    return undefined;
  }

  await runHerdr(session, [
    "pane",
    "report-metadata",
    handle.paneId,
    "--source",
    "fleet-runner",
    "--display-agent",
    params.mode,
    "--token",
    `branch=${params.branch}`,
    "--token",
    `delivery=${params.delivery}`,
  ]).catch(() => undefined);

  await updateHerdrPaneStatus(handle, "working", params.summary);
  return handle;
}

export async function closeHerdrPane(
  handle: HerdrPaneHandle,
  options: {
    readonly failed: boolean;
    readonly keepPane: KeepPanePolicy;
    readonly message: string;
  },
): Promise<void> {
  await updateHerdrPaneStatus(handle, options.failed ? "blocked" : "idle", options.message);
  const shouldClose =
    options.keepPane === "never" || (options.keepPane === "on-failure" && !options.failed);
  if (!shouldClose) return;
  await closePaneById(handle.session, handle.paneId);
}

function readRecordedPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const raw = readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function readExitReceipt(exitFile: string): {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
} | null {
  if (!existsSync(exitFile)) return null;
  try {
    const parsed = ExitReceiptSchema.parse(JSON.parse(readFileSync(exitFile, "utf8")));
    return {
      exitCode: parsed.exitCode,
      signal: parseSignal(parsed.signal),
    };
  } catch {
    return null;
  }
}

async function readPaneTail(handle: HerdrPaneHandle): Promise<string> {
  try {
    return await runHerdr(handle.session, [
      "pane",
      "read",
      handle.paneId,
      "--source",
      "recent-unwrapped",
      "--lines",
      "80",
    ]);
  } catch {
    return "";
  }
}

export function shellQuoteSingle(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export async function runCommandInHerdrPane(
  handle: HerdrPaneHandle,
  options: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly tmpDir: string;
    readonly env: Record<string, string | undefined>;
    readonly idleTimeoutMs: number;
    readonly maxWallMs: number;
    readonly signal?: AbortSignal;
    readonly containerCleanup?: {
      readonly mode: Exclude<SpawnMode, "local">;
      readonly name: string;
    };
  },
): Promise<SpawnResult> {
  if (options.signal?.aborted === true) {
    return { exitCode: null, signal: null, timedOut: null, aborted: true, outputTail: "" };
  }

  const scriptPath = join(options.tmpDir, "fleet-pane-run.mjs");
  const specPath = join(options.tmpDir, "fleet-pane-spec.json");
  const pidFile = join(options.tmpDir, "fleet-pane.pid");
  const exitFile = join(options.tmpDir, "fleet-pane.exit.json");

  const definedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) definedEnv[key] = value;
  }

  writeFileSync(scriptPath, PANE_WRAPPER_SCRIPT, "utf8");
  writeFileSync(
    specPath,
    JSON.stringify({
      argv: options.argv,
      cwd: options.cwd,
      env: definedEnv,
      pidFile,
      exitFile,
    }),
    "utf8",
  );

  const launchCmd = `${shellQuoteSingle(process.execPath)} ${shellQuoteSingle(scriptPath)} ${shellQuoteSingle(specPath)}`;
  await runHerdr(handle.session, ["pane", "run", handle.paneId, launchCmd]);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut: "idle" | "wall" | null = null;
    let aborted = false;
    let lastSnapshot = "";
    let lastActivityAt = Date.now();
    const resources: {
      killTimer?: NodeJS.Timeout;
      settleTimer?: NodeJS.Timeout;
      pollTimer?: NodeJS.Timeout;
      idleProbeTimer?: NodeJS.Timeout;
      wallTimer?: NodeJS.Timeout;
      watcher?: ReturnType<typeof watch> | undefined;
      abortHandler?: () => void;
    } = {};

    const cleanup = (): void => {
      if (resources.pollTimer !== undefined) clearInterval(resources.pollTimer);
      if (resources.idleProbeTimer !== undefined) clearInterval(resources.idleProbeTimer);
      if (resources.wallTimer !== undefined) clearTimeout(resources.wallTimer);
      if (resources.killTimer !== undefined) clearTimeout(resources.killTimer);
      if (resources.settleTimer !== undefined) clearTimeout(resources.settleTimer);
      resources.watcher?.close();
      if (resources.abortHandler !== undefined) {
        options.signal?.removeEventListener("abort", resources.abortHandler);
      }
    };

    const finishWith = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = await readPaneTail(handle);
      resolve({ exitCode, signal, timedOut, aborted, outputTail: tail.slice(-8192) });
    };

    const checkExit = (): void => {
      if (settled) return;
      const receipt = readExitReceipt(exitFile);
      if (receipt !== null) {
        void finishWith(receipt.exitCode, receipt.signal);
      }
    };

    const terminate = (reason: "idle" | "wall" | "abort"): void => {
      if (settled || timedOut !== null || aborted) return;
      if (reason === "abort") aborted = true;
      else timedOut = reason;
      killProcessGroup(readRecordedPid(pidFile), "SIGTERM");
      if (options.containerCleanup !== undefined) {
        void stopContainer(options.containerCleanup.mode, options.containerCleanup.name);
      }
      resources.killTimer = setTimeout(() => {
        killProcessGroup(readRecordedPid(pidFile), "SIGKILL");
      }, 2000);
      resources.killTimer.unref();
      resources.settleTimer = setTimeout(() => {
        void finishWith(null, "SIGKILL");
      }, 3500);
      resources.settleTimer.unref();
    };

    const probeIdle = async (): Promise<void> => {
      if (settled) return;
      const snapshot = await readPaneTail(handle);
      if (settled) return;
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        lastActivityAt = Date.now();
        return;
      }
      if (Date.now() - lastActivityAt >= options.idleTimeoutMs) {
        terminate("idle");
      }
    };

    resources.abortHandler = () => {
      terminate("abort");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        resources.abortHandler();
      } else {
        options.signal.addEventListener("abort", resources.abortHandler, { once: true });
      }
    }

    try {
      resources.watcher = watch(options.tmpDir, () => {
        checkExit();
      });
    } catch {
      resources.watcher = undefined;
    }

    resources.pollTimer = setInterval(checkExit, 100);
    resources.pollTimer.unref();

    const probeIntervalMs = Math.max(250, Math.min(2000, Math.floor(options.idleTimeoutMs / 3)));
    resources.idleProbeTimer = setInterval(() => {
      void probeIdle();
    }, probeIntervalMs);
    resources.idleProbeTimer.unref();

    resources.wallTimer = setTimeout(() => {
      terminate("wall");
    }, options.maxWallMs);
    resources.wallTimer.unref();

    checkExit();
  });
}
