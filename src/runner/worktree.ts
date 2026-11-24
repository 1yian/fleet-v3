import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "../config.ts";

const execFileAsync = promisify(execFile);

export interface TaskWorkspace {
  readonly worktreePath: string;
  readonly tmpDir: string;
  readonly branch: string;
  readonly repoPath: string;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return stdout.trim();
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
  readonly repo: RepoConfig;
}): Promise<TaskWorkspace> {
  const safeChannel = sanitizeSegment(params.channel);
  const safeProject = sanitizeSegment(params.project);
  const safeTask = sanitizeSegment(params.taskId);
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

  return { worktreePath, tmpDir, branch, repoPath: params.repo.path };
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  await runGit(workspace.repoPath, ["worktree", "remove", "--force", workspace.worktreePath]).catch(
    () => undefined,
  );
  await runGit(workspace.repoPath, ["worktree", "prune"]).catch(() => undefined);
  rmSync(workspace.worktreePath, { recursive: true, force: true });
  rmSync(workspace.tmpDir, { recursive: true, force: true });
}
