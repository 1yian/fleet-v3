import { fileURLToPath } from "node:url";
import type { BoardClient } from "../board/client.ts";
import { runnerActor, type ClaimReceipt, type Delivery } from "../board/types.ts";
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
  readonly epoch: number;
  readonly workerToken: string;
  readonly mate: string;
  readonly project: string;
  readonly delivery: Delivery;
  readonly workspace: TaskWorkspace;
  readonly promptPath: string;
}): Record<string, string> {
  return {
    FLEET_CARD: params.cardId,
    FLEET_CLAIM_EPOCH: String(params.epoch),
    FLEET_CLAIM_TOKEN: params.workerToken,
    FLEET_MATE: params.mate,
    FLEET_HOST: params.config.host,
    FLEET_PROJECT: params.project,
    FLEET_DELIVERY: params.delivery,
    FLEET_WORKTREE: params.workspace.worktreePath,
    FLEET_BRANCH: params.workspace.branch,
    FLEET_PROMPT: params.promptPath,
    TMPDIR: params.workspace.tmpDir,
    BOARD_URL: params.config.boardUrl,
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
      actor: runnerActor(params.config.host),
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
      actor: runnerActor(params.config.host),
    });
    return { done: true, failed: true, message: `Exited ${String(params.run.exitCode)}` };
  }
  const latest = await params.client.getThread(cardId);
  if (latest.card.epoch !== params.claim.epoch) {
    return {
      done: true,
      failed: true,
      message: `Superseded by attempt ${String(latest.card.epoch)}`,
    };
  }
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
      actor: runnerActor(params.config.host),
    });
    return { ok: false, message: verified.reason };
  }

  await params.client.postEntry(cardId, {
    epoch: params.claim.epoch,
    token: params.claim.workerToken,
    text: `Verification passed in ${String(verified.rounds)} round(s).`,
    by: runnerActor(params.config.host),
    internal: true,
    kind: "status",
  });
  return { ok: true, message: `Completed on ${params.config.host}` };
}

function openWorkerPane(
  config: RunnerConfig,
  claim: ClaimReceipt,
  project: string,
  workspace: TaskWorkspace,
  delivery: Delivery,
  signal: AbortSignal,
): Promise<HerdrPaneHandle | undefined> {
  if (config.spawn.viewport !== "herdr") return Promise.resolve(undefined);
  return openHerdrPane({
    config: resolveHerdrConfig(config.spawn),
    host: config.host,
    channel: claim.card.mate,
    project,
    taskId: claim.card.id,
    branch: workspace.branch,
    delivery,
    mode: config.spawn.mode,
    summary: claim.card.title,
    cwd: workspace.worktreePath,
    signal,
  });
}

async function abandonLaunch(
  client: BoardClient,
  claim: ClaimReceipt,
  pane: HerdrPaneHandle | undefined,
): Promise<void> {
  if (pane !== undefined) {
    await closeHerdrPane(pane, {
      failed: false,
      keepPane: "never",
      message: "Shutdown before launch",
    });
  }
  await client
    .releaseClaim(claim.card.id, { epoch: claim.epoch, token: claim.token })
    .catch(() => undefined);
}

async function runClaim(
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
      summary: `Stopped after ${String(claim.epoch - 1)} failed or expired attempts on ${config.host}. Re-queueing cannot start another worker on this card; review the thread, then escalate, replace it with a new card, or cancel.`,
      actor: runnerActor(config.host),
    });
    return;
  }

  if (project === null || config.repos[project] === undefined) {
    await client.finishClaim(cardId, {
      epoch: claim.epoch,
      token: claim.token,
      outcome: "needs_mate",
      summary: `Host ${config.host} has no registered repo for project=${project ?? "(missing)"}.`,
      actor: runnerActor(config.host),
    });
    return;
  }

  const repo = config.repos[project];
  const delivery: Delivery = claim.card.delivery ?? repo.delivery;
  const promptPath = config.workerPromptPath ?? DEFAULT_WORKER_PROMPT;
  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  if (outerSignal?.aborted === true) controller.abort();

  let leaseLost = false;
  const stopRenewal = startLeaseRenewal(client, claim, config.leaseSeconds, () => {
    leaseLost = true;
    controller.abort();
  });

  const herdrConfig = resolveHerdrConfig(config.spawn);
  let pane: HerdrPaneHandle | undefined;
  let preparedWorkspace: TaskWorkspace | undefined;
  let failed = false;
  let finalPaneMessage = `Completed on ${config.host}`;

  try {
    const workspace = await prepareWorkspace({
      workspacesRoot: config.workspacesRoot,
      channel: claim.card.mate,
      project,
      taskId: cardId,
      epoch: claim.epoch,
      repo,
    });
    preparedWorkspace = workspace;

    pane = await openWorkerPane(config, claim, project, workspace, delivery, controller.signal);
    if (controller.signal.aborted) {
      const unlaunched = pane;
      pane = undefined;
      await abandonLaunch(client, claim, unlaunched);
      return;
    }

    const paneSuffix = pane === undefined ? "" : `, herdr ${pane.paneId}`;
    await client.postEntry(cardId, {
      epoch: claim.epoch,
      token: claim.workerToken,
      text: `Runner ${config.host} claimed card #${cardId} (attempt ${String(claim.epoch)}, branch ${workspace.branch}, worktree ${workspace.worktreePath}, delivery ${delivery}${paneSuffix}).`,
      by: runnerActor(config.host),
      internal: true,
      kind: "status",
    });

    const workerEnv = buildWorkerEnv({
      config,
      cardId,
      epoch: claim.epoch,
      workerToken: claim.workerToken,
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
      actor: runnerActor(config.host),
    });
  } catch (error) {
    failed = true;
    finalPaneMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    stopRenewal();
    outerSignal?.removeEventListener("abort", onOuterAbort);
    try {
      if (pane !== undefined) {
        await closeHerdrPane(pane, {
          failed,
          keepPane: herdrConfig.keepPane,
          message: finalPaneMessage,
        });
      }
    } finally {
      if (preparedWorkspace !== undefined) await cleanupWorkspace(preparedWorkspace);
    }
  }
}

async function executeClaim(
  client: BoardClient,
  config: RunnerConfig,
  claim: ClaimReceipt,
  outerSignal?: AbortSignal,
): Promise<void> {
  try {
    await runClaim(client, config, claim, outerSignal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await client
      .finishClaim(claim.card.id, {
        epoch: claim.epoch,
        token: claim.token,
        outcome: "needs_mate",
        summary: `Runner on ${config.host} failed before the worker could finish: ${reason}`,
        actor: runnerActor(config.host),
      })
      .catch(() => undefined);
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
      claimBy: runnerActor(config.host),
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
