import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DELIVERIES = ["no-mistakes", "direct-pr", "local", "ops"] as const;
export type Delivery = (typeof DELIVERIES)[number];

const RepoConfigSchema = z.object({
  path: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  delivery: z.enum(DELIVERIES).default("no-mistakes"),
});

const DockerConfigSchema = z.object({
  image: z.string().min(1),
  runtime: z.string().min(1).optional(),
  mounts: z.array(z.string().min(1)).default([]),
  extraArgs: z.array(z.string()).default([]),
});

const SpawnConfigSchema = z.object({
  mode: z.enum(["local", "docker"]).default("local"),
  direnv: z.boolean().default(true),
  command: z.array(z.string().min(1)).min(1),
  docker: DockerConfigSchema.optional(),
});

const VerifyConfigSchema = z.object({
  command: z.array(z.string().min(1)).min(1).default(["no-mistakes", "axi", "run", "--wait", "5m"]),
  respondCommand: z
    .array(z.string().min(1))
    .min(1)
    .default(["no-mistakes", "axi", "respond", "--wait", "5m", "--action", "fix"]),
});

const RunnerConfigSchema = z
  .object({
    host: z.string().min(1),
    boardUrl: z.url().optional(),
    from: z.array(z.string().min(1)).default([]),
    channels: z.array(z.string().min(1)).min(1),
    metaChannel: z.string().min(1).default("meta"),
    workspacesRoot: z.string().min(1).default("~/fleet-workspaces"),
    concurrency: z.number().int().min(1).max(32).default(4),
    leaseSeconds: z.number().int().min(30).max(3600).default(900),
    idleTimeoutSeconds: z.number().int().min(1).default(1800),
    maxWallSeconds: z.number().int().min(1).default(7200),
    maxAttempts: z.number().int().min(1).default(3),
    maxReviewRounds: z.number().int().min(1).default(4),
    pollWaitSeconds: z.number().int().min(1).max(60).default(15),
    workerPromptPath: z.string().min(1).optional(),
    spawn: SpawnConfigSchema,
    verify: VerifyConfigSchema.default({
      command: ["no-mistakes", "axi", "run", "--wait", "5m"],
      respondCommand: ["no-mistakes", "axi", "respond", "--wait", "5m", "--action", "fix"],
    }),
    repos: z.record(z.string().min(1), RepoConfigSchema),
  })
  .refine((cfg) => cfg.spawn.mode !== "docker" || cfg.spawn.docker !== undefined, {
    message: "spawn.docker is required when spawn.mode is docker",
    path: ["spawn", "docker"],
  });

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

function expandPath(input: string, baseDir: string = process.cwd()): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function loadConfig(configPath?: string): RunnerConfig {
  const resolved = expandPath(configPath ?? process.env["FLEET_CONFIG"] ?? "fleet.yaml");
  if (!existsSync(resolved)) {
    throw new Error(
      `Config file not found at ${resolved}. Copy fleet.example.yaml to fleet.yaml or pass --config <path>.`,
    );
  }
  const raw: unknown = parseYaml(readFileSync(resolved, "utf8"));
  const parsed = RunnerConfigSchema.parse(raw);
  const envUrl = process.env["BOARD_URL"];
  const repos: Record<string, RepoConfig> = {};
  for (const [name, repo] of Object.entries(parsed.repos)) {
    repos[name] = { ...repo, path: expandPath(repo.path) };
  }
  return {
    ...parsed,
    boardUrl: envUrl ?? parsed.boardUrl,
    workspacesRoot: expandPath(parsed.workspacesRoot),
    workerPromptPath:
      parsed.workerPromptPath === undefined ? undefined : expandPath(parsed.workerPromptPath),
    repos,
  };
}
