import { spawn } from "node:child_process";
import type { RunnerConfig } from "../config.ts";
import { hasEnvrcInAncestry } from "./worktree.ts";

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: "idle" | "wall" | null;
  readonly aborted: boolean;
  readonly outputTail: string;
}

export interface RunCommandOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly idleTimeoutMs: number;
  readonly maxWallMs: number;
  readonly signal?: AbortSignal;
}

const TAIL_LIMIT = 8192;

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= TAIL_LIMIT ? combined : combined.slice(combined.length - TAIL_LIMIT);
}

function tryKill(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (!tryKill(-pid, sig)) tryKill(pid, sig);
}

export function buildWorkerArgv(params: {
  readonly config: RunnerConfig;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly tmpDir: string;
  readonly promptPath: string;
  readonly env: Record<string, string>;
}): string[] {
  const interpolated = params.config.spawn.command.map((part) =>
    part
      .replaceAll("{task}", params.taskId)
      .replaceAll("{worktree}", params.worktreePath)
      .replaceAll("{prompt}", params.promptPath),
  );

  if (params.config.spawn.mode === "docker") {
    const docker = params.config.spawn.docker;
    if (docker === undefined) {
      throw new Error("spawn.docker is required when spawn.mode is docker");
    }
    const args: string[] = [
      "docker",
      "run",
      "--rm",
      "--init",
      "-w",
      params.worktreePath,
      "-v",
      `${params.worktreePath}:${params.worktreePath}`,
      "-v",
      `${params.tmpDir}:${params.tmpDir}`,
      "-v",
      `${params.promptPath}:${params.promptPath}:ro`,
    ];
    if (docker.runtime !== undefined) {
      args.push("--runtime", docker.runtime);
    }
    for (const mount of docker.mounts) {
      args.push("-v", mount);
    }
    for (const [key, value] of Object.entries(params.env)) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(...docker.extraArgs, docker.image, ...interpolated);
    return args;
  }

  if (params.config.spawn.direnv && hasEnvrcInAncestry(params.worktreePath)) {
    return ["direnv", "exec", params.worktreePath, ...interpolated];
  }
  return interpolated;
}

export function runIsolatedCommand(options: RunCommandOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = options.argv;
    if (bin === undefined) {
      reject(new Error("Command argv must not be empty"));
      return;
    }

    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let outputTail = "";
    let timedOut: "idle" | "wall" | null = null;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: "idle" | "wall" | "abort"): void => {
      if (settled) return;
      if (reason === "abort") aborted = true;
      else timedOut ??= reason;
      killProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
      }, 2000);
      killTimer.unref();
    };

    let idleTimer = setTimeout(() => {
      terminate("idle");
    }, options.idleTimeoutMs);
    idleTimer.unref();

    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        terminate("idle");
      }, options.idleTimeoutMs);
      idleTimer.unref();
    };

    const wallTimer = setTimeout(() => {
      terminate("wall");
    }, options.maxWallMs);
    wallTimer.unref();

    const onAbort = (): void => {
      terminate("abort");
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const onChunk = (chunk: Buffer): void => {
      outputTail = appendTail(outputTail, chunk.toString("utf8"));
      resetIdle();
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    const cleanupTimers = (): void => {
      clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      killProcessGroup(child.pid, "SIGKILL");
      resolve({ exitCode, signal, timedOut, aborted, outputTail });
    });
  });
}
