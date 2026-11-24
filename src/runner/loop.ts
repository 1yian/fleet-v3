import { fileURLToPath } from "node:url";
import type { Board, ClaimedTask } from "@vercel/board";
import { DELIVERIES, resolveHerdrConfig, type Delivery, type RunnerConfig } from "../config.ts";
import {
  closeHerdrPane,
  openHerdrPane,
  runCommandInHerdrPane,
  updateHerdrPaneStatus,
  type HerdrPaneHandle,
} from "./herdr.ts";
import {
  buildWorkerArgv,
  makeContainerName,
  runIsolatedCommand,
  type SpawnResult,
} from "./spawn.ts";
import { runBoundedVerification } from "./verify.ts";
import { cleanupWorkspace, prepareWorkspace, type TaskWorkspace } from "./worktree.ts";

const DEFAULT_WORKER_PROMPT = fileURLToPath(new URL("../../prompts/worker.md", import.meta.url));

function parseDelivery(value: string | undefined, fallback: Delivery): Delivery {
  if (value === undefined) return fallback;
  return DELIVERIES.find((each) => each === value) ?? fallback;
}

async function advertiseHost(client: Board, config: RunnerConfig): Promise<void> {
  const repoNames = Object.keys(config.repos).toSorted();
  const text = `host=${config.host} mode=${config.spawn.mode} viewport=${config.spawn.viewport} repos=${repoNames.join(", ") || "none"}`;
  await client.post(config.metaChannel, {
    text,
    labels: { kind: "host", host: config.host },
    noSync: true,
  });
}

function startLeaseRenewal(
  claim: ClaimedTask,
  leaseSeconds: number,
  onLost: () => void,
): () => void {
  const intervalMs = Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    void claim.renew(leaseSeconds).catch(() => {
      if (!active) return;
      active = false;
      onLost();
    });
  }, intervalMs);
  timer.unref();
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function buildWorkerEnv(params: {
  readonly config: RunnerConfig;
  readonly taskId: string;
  readonly project: string;
  readonly delivery: Delivery;
  readonly workspace: TaskWorkspace;
  readonly promptPath: string;
}): Record<string, string> {
  return {
    BOARD_TASK: params.taskId,
    FLEET_HOST: params.config.host,
    FLEET_PROJECT: params.project,
    FLEET_DELIVERY: params.delivery,
    FLEET_WORKTREE: params.workspace.worktreePath,
    FLEET_BRANCH: params.workspace.branch,
    FLEET_PROMPT: params.promptPath,
    TMPDIR: params.workspace.tmpDir,
    ...(params.config.boardUrl !== undefined ? { BOARD_URL: params.config.boardUrl } : {}),
  };
}

function runWorkerProcess(params: {
  readonly config: RunnerConfig;
  readonly pane: HerdrPaneHandle | undefined;
  readonly taskId: string;
  readonly epoch: number;
  readonly workspace: TaskWorkspace;
  readonly promptPath: string;
  readonly workerEnv: Record<string, string>;
  readonly signal: AbortSignal;
}): Promise<SpawnResult> {
  const containerMode = params.config.spawn.mode === "local" ? undefined : params.config.spawn.mode;
  const containerName =
    containerMode === undefined
      ? undefined
      : makeContainerName(params.config.host, params.taskId, params.epoch);
  const containerCleanup =
    containerMode !== undefined && containerName !== undefined
      ? { mode: containerMode, name: containerName }
      : undefined;

  const argv = buildWorkerArgv({
    config: params.config,
    taskId: params.taskId,
    worktreePath: params.workspace.worktreePath,
    gitCommonDir: params.workspace.gitCommonDir,
    tmpDir: params.workspace.tmpDir,
    promptPath: params.promptPath,
    env: params.workerEnv,
    tty: params.pane !== undefined,
    ...(containerName !== undefined ? { containerName } : {}),
  });

  if (params.pane !== undefined) {
    return runCommandInHerdrPane(params.pane, {
      argv,
      cwd: params.workspace.worktreePath,
      tmpDir: params.workspace.tmpDir,
      env: params.workerEnv,
      idleTimeoutMs: params.config.idleTimeoutSeconds * 1000,
      maxWallMs: params.config.maxWallSeconds * 1000,
      signal: params.signal,
      ...(containerCleanup !== undefined ? { containerCleanup } : {}),
    });
  }

  return runIsolatedCommand({
    argv,
    cwd: params.workspace.worktreePath,
    env: params.workerEnv,
    idleTimeoutMs: params.config.idleTimeoutSeconds * 1000,
    maxWallMs: params.config.maxWallSeconds * 1000,
    signal: params.signal,
    ...(containerCleanup !== undefined ? { containerCleanup } : {}),
  });
}

