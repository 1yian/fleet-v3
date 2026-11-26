import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RepoConfig } from "../config.ts";

export interface TaskWorkspace {
  readonly worktreePath: string;
  readonly tmpDir: string;
  readonly branch: string;
  readonly reservation: DatabaseSync;
  readonly repoPath: string;
  readonly gitCommonDir: string;
  readonly bootstrap: string | undefined;
}

interface Checkout {
  readonly branch: string;
  readonly worktreePath: string;
  readonly reservation: DatabaseSync;
}

const SQLITE_BUSY = 5;

function acquireReservation(lockPath: string): DatabaseSync | undefined {
  const reservation = new DatabaseSync(lockPath);
  try {
    reservation.exec("BEGIN EXCLUSIVE");
    return reservation;
  } catch (error) {
    reservation.close();
    if (error instanceof Error && "errcode" in error && error.errcode === SQLITE_BUSY) {
      return undefined;
    }
    throw error;
  }
}

function isOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNameCollision(error: unknown, branch: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(`a branch named '${branch}' already exists`) ||
    error.message.includes(`exists; cannot create 'refs/heads/${branch}'`)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
}

function runGit(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  timeout?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(error.message, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function removeCheckout(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  try {
    await runGit(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
  } catch (error) {
    throw new Error(
      `git worktree remove failed and left the checkout at ${worktreePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function canonicalPath(path: string): string {
  let parent = dirname(path);
  try {
    parent = realpathSync(parent);
  } catch {
    parent = dirname(path);
  }
  return join(parent, basename(path));
}

async function isRegisteredCheckout(repoPath: string, worktreePath: string): Promise<boolean> {
  const listing = await runGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  const wanted = canonicalPath(worktreePath);
  return listing
    .split("\0")
    .some((field) => field.startsWith("worktree ") && canonicalPath(field.slice(9)) === wanted);
}

async function rollbackWorkspace(
  repoPath: string,
  tmpDir: string,
  checkout: Checkout | undefined,
): Promise<void> {
  try {
    if (checkout !== undefined) {
      if (await isRegisteredCheckout(repoPath, checkout.worktreePath)) {
        await removeCheckout(repoPath, checkout.worktreePath, false);
      }
      await runGit(repoPath, ["branch", "-D", checkout.branch]).catch(() => undefined);
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      checkout?.reservation.close();
    }
  }
}

const cloneSyncs = new Map<string, Promise<string>>();

async function gitNetwork(
  cwd: string,
  args: readonly string[],
  operation: string,
  repoPath: string,
): Promise<void> {
  try {
    await runGit(cwd, args, { GIT_TERMINAL_PROMPT: "0" }, 120_000);
  } catch (error) {
    throw new Error(
      `Could not ${operation} for ${repoPath}. Check the remote and runner Git access.`,
      { cause: error },
    );
  }
}

async function syncClone(repoPath: string, repo: RepoConfig): Promise<string> {
  if (!existsSync(repoPath)) {
    const root = dirname(repoPath);
    const staging = mkdtempSync(join(root, ".clone-"));
    try {
      await gitNetwork(
        root,
        ["clone", "--no-local", "--origin", "origin", "--", repo.remote, staging],
        "clone origin",
        repoPath,
      );
      renameSync(staging, repoPath);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  const origin = await runGit(repoPath, ["config", "--local", "--get", "remote.origin.url"]);
  if (origin !== repo.remote) {
    throw new Error(`Origin at ${repoPath} does not match the configured remote.`);
  }
  await gitNetwork(repoPath, ["fetch", "--prune", "origin"], "fetch origin", repoPath);
  let base = repo.baseBranch;
  if (base === undefined) {
    await gitNetwork(
      repoPath,
      ["remote", "set-head", "origin", "--auto"],
      "resolve the default branch",
      repoPath,
    );
    const ref = await runGit(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    base = ref.slice("refs/remotes/origin/".length);
  }
  const commit = await runGit(repoPath, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${base}^{commit}`,
  ]);
  if ((await runGit(repoPath, ["branch", "--show-current"])) !== base) {
    await runGit(repoPath, ["switch", "--", base]);
  }
  await runGit(repoPath, ["merge-base", "--is-ancestor", "HEAD", commit]).catch(() => {
    throw new Error(`Managed branch ${base} at ${repoPath} cannot fast-forward to origin/${base}.`);
  });
  await runGit(repoPath, ["merge", "--ff-only", commit]);
  return commit;
}

async function syncProject(repoPath: string, repo: RepoConfig): Promise<string> {
  const previous = cloneSyncs.get(repoPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => syncClone(repoPath, repo));
  cloneSyncs.set(repoPath, current);
  try {
    return await current;
  } finally {
    if (cloneSyncs.get(repoPath) === current) cloneSyncs.delete(repoPath);
  }
}

export function hasEnvrcInAncestry(startDir: string): boolean {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, ".envrc"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function prepareWorkspace(params: {
  readonly projectsRoot: string;
  readonly project: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly repo: RepoConfig;
}): Promise<TaskWorkspace> {
  const projectPath = join(params.projectsRoot, params.project);
  mkdirSync(projectPath, { recursive: true });
  const baseDir = realpathSync(projectPath);
  const repoPath = join(baseDir, "repo");
  const baseCommit = await syncProject(repoPath, params.repo);
  const setupPath = join(baseDir, "setup.sh");
  const bootstrap = params.repo.bootstrap ?? (existsSync(setupPath) ? setupPath : undefined);
  const scratchRoot = join(baseDir, "tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const name = `c-${sanitizeSegment(params.taskId)}-a${String(params.epoch)}`;
  const tmpDir = mkdtempSync(join(scratchRoot, `${name}-`));
  const worktreeRoot = join(baseDir, "worktrees");
  let checkout: Checkout | undefined;

  const lockRoot = join(baseDir, "locks");

  const reserveCheckout = async (branch: string): Promise<Checkout | undefined> => {
    const worktreePath = join(worktreeRoot, branch);
    const reservation = acquireReservation(join(lockRoot, `${branch}.lock`));
    if (reservation === undefined) return undefined;
    try {
      if (isOccupied(worktreePath)) {
        reservation.close();
        return undefined;
      }
      await runGit(repoPath, ["branch", "--no-track", branch, baseCommit], {
        LC_ALL: "C",
      });
      return { branch, worktreePath, reservation };
    } catch (error) {
      reservation.close();
      if (isNameCollision(error, branch)) return undefined;
      throw error;
    }
  };

  try {
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(lockRoot, { recursive: true });
    checkout = (await reserveCheckout(name)) ?? (await reserveCheckout(basename(tmpDir)));
    if (checkout === undefined) throw new Error(`no free checkout name for ${name}`);
    const { branch, worktreePath } = checkout;
    await runGit(repoPath, ["worktree", "add", worktreePath, branch]);

    const rawCommonDir = await runGit(repoPath, ["rev-parse", "--git-common-dir"]);
    const gitCommonDir = realpathSync(resolvePath(repoPath, rawCommonDir));

    return {
      worktreePath: realpathSync(worktreePath),
      tmpDir: realpathSync(tmpDir),
      branch,
      reservation: checkout.reservation,
      repoPath,
      gitCommonDir,
      bootstrap,
    };
  } catch (error) {
    try {
      await rollbackWorkspace(repoPath, tmpDir, checkout);
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  try {
    await removeCheckout(workspace.repoPath, workspace.worktreePath, true);
  } finally {
    try {
      rmSync(workspace.tmpDir, { recursive: true, force: true });
    } finally {
      workspace.reservation.close();
    }
  }
}
