import { fileURLToPath } from "node:url";
import type { BoardClient } from "../board/client.ts";
import { runnerActor, type ClaimReceipt, type Delivery } from "../board/types.ts";
import { resolveHerdrConfig, type RunnerConfig } from "../config.ts";
import {
  closeHerdrPane,
  closePaneById,
  listCardPanes,
  type CardPane,
  openHerdrPane,
  runCommandInHerdrPane,
  updateHerdrPaneStatus,
  type HerdrPaneHandle,
} from "./herdr.ts";
import {
  buildWorkerLaunch,
  makeContainerName,
  runIsolatedCommand,
  type SpawnResult,
} from "./spawn.ts";
import { closeMergedPullRequestCards, findBranchPullRequest, type PullRequest } from "./github.ts";
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

  const { argv, env } = buildWorkerLaunch({
    config: params.config,
    taskId: params.cardId,
    worktreePath: params.workspace.worktreePath,
    gitCommonDir: params.workspace.gitCommonDir,
    tmpDir: params.workspace.tmpDir,
    promptPath: params.promptPath,
    env: params.workerEnv,
    bootstrap: params.workspace.bootstrap,
    tty: params.pane !== undefined,
    ...(containerName !== undefined ? { containerName } : {}),
  });

  if (params.pane !== undefined) {
    return runCommandInHerdrPane(params.pane, {
      argv,
      cwd: params.workspace.worktreePath,
      tmpDir: params.workspace.tmpDir,
      env,
      idleTimeoutMs: params.config.idleTimeoutSeconds * 1000,
      maxWallMs: params.config.maxWallSeconds * 1000,
      signal: params.signal,
      ...(containerCleanup !== undefined ? { containerCleanup } : {}),
    });
  }

  return runIsolatedCommand({
    argv,
    cwd: params.workspace.worktreePath,
    env,
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
    return { done: true, failed: false, message: "Lease lost" };
  }
  if (params.run.aborted) {
    await params.client
      .releaseClaim(cardId, { epoch: params.claim.epoch, token: params.claim.token })
      .catch(() => undefined);
    return { done: true, failed: false, message: "Aborted" };
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
      failed: false,
      message: `Superseded by attempt ${String(latest.card.epoch)}`,
    };
  }
  if (latest.card.state !== "running") {
    return {
      done: true,
      failed: false,
      message: `Handed to ${latest.card.holder || latest.card.state}`,
    };
  }
  return { done: false, failed: false, message: `Completed on ${params.config.host}` };
}

function cardIntent(card: { readonly title: string; readonly body: string }): string {
  const body = card.body.trim();
  return body.length > 0 ? `${card.title}\n\n${body}` : card.title;
}

function mergeQuestion(pr: PullRequest, mate: string, project: string, yolo: boolean): string {
  if (yolo) {
    return [
      `Done, green PR ready to merge: ${pr.url}`,
      `Yolo is on for ${project}: ${mate} merges it now unless the change is destructive, irreversible, or security-sensitive. In that case escalate the card for the captain's merge decision.`,
      "The card closes by itself once GitHub shows the PR merged.",
    ].join("\n");
  }
  return [
    `Done, awaiting merge decision: ${pr.url}`,
    "Reply with one of:",
    `- merge: approve the merge. ${mate} merges the PR and the card closes by itself once GitHub shows it merged.`,
    "- changes: <what to change>. Your text goes back to the worker on this card.",
    "- close PR: drop it. Your words are recorded and the card ends as not landed.",
  ].join("\n");
}

