import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { RepoConfig } from "../config.ts";

export interface TaskWorkspace {
  readonly worktreePath: string;
  readonly tmpDir: string;
  readonly branch: string;
  readonly repoPath: string;
  readonly gitCommonDir: string;
}

interface Checkout {
  readonly branch: string;
  readonly worktreePath: string;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-");
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function branchNameTaken(repoPath: string, branch: string): Promise<boolean> {
  const refs = await runGit(repoPath, [
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    `refs/heads/${branch}`,
  ]);
  return refs !== "";
}

async function releaseCheckout(repoPath: string, worktreePath: string): Promise<void> {
  if (existsSync(worktreePath)) {
    for (const entry of readdirSync(worktreePath)) {
      rmSync(join(worktreePath, entry), { recursive: true, force: true });
    }
  }
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

  const reserveCheckout = async (branch: string): Promise<Checkout | undefined> => {
    const worktreePath = join(worktreeRoot, branch);
    try {
      mkdirSync(worktreePath);
    } catch (error) {
      if (isErrno(error, "EEXIST")) return undefined;
      throw error;
    }
    try {
      await runGit(params.repo.path, ["branch", "--no-track", branch, params.repo.baseBranch]);
    } catch (error) {
      const taken = await branchNameTaken(params.repo.path, branch).catch(() => false);
      rmSync(worktreePath, { recursive: true, force: true });
      if (taken) return undefined;
      throw error;
    }
    return { branch, worktreePath };
  };

  try {
    mkdirSync(worktreeRoot, { recursive: true });
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
      repoPath: realpathSync(params.repo.path),
      gitCommonDir,
    };
  } catch (error) {
    if (checkout !== undefined) {
      const { branch, worktreePath } = checkout;
      await releaseCheckout(params.repo.path, worktreePath);
      await runGit(params.repo.path, ["branch", "-D", branch]).catch(() => undefined);
    }
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  await releaseCheckout(workspace.repoPath, workspace.worktreePath);
  rmSync(workspace.tmpDir, { recursive: true, force: true });
}
