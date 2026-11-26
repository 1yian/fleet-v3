import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

function isNameCollision(error: unknown, branch: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(`a branch named '${branch}' already exists`) ||
    error.message.includes(`exists; cannot create 'refs/heads/${branch}'`)
  );
}

function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
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

async function removeCheckout(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await runGit(repoPath, ["worktree", "prune"]).catch(() => undefined);
  rmSync(worktreePath, { recursive: true, force: true });
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
  readonly workspacesRoot: string;
  readonly channel: string;
  readonly project: string;
  readonly taskId: string;
  readonly epoch: number;
  readonly repo: RepoConfig;
}): Promise<TaskWorkspace> {
  const safeChannel = sanitizeSegment(params.channel);
  const safeProject = sanitizeSegment(params.project);
  const baseDir = join(params.workspacesRoot, safeChannel, safeProject);
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
      if (existsSync(worktreePath)) {
        reservation.close();
        return undefined;
      }
      await runGit(params.repo.path, ["branch", "--no-track", branch, params.repo.baseBranch]);
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
    await runGit(params.repo.path, ["worktree", "add", worktreePath, branch]);

    const rawCommonDir = await runGit(params.repo.path, ["rev-parse", "--git-common-dir"]);
    const gitCommonDir = realpathSync(resolvePath(params.repo.path, rawCommonDir));

    return {
      worktreePath: realpathSync(worktreePath),
      tmpDir: realpathSync(tmpDir),
      branch,
      reservation: checkout.reservation,
      repoPath: realpathSync(params.repo.path),
      gitCommonDir,
    };
  } catch (error) {
    if (checkout !== undefined) {
      const { branch, worktreePath, reservation } = checkout;
      await removeCheckout(params.repo.path, worktreePath);
      await runGit(params.repo.path, ["branch", "-D", branch]).catch(() => undefined);
      reservation.close();
    }
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  await removeCheckout(workspace.repoPath, workspace.worktreePath);
  workspace.reservation.close();
  rmSync(workspace.tmpDir, { recursive: true, force: true });
}