async function handleRunOutcome(params: {
  readonly client: Board;
  readonly config: RunnerConfig;
  readonly claim: ClaimedTask;
  readonly taskId: string;
  readonly run: SpawnResult;
  readonly leaseLost: boolean;
}): Promise<{ readonly done: boolean; readonly failed: boolean; readonly message: string }> {
  if (params.leaseLost) {
    return { done: true, failed: true, message: "Lease lost" };
  }
  if (params.run.aborted) {
    await params.claim.release().catch(() => undefined);
    return { done: true, failed: true, message: "Aborted" };
  }
  if (params.run.timedOut !== null) {
    await params.client.reply(params.taskId, {
      text: `Worker hit ${params.run.timedOut} timeout on ${params.config.host}.\n\n${params.run.outputTail.slice(-1000)}`,
      noSync: true,
    });
    await params.claim.fail(`Worker hit ${params.run.timedOut} timeout on ${params.config.host}`);
    return { done: true, failed: true, message: `Timed out (${params.run.timedOut})` };
  }
  if (params.run.exitCode !== 0) {
    await params.client.reply(params.taskId, {
      text: `Worker exited ${String(params.run.exitCode)} on ${params.config.host}.\n\n${params.run.outputTail.slice(-1000)}`,
      noSync: true,
    });
    await params.claim.fail(
      `Worker exited ${String(params.run.exitCode)} on ${params.config.host}`,
    );
    return { done: true, failed: true, message: `Exited ${String(params.run.exitCode)}` };
  }
  return { done: false, failed: false, message: `Completed on ${params.config.host}` };
}

async function handleVerification(params: {
  readonly client: Board;
  readonly config: RunnerConfig;
  readonly claim: ClaimedTask;
  readonly taskId: string;
  readonly pane: HerdrPaneHandle | undefined;
  readonly worktreePath: string;
  readonly workerEnv: Record<string, string>;
  readonly signal: AbortSignal;
  readonly isLeaseLost: () => boolean;
}): Promise<{ readonly ok: boolean; readonly message: string }> {
  if (params.pane !== undefined) {
    await updateHerdrPaneStatus(params.pane, "working", "Verifying via no-mistakes");
  }
  const verified = await runBoundedVerification({
    config: params.config,
    cwd: params.worktreePath,
    env: params.workerEnv,
    signal: params.signal,
  });

  if (params.isLeaseLost()) {
    return { ok: false, message: "Lease lost during verification" };
  }

  if (verified.status === "needs-mate") {
    await params.client.reply(params.taskId, {
      text: `Verification stopped at round ${String(verified.rounds)}/${String(params.config.maxReviewRounds)}: ${verified.reason}\n\n${verified.output.slice(-1500)}`,
    });
    await params.claim.fail(verified.reason);
    return { ok: false, message: verified.reason };
  }

  await params.client.reply(params.taskId, {
    text: `Verification passed in ${String(verified.rounds)} round(s).`,
    noSync: true,
  });
  return { ok: true, message: `Completed on ${params.config.host}` };
}

