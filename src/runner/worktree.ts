import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env: { ...process.env, ...env } },
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

async function registeredCheckouts(repoPath: string): Promise<Map<string, string | undefined>> {
  const listing = await runGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
  const checkouts = new Map<string, string | undefined>();
  for (const record of listing.split("\0\0")) {
    const [worktree, ...fields] = record.split("\0");
    if (worktree?.startsWith("worktree ") === true) {
      const branch = fields.find((field) => field.startsWith("branch "));
      checkouts.set(canonicalPath(worktree.slice(9)), branch?.slice(7));
    }
  }
  return checkouts;
}

type CleanupStep = readonly [label: string | null, run: () => void | Promise<void>];

async function collectFailures(steps: readonly CleanupStep[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(
        label === null ? error : new Error(`${label}: ${errorMessage(error)}`, { cause: error }),
      );
    }
  }
  return failures;
}

function primaryFailure(primary: unknown, secondary: readonly unknown[]): unknown {
  if (secondary.length === 0) return primary;
  const failures = [primary, ...secondary];
  return new AggregateError(failures, failures.map((error) => errorMessage(error)).join("; "), {
    cause: primary,
  });
}

function workspaceCleanup(tmpDir: string, reservation?: DatabaseSync): readonly CleanupStep[] {
  return [
    [
      `Could not remove scratch directory ${tmpDir}`,
      () => {
        rmSync(tmpDir, { recursive: true, force: true });
      },
    ],
    ["Could not close checkout reservation", () => reservation?.close()],
  ];
}

async function rollbackCheckout(repoPath: string, checkout: Checkout): Promise<void> {
  const registered = await registeredCheckouts(repoPath);
  if (registered.get(canonicalPath(checkout.worktreePath)) === `refs/heads/${checkout.branch}`) {
    await removeCheckout(repoPath, checkout.worktreePath, false);
  }
  await runGit(repoPath, ["branch", "-D", checkout.branch]);
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
      const occupied = isOccupied(worktreePath);
      const registered = occupied ? undefined : await registeredCheckouts(params.repo.path);
      if (!occupied && registered?.has(canonicalPath(worktreePath)) !== true) {
        try {
          await runGit(params.repo.path, ["branch", "--no-track", branch, params.repo.baseBranch], {
            LC_ALL: "C",
          });
          return { branch, worktreePath, reservation };
        } catch (error) {
          if (!isNameCollision(error, branch)) throw error;
        }
      }
    } catch (error) {
      throw primaryFailure(
        error,
        await collectFailures([
          [
            "Could not close checkout reservation",
            () => {
              reservation.close();
            },
          ],
        ]),
      );
    }
    reservation.close();
    return undefined;
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
    const cleanupErrors = await collectFailures([
      [
        "Could not roll back checkout",
        async () => {
          if (checkout !== undefined) await rollbackCheckout(params.repo.path, checkout);
        },
      ],
      ...workspaceCleanup(tmpDir, checkout?.reservation),
    ]);
    throw primaryFailure(error, cleanupErrors);
  }
}

export async function cleanupWorkspace(workspace: TaskWorkspace): Promise<void> {
  const failures = await collectFailures([
    [null, () => removeCheckout(workspace.repoPath, workspace.worktreePath, true)],
    ...workspaceCleanup(workspace.tmpDir, workspace.reservation),
  ]);
  if (failures.length > 0) {
    const [primary, ...secondary] = failures;
    throw primaryFailure(primary, secondary);
  }
}