async function finishDelivered(params: {
  readonly client: BoardClient;
  readonly config: RunnerConfig;
  readonly claim: ClaimReceipt;
  readonly project: string;
  readonly yolo: boolean;
  readonly delivery: Delivery;
  readonly workspace: TaskWorkspace;
}): Promise<{ readonly ok: boolean; readonly message: string }> {
  const { client, config, claim, workspace } = params;
  const fence = { epoch: claim.epoch, token: claim.token, actor: runnerActor(config.host) };
  const needsPullRequest = params.delivery === "no-mistakes" || params.delivery === "direct-pr";
  let pr: PullRequest | undefined;
  if (needsPullRequest) {
    try {
      pr = await findBranchPullRequest(workspace.worktreePath, workspace.branch);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await client.finishClaim(claim.card.id, {
        ...fence,
        outcome: "needs_mate",
        summary: `Could not check GitHub for the PR on ${workspace.branch}: ${reason}`,
      });
      return { ok: false, message: "PR lookup failed" };
    }
  }
  if (pr?.state === "CLOSED") {
    await client.finishClaim(claim.card.id, {
      ...fence,
      outcome: "needs_mate",
      summary: `PR ${pr.url} was closed without merging; decide whether to reopen it, rework it, or drop the card.`,
    });
    return { ok: false, message: "PR closed unmerged" };
  }
  if (pr?.state === "OPEN") {
    await client.finishClaim(claim.card.id, {
      ...fence,
      outcome: "awaiting_merge",
      pr: pr.url,
      yolo: params.yolo && pr.green,
      summary: mergeQuestion(pr, claim.card.mate, params.project, params.yolo && pr.green),
    });
    return { ok: true, message: "Awaiting merge decision" };
  }
  await client.finishClaim(claim.card.id, {
    ...fence,
    outcome: "done",
    summary: `Completed on ${config.host} (${workspace.branch})${pr === undefined ? "" : `, PR merged: ${pr.url}`}`,
  });
  return { ok: true, message: `Completed on ${config.host}` };
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
    intent: cardIntent(params.claim.card),
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
  workspace: TaskWorkspace,
  delivery: Delivery,
  signal: AbortSignal,
): Promise<HerdrPaneHandle | undefined> {
  if (config.spawn.viewport !== "herdr") return Promise.resolve(undefined);
  return openHerdrPane({
    config: resolveHerdrConfig(config.spawn),
    cardId: claim.card.id,
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

async function teardownWorkspace(
  client: BoardClient,
  config: RunnerConfig,
  cardId: string,
  workspace: TaskWorkspace,
): Promise<void> {
  try {
    await cleanupWorkspace(workspace);
  } catch (cleanupError) {
    const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    try {
      await client.postEntry(cardId, {
        text: `Runner ${config.host} could not clean up the checkout for card #${cardId}: ${reason}`,
        by: runnerActor(config.host),
        internal: true,
        kind: "status",
      });
    } catch (postError) {
      const postReason = postError instanceof Error ? postError.message : String(postError);
      process.stderr.write(
        `Runner ${config.host} could not clean up ${workspace.worktreePath} for card #${cardId}: ${reason}; reporting it failed: ${postReason}\n`,
      );
    }
  }
}

async function runClaim(
  client: BoardClient,
  config: RunnerConfig,
  claim: ClaimReceipt,
  outerSignal?: AbortSignal,
): Promise<void> {
  const cardId = claim.card.id;
  const project = claim.card.project;

  if (claim.card.attempts > config.maxAttempts) {
    await client.finishClaim(cardId, {
      epoch: claim.epoch,
      token: claim.token,
      outcome: "needs_mate",
      summary: `Stopped after ${String(claim.card.attempts - 1)} failed or expired attempts on ${config.host}. Review the thread, fix the blocker and run \`fleet queue ${cardId}\` to reset attempts and retry, or close/escalate.`,
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
      projectsRoot: config.projectsRoot,
      project,
      taskId: cardId,
      epoch: claim.epoch,
      repo,
    });
    preparedWorkspace = workspace;

    pane = await openWorkerPane(config, claim, workspace, delivery, controller.signal);
    const paneSuffix = pane === undefined ? "" : `, herdr ${pane.paneId}`;
    await client.postEntry(cardId, {
      epoch: claim.epoch,
      token: claim.workerToken,
      text: `Runner ${config.host} claimed card #${cardId} (attempt ${String(claim.card.attempts)}, branch ${workspace.branch}, worktree ${workspace.worktreePath}, delivery ${delivery}${paneSuffix}).`,
      by: runnerActor(config.host),
      internal: true,
      kind: "status",
    });
    if (controller.signal.aborted) {
      const unlaunched = pane;
      pane = undefined;
      await abandonLaunch(client, claim, unlaunched);
      return;
    }

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
        failed = !leaseLost;
        return;
      }
    }

    const delivered = await finishDelivered({
      client,
      config,
      claim,
      project,
      yolo: repo.yolo,
      delivery,
      workspace,
    });
    finalPaneMessage = delivered.message;
    failed = !delivered.ok;
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
      if (preparedWorkspace !== undefined) {
        await teardownWorkspace(client, config, cardId, preparedWorkspace);
      }
    }
  }
}

const activeCards = new Set<string>();

async function reapStalePanes(client: BoardClient, config: RunnerConfig): Promise<void> {
  if (config.spawn.viewport !== "herdr") return;
  const { session } = resolveHerdrConfig(config.spawn);
  const panesByCard = new Map<string, CardPane[]>();
  for (const pane of await listCardPanes(session)) {
    if (activeCards.has(pane.cardId)) continue;
    panesByCard.set(pane.cardId, [...(panesByCard.get(pane.cardId) ?? []), pane]);
  }
  for (const [cardId, panes] of panesByCard) {
    const state = await client
      .getThread(cardId)
      .then((thread) => thread.card.state)
      .catch(() => undefined);
    if (state === undefined) continue;
    const kept =
      state === "held" || state === "queued"
        ? panes.reduce((newest, pane) => (pane.epoch >= newest.epoch ? pane : newest))
        : undefined;
    for (const pane of panes) {
      if (pane !== kept) await closePaneById(session, pane.paneId);
    }
  }
}

async function executeClaim(
  client: BoardClient,
  config: RunnerConfig,
  claim: ClaimReceipt,
  outerSignal?: AbortSignal,
): Promise<void> {
  activeCards.add(claim.card.id);
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
  } finally {
    activeCards.delete(claim.card.id);
    await reapStalePanes(client, config);
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
  await reapStalePanes(client, config);
  let handled = 0;

  if (options.once === true) {
    const claimed = await claimNextReady(client, config, 0, options.signal);
    if (claimed === null) return 0;
    await executeClaim(client, config, claimed, options.signal);
    return 1;
  }

  const isAborted = (): boolean => options.signal?.aborted === true;

  const sweepIntervalMs = config.prPollSeconds * 1000;
  const projects = new Set(Object.keys(config.repos));
  const sweepMerged = (): void => {
    if (isAborted()) return;
    void closeMergedPullRequestCards(client, config.host, projects).catch(() => undefined);
  };
  const sweepTimer = setInterval(sweepMerged, sweepIntervalMs);
  sweepTimer.unref();
  sweepMerged();

  const slots = Array.from({ length: config.concurrency }, async (_, slot) => {
    while (!isAborted()) {
      try {
        const claimed = await claimNextReady(
          client,
          config,
          config.pollWaitSeconds,
          options.signal,
        );
        if (claimed === null) {
          if (slot === 0) await reapStalePanes(client, config);
          continue;
        }
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
  clearInterval(sweepTimer);
  return handled;
}
