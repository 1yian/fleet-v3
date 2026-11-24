import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { RepoConfig } from "../config.ts";

export interface TaskWorkspace {
  readonly worktreePath: string;
  readonly tmpDir: string;
  readonly branch: string;
  readonly repoPath: string;
  readonly gitCommonDir: string;
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
  const safeTask = `${sanitizeSegment(params.taskId)}-e${String(params.epoch)}`;
  const baseDir = join(params.workspacesRoot, safeChannel, safeProject);
  const worktreePath = join(baseDir, "worktrees", `t-${safeTask}`);
  const tmpDir = join(baseDir, "tmp", `t-${safeTask}`);
  const branch = `fleet/t-${safeTask}`;

  mkdirSync(dirname(worktreePath), { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  if (existsSync(worktreePath)) {
    await runGit(params.repo.path, ["worktree", "remove", "--force", worktreePath]).catch(
      () => undefined,
    );
    rmSync(worktreePath, { recursive: true, force: true });
  }

  await runGit(params.repo.path, ["worktree", "prune"]).catch(() => undefined);
  await runGit(params.repo.path, [
    "worktree",
    "add",
    "-B",
    branch,
    worktreePath,
    params.repo.baseBranch,
  ]);

  const rawCommonDir = await runGit(params.repo.path, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = realpathSync(resolvePath(params.repo.path, rawCommonDir));

  return {
    worktreePath: realpathSync(worktreePath),
    tmpDir: realpathSync(tmpDir),
    branch,
    repoPath: realpathSync(params.repo.path),
    gitCommonDir,
  };
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  await runGit(workspace.repoPath, ["worktree", "remove", "--force", workspace.worktreePath]).catch(
    () => undefined,
  );
  await runGit(workspace.repoPath, ["worktree", "prune"]).catch(() => undefined);
  rmSync(workspace.worktreePath, { recursive: true, force: true });
  rmSync(workspace.tmpDir, { recursive: true, force: true });
}
