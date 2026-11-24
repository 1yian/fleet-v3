import { fileURLToPath } from "node:url";
import type { Board, ClaimedTask } from "@vercel/board";
import { DELIVERIES, type Delivery, type RunnerConfig } from "../config.ts";
import { buildWorkerArgv, runIsolatedCommand } from "./spawn.ts";
import { runBoundedVerification } from "./verify.ts";
import { cleanupWorkspace, prepareWorkspace } from "./worktree.ts";

const DEFAULT_WORKER_PROMPT = fileURLToPath(new URL("../../prompts/worker.md", import.meta.url));

function parseDelivery(value: string | undefined, fallback: Delivery): Delivery {
  if (value === undefined) return fallback;
  return DELIVERIES.find((each) => each === value) ?? fallback;
}

async function advertiseHost(client: Board, config: RunnerConfig): Promise<void> {
  const repoNames = Object.keys(config.repos).toSorted();
  const text = `host=${config.host} mode=${config.spawn.mode} repos=${repoNames.join(",") || "none"}`;
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

  try {
    await client.reply(taskId, {
      text: `Runner ${config.host} claimed task #${taskId} (attempt ${String(claim.epoch)}, branch ${workspace.branch}, worktree ${workspace.worktreePath}, delivery ${delivery}).`,
      noSync: true,
    });

    const workerEnv: Record<string, string> = {
      BOARD_TASK: taskId,
      FLEET_HOST: config.host,
      FLEET_PROJECT: project,
      FLEET_DELIVERY: delivery,
      FLEET_WORKTREE: workspace.worktreePath,
      FLEET_BRANCH: workspace.branch,
      FLEET_PROMPT: promptPath,
      TMPDIR: workspace.tmpDir,
      ...(config.boardUrl !== undefined ? { BOARD_URL: config.boardUrl } : {}),
    };

    const argv = buildWorkerArgv({
      config,
      taskId,
      worktreePath: workspace.worktreePath,
      tmpDir: workspace.tmpDir,
      promptPath,
      env: workerEnv,
    });

    const run = await runIsolatedCommand({
      argv,
      cwd: workspace.worktreePath,
      env: workerEnv,
      idleTimeoutMs: config.idleTimeoutSeconds * 1000,
      maxWallMs: config.maxWallSeconds * 1000,
      signal: controller.signal,
    });

    if (leaseLost) return;

    if (run.aborted) {
      await claim.release().catch(() => undefined);
      return;
    }

    if (run.timedOut !== null) {
      await client.reply(taskId, {
        text: `Worker hit ${run.timedOut} timeout on ${config.host}.\n\n${run.outputTail.slice(-1000)}`,
        noSync: true,
      });
      await claim.fail(`Worker hit ${run.timedOut} timeout on ${config.host}`);
      return;
    }

    if (run.exitCode !== 0) {
      await client.reply(taskId, {
        text: `Worker exited ${String(run.exitCode)} on ${config.host}.\n\n${run.outputTail.slice(-1000)}`,
        noSync: true,
      });
      await claim.fail(`Worker exited ${String(run.exitCode)} on ${config.host}`);
      return;
    }

    if (delivery === "no-mistakes") {
      const verified = await runBoundedVerification({
        config,
        cwd: workspace.worktreePath,
        env: workerEnv,
        signal: controller.signal,
      });

      if (leaseLost) return;

      if (verified.status === "needs-mate") {
        await client.reply(taskId, {
          text: `Verification stopped at round ${String(verified.rounds)}/${String(config.maxReviewRounds)}: ${verified.reason}\n\n${verified.output.slice(-1500)}`,
        });
        await claim.fail(verified.reason);
        return;
      }

      await client.reply(taskId, {
        text: `Verification passed in ${String(verified.rounds)} round(s).`,
        noSync: true,
      });
    }

    await claim.complete(`Completed on ${config.host} (${workspace.branch})`);
  } finally {
    stopRenewal();
    outerSignal?.removeEventListener("abort", onOuterAbort);
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
