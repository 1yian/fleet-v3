import { fileURLToPath } from "node:url";
import type { BoardClient } from "../board/client.ts";
import type { ClaimReceipt, Delivery } from "../board/types.ts";
import { resolveHerdrConfig, type RunnerConfig } from "../config.ts";
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

async function advertiseHost(client: BoardClient, config: RunnerConfig): Promise<void> {
  await client.advertiseHost({
    host: config.host,
    mode: config.spawn.mode,
    viewport: config.spawn.viewport,
    repos: Object.keys(config.repos).toSorted(),
  });
}

function startLeaseRenewal(
  client: BoardClient,
  claim: ClaimReceipt,
  leaseSeconds: number,
  onLost: () => void,
): () => void {
  const intervalMs = Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    void client
      .renewClaim(claim.card.id, {
        epoch: claim.epoch,
        token: claim.token,
        leaseSeconds,
      })
      .catch(() => {
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
  readonly cardId: string;
  readonly mate: string;
  readonly project: string;
  readonly delivery: Delivery;
  readonly workspace: TaskWorkspace;
  readonly promptPath: string;
}): Record<string, string> {
  return {
    FLEET_CARD: params.cardId,
    BOARD_TASK: params.cardId,
    FLEET_MATE: params.mate,
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
  readonly cardId: string;
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
      : makeContainerName(params.config.host, params.cardId, params.epoch);
  const containerCleanup =
    containerMode !== undefined && containerName !== undefined
      ? { mode: containerMode, name: containerName }
      : undefined;

  const argv = buildWorkerArgv({
    config: params.config,
    taskId: params.cardId,
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
  readonly client: BoardClient;
  readonly config: RunnerConfig;
  readonly claim: ClaimReceipt;
  readonly run: SpawnResult;
  readonly leaseLost: boolean;
}): Promise<{ readonly done: boolean; readonly failed: boolean; readonly message: string }> {
  const cardId = params.claim.card.id;
  if (params.leaseLost) {
    return { done: true, failed: true, message: "Lease lost" };
  }
  if (params.run.aborted) {
    await params.client
      .releaseClaim(cardId, { epoch: params.claim.epoch, token: params.claim.token })
      .catch(() => undefined);
    return { done: true, failed: true, message: "Aborted" };
  }
  if (params.run.timedOut !== null) {
    const tail = params.run.outputTail.slice(-1000);
    const summary = `Worker hit ${params.run.timedOut} timeout on ${params.config.host}.${tail.length > 0 ? `\n\n${tail}` : ""}`;
    await params.client.finishClaim(cardId, {
      epoch: params.claim.epoch,
      token: params.claim.token,
      outcome: "needs_mate",
      summary,
      actor: `runner-${params.config.host}`,
      kind: "timeout",
    });
    return { done: true, failed: true, message: `Timed out (${params.run.timedOut})` };
  }
  if (params.run.exitCode !== 0) {
    const tail = params.run.outputTail.slice(-1000);
    const summary = `Worker exited ${String(params.run.exitCode)} on ${params.config.host}.${tail.length > 0 ? `\n\n${tail}` : ""}`;
    await params.client.finishClaim(cardId, {
      epoch: params.claim.epoch,
      token: params.claim.token,
      outcome: "needs_mate",
      summary,
      actor: `runner-${params.config.host}`,
      kind: "worker_error",
    });
    return { done: true, failed: true, message: `Exited ${String(params.run.exitCode)}` };
  }
  const latest = await params.client.getThread(cardId);
  if (latest.card.state !== "running") {
    return {
      done: true,
      failed: latest.card.state === "held",
      message: `Handed to ${latest.card.holder || latest.card.state}`,
    };
  }
  return { done: false, failed: false, message: `Completed on ${params.config.host}` };
}

async function handleVerification(params: {
  readonly client: BoardClient;
  readonly config: RunnerConfig;
  readonly claim: ClaimReceipt;
  readonly pane: HerdrPaneHandle | undefined;
  readonly worktreePath: string;
  readonly workerEnv: Record<string, string>;
  readonly signal: AbortSignal;
  readonly isLeaseLost: () => boolean;
}): Promise<{ readonly ok: boolean; readonly message: string }> {
  const cardId = params.claim.card.id;
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
    await params.client.finishClaim(cardId, {
      epoch: params.claim.epoch,
      token: params.claim.token,
      outcome: "needs_mate",
      summary: `Verification stopped at round ${String(verified.rounds)}/${String(params.config.maxReviewRounds)}: ${verified.reason}\n\n${verified.output.slice(-1500)}`,
      actor: `runner-${params.config.host}`,
      kind: "verification",
    });
    return { ok: false, message: verified.reason };
  }

  await params.client.postEntry(cardId, {
    text: `Verification passed in ${String(verified.rounds)} round(s).`,
    by: `runner-${params.config.host}`,
    internal: true,
    kind: "status",
  });
  return { ok: true, message: `Completed on ${params.config.host}` };
}

async function executeClaim(
  client: BoardClient,
  config: RunnerConfig,
  claim: ClaimReceipt,
  outerSignal?: AbortSignal,
): Promise<void> {
  const cardId = claim.card.id;
  const project = claim.card.project;

  if (claim.epoch > config.maxAttempts) {
    await client.finishClaim(cardId, {
      epoch: claim.epoch,
      token: claim.token,
      outcome: "needs_mate",
      summary: `Stopped after ${String(claim.epoch - 1)} failed or expired attempts on ${config.host}. Review the thread and re-queue, escalate, or cancel.`,
      actor: `runner-${config.host}`,
      kind: "retry_cap",
    });
    return;
  }

  if (project === null || config.repos[project] === undefined) {
    await client.finishClaim(cardId, {
      epoch: claim.epoch,
      token: claim.token,
      outcome: "needs_mate",
      summary: `Host ${config.host} has no registered repo for project=${project ?? "(missing)"}.`,
      actor: `runner-${config.host}`,
      kind: "missing_repo",
    });
    return;
  }

  const repo = config.repos[project];
  const delivery: Delivery = claim.card.delivery ?? repo.delivery;
  const promptPath = config.workerPromptPath ?? DEFAULT_WORKER_PROMPT;
  const workspace = await prepareWorkspace({
    workspacesRoot: config.workspacesRoot,
    channel: claim.card.mate,
    project,
    taskId: cardId,
    repo,
  });

  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  let leaseLost = false;
  const stopRenewal = startLeaseRenewal(client, claim, config.leaseSeconds, () => {
    leaseLost = true;
    controller.abort();
  });

  const herdrConfig = resolveHerdrConfig(config.spawn);
  let pane: HerdrPaneHandle | undefined;
  let failed = false;
  let finalPaneMessage = `Completed on ${config.host}`;

  try {
    if (config.spawn.viewport === "herdr") {
      pane = await openHerdrPane({
        config: herdrConfig,
        host: config.host,
        channel: claim.card.mate,
        project,
        taskId: cardId,
        branch: workspace.branch,
        delivery,
        mode: config.spawn.mode,
        summary: claim.card.title,
        cwd: workspace.worktreePath,
      });
    }

    const paneSuffix = pane === undefined ? "" : `, herdr ${pane.paneId}`;
    await client.postEntry(cardId, {
      text: `Runner ${config.host} claimed card #${cardId} (attempt ${String(claim.epoch)}, branch ${workspace.branch}, worktree ${workspace.worktreePath}, delivery ${delivery}${paneSuffix}).`,
      by: `runner-${config.host}`,
      internal: true,
      kind: "status",
    });

    const workerEnv = buildWorkerEnv({
      config,
      cardId,
      mate: claim.card.mate,
      project,
      delivery,
      workspace,
      promptPath,
    });
    const run = await runWorkerProcess({
      config,
      pane,
      cardId,
      epoch: claim.epoch,
      workspace,
      promptPath,
      workerEnv,
      signal: controller.signal,
    });

    const outcome = await handleRunOutcome({ client, config, claim, run, leaseLost });
    failed = outcome.failed;
    finalPaneMessage = outcome.message;
    if (outcome.done) return;

    if (delivery === "no-mistakes") {
      const verification = await handleVerification({
        client,
        config,
        claim,
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

    await client.finishClaim(cardId, {
      epoch: claim.epoch,
      token: claim.token,
      outcome: "done",
      summary: `Completed on ${config.host} (${workspace.branch})`,
      actor: `runner-${config.host}`,
    });
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

function claimNextReady(
  client: BoardClient,
  config: RunnerConfig,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<ClaimReceipt | null> {
  if (signal?.aborted === true) return Promise.resolve(null);
  return client.claimNext(
    {
      host: config.host,
      ...(config.matesFilter.length > 0 ? { mates: config.matesFilter } : {}),
      leaseSeconds: config.leaseSeconds,
      claimBy: `runner-${config.host}`,
      waitSeconds,
    },
    signal !== undefined ? { signal } : {},
  );
}

export async function runLoop(
  client: BoardClient,
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

  const isAborted = (): boolean => options.signal?.aborted === true;

  const slots = Array.from({ length: config.concurrency }, async () => {
    while (!isAborted()) {
      try {
        const claimed = await claimNextReady(
          client,
          config,
          config.pollWaitSeconds,
          options.signal,
        );
        if (claimed === null) continue;
        await executeClaim(client, config, claimed, options.signal);
        handled += 1;
      } catch {
        if (isAborted()) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
      }
    }
  });

  await Promise.all(slots);
  return handled;
}
