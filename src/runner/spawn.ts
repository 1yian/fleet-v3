import { execFile, spawn } from "node:child_process";
import {
  expandMountSpec,
  resolveContainerConfig,
  type RunnerConfig,
  type SpawnMode,
} from "../config.ts";
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
  readonly containerCleanup?: {
    readonly mode: Exclude<SpawnMode, "local">;
    readonly name: string;
  };
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

export function killProcessGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (!tryKill(-pid, sig)) tryKill(pid, sig);
}

function execSilent(bin: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { timeout: 10_000 }, () => {
      resolve();
    });
  });
}

export async function stopContainer(
  mode: Exclude<SpawnMode, "local">,
  containerName: string,
): Promise<void> {
  if (mode === "container") {
    await execSilent("container", ["stop", containerName]);
    await execSilent("container", ["delete", "--force", containerName]);
    return;
  }
  await execSilent("docker", ["rm", "-f", containerName]);
}

export function makeContainerName(host: string, taskId: string, attempt: number): string {
  const cleanHost = host.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
  const cleanTask = taskId.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `fleet-${cleanHost}-t-${cleanTask}-a${String(attempt)}-${suffix}`.slice(0, 63);
}

function appendSshArgs(args: string[], mode: Exclude<SpawnMode, "local">): void {
  if (mode === "container") {
    args.push("--ssh");
    return;
  }
  const sshSock = process.env["SSH_AUTH_SOCK"];
  if (sshSock !== undefined && sshSock.length > 0) {
    args.push("-v", `${sshSock}:${sshSock}`, "-e", `SSH_AUTH_SOCK=${sshSock}`);
  }
}

function buildContainerArgv(params: {
  readonly mode: Exclude<SpawnMode, "local">;
  readonly config: RunnerConfig;
  readonly worktreePath: string;
  readonly gitCommonDir?: string;
  readonly tmpDir: string;
  readonly promptPath: string;
  readonly env: Record<string, string>;
  readonly tty?: boolean;
  readonly containerName?: string;
  readonly command: readonly string[];
}): string[] {
  const container = resolveContainerConfig(params.config.spawn);
  if (container === undefined) {
    throw new Error(`spawn.container is required when spawn.mode is ${params.mode}`);
  }
  const bin = params.mode === "container" ? "container" : "docker";
  const args: string[] = [bin, "run", "--rm", "--init"];
  if (params.tty === true) args.push("-i", "-t");
  if (params.containerName !== undefined) args.push("--name", params.containerName);

  args.push(
    "-w",
    params.worktreePath,
    "-v",
    `${params.worktreePath}:${params.worktreePath}`,
    "-v",
    `${params.tmpDir}:${params.tmpDir}`,
    "-v",
    `${params.promptPath}:${params.promptPath}:ro`,
  );
  if (params.gitCommonDir !== undefined) {
    args.push("-v", `${params.gitCommonDir}:${params.gitCommonDir}`);
  }
  if (container.runtime !== undefined) args.push("--runtime", container.runtime);
  if (container.cpus !== undefined) args.push("--cpus", String(container.cpus));
  if (container.memory !== undefined) args.push("--memory", container.memory);
  if (container.ssh) appendSshArgs(args, params.mode);

  for (const mount of container.mounts) {
    args.push("-v", expandMountSpec(mount));
  }
  for (const envName of container.inheritEnv) {
    if (params.env[envName] !== undefined) continue;
    const hostValue = process.env[envName];
    if (hostValue !== undefined) args.push("-e", `${envName}=${hostValue}`);
  }
  for (const [key, value] of Object.entries(params.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(...container.extraArgs, container.image, ...params.command);
  return args;
}

export function buildWorkerArgv(params: {
  readonly config: RunnerConfig;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly gitCommonDir?: string;
  readonly tmpDir: string;
  readonly promptPath: string;
  readonly env: Record<string, string>;
  readonly tty?: boolean;
  readonly containerName?: string;
}): string[] {
  const interpolated = params.config.spawn.command.map((part) =>
    part
      .replaceAll("{card}", params.taskId)
      .replaceAll("{worktree}", params.worktreePath)
      .replaceAll("{prompt}", params.promptPath),
  );

  const mode = params.config.spawn.mode;
  if (mode === "docker" || mode === "container") {
    return buildContainerArgv({
      mode,
      config: params.config,
      worktreePath: params.worktreePath,
      tmpDir: params.tmpDir,
      promptPath: params.promptPath,
      env: params.env,
      command: interpolated,
      ...(params.gitCommonDir !== undefined ? { gitCommonDir: params.gitCommonDir } : {}),
      ...(params.tty !== undefined ? { tty: params.tty } : {}),
      ...(params.containerName !== undefined ? { containerName: params.containerName } : {}),
    });
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
      if (options.containerCleanup !== undefined) {
        void stopContainer(options.containerCleanup.mode, options.containerCleanup.name);
      }
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