async function executeClaim(
  client: Board,
  config: RunnerConfig,
  claim: ClaimedTask,
  outerSignal?: AbortSignal,
): Promise<void> {
  const taskId = claim.task.id;
  const labels = claim.task.labels;
  const project = labels["project"];

  if (claim.epoch > config.maxAttempts) {
    await claim.block(
      `Stopped after ${String(claim.epoch - 1)} failed or expired attempts on ${config.host}. Review the thread and reopen or cancel.`,
      { kind: "retry_cap" },
    );
    return;
  }

  if (project === undefined || config.repos[project] === undefined) {
    await claim.fail(
      `Host ${config.host} has no registered repo for project=${project ?? "(missing)"}.`,
    );
    return;
  }

  const repo = config.repos[project];
  const delivery = parseDelivery(labels["delivery"], repo.delivery);
  const promptPath = config.workerPromptPath ?? DEFAULT_WORKER_PROMPT;
  const workspace = await prepareWorkspace({
    workspacesRoot: config.workspacesRoot,
    channel: claim.task.channel,
    project,
    taskId,
    repo,
  });

  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  let leaseLost = false;
  const stopRenewal = startLeaseRenewal(claim, config.leaseSeconds, () => {
    leaseLost = true;
    controller.abort();
  });

  const herdrConfig = resolveHerdrConfig(config.spawn);
  const taskSummary = claim.task.text.split("\n")[0] ?? `Task #${taskId}`;
  let pane: HerdrPaneHandle | undefined;
  let failed = false;
  let finalPaneMessage = `Completed on ${config.host}`;

  try {
    if (config.spawn.viewport === "herdr") {
      pane = await openHerdrPane({
        config: herdrConfig,
        host: config.host,
        channel: claim.task.channel,
        project,
        taskId,
        branch: workspace.branch,
        delivery,
        mode: config.spawn.mode,
        summary: taskSummary,
        cwd: workspace.worktreePath,
      });
    }

    const paneSuffix = pane === undefined ? "" : `, herdr ${pane.paneId}`;
    await client.reply(taskId, {
      text: `Runner ${config.host} claimed task #${taskId} (attempt ${String(claim.epoch)}, branch ${workspace.branch}, worktree ${workspace.worktreePath}, delivery ${delivery}${paneSuffix}).`,
      noSync: true,
    });

    const workerEnv = buildWorkerEnv({ config, taskId, project, delivery, workspace, promptPath });
    const run = await runWorkerProcess({
      config,
      pane,
      taskId,
      epoch: claim.epoch,
      workspace,
      promptPath,
      workerEnv,
      signal: controller.signal,
    });

    const outcome = await handleRunOutcome({ client, config, claim, taskId, run, leaseLost });
    failed = outcome.failed;
    finalPaneMessage = outcome.message;
    if (outcome.done) return;

    if (delivery === "no-mistakes") {
      const verification = await handleVerification({
        client,
        config,
        claim,
        taskId,
        pane,
        worktreePath: workspace.worktreePath,
        workerEnv,
        signal: controller.signal,
        isLeaseLost: () => leaseLost,
      });
      finalPaneMessage = verification.message;
      if (!verification.ok) {
        failed = true;
        return;
      }
    }

    await claim.complete(`Completed on ${config.host} (${workspace.branch})`);
  } finally {
    stopRenewal();
    outerSignal?.removeEventListener("abort", onOuterAbort);
    if (pane !== undefined) {
      await closeHerdrPane(pane, {
        failed,
        keepPane: herdrConfig.keepPane,
        message: finalPaneMessage,
      });
    }
    await cleanupWorkspace(workspace);
  }
}

async function claimNextReady(
  client: Board,
  config: RunnerConfig,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<ClaimedTask | null> {
  const perChannelWait = Math.max(0, Math.floor(waitSeconds / Math.max(1, config.channels.length)));
  for (const channel of config.channels) {
    if (signal?.aborted === true) return null;
    const claimed = await client.tasks.claim(
      {
        channel,
        label: { host: config.host },
        ...(config.from.length > 0 ? { from: config.from } : {}),
        wait: perChannelWait,
        lease: config.leaseSeconds,
      },
      signal !== undefined ? { signal } : {},
    );
    if (claimed !== null) return claimed;
  }
  return null;
}

export async function runLoop(
  client: Board,
  config: RunnerConfig,
  options: { readonly once?: boolean; readonly signal?: AbortSignal } = {},
): Promise<number> {
  await advertiseHost(client, config);
  let handled = 0;

  if (options.once === true) {
    const claimed = await claimNextReady(client, config, 0, options.signal);
    if (claimed === null) return 0;
    await executeClaim(client, config, claimed, options.signal);
    return 1;
  }

  const slots = Array.from({ length: config.concurrency }, async () => {
    while (options.signal?.aborted !== true) {
      const claimed = await claimNextReady(client, config, config.pollWaitSeconds, options.signal);
      if (claimed === null) continue;
      await executeClaim(client, config, claimed, options.signal);
      handled += 1;
    }
  });

  await Promise.all(slots);
  return handled;
}
