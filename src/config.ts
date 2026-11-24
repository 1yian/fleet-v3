import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DELIVERIES, MateNameSchema } from "./board/types.ts";

export type SpawnMode = "local" | "docker" | "container";
export type KeepPanePolicy = "never" | "on-failure" | "always";

const RepoConfigSchema = z.object({
  path: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  delivery: z.enum(DELIVERIES).default("no-mistakes"),
});

const ContainerConfigSchema = z.object({
  image: z.string().min(1),
  runtime: z.string().min(1).optional(),
  ssh: z.boolean().default(false),
  cpus: z.number().int().positive().optional(),
  memory: z.string().min(1).optional(),
  inheritEnv: z.array(z.string().min(1)).default([]),
  mounts: z.array(z.string().min(1)).default([]),
  extraArgs: z.array(z.string().min(1)).default([]),
});

const HerdrConfigSchema = z.object({
  workspace: z.string().min(1).default("workers"),
  session: z.string().min(1).optional(),
  keepPane: z.enum(["never", "on-failure", "always"]).default("on-failure"),
});

const MateItemConfigSchema = z.object({
  name: MateNameSchema,
  parent: MateNameSchema.default("captain"),
  cwd: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  promptPath: z.string().min(1).optional(),
  autoStart: z.boolean().default(true),
  env: z.record(z.string().min(1), z.string()).default({}),
  command: z.array(z.string().min(1)).min(1).optional(),
});

const MatesConfigSchema = z.object({
  workspace: z.string().min(1).default("mates"),
  session: z.string().min(1).optional(),
  stateDir: z.string().min(1).default("~/.fleet-v3/mates"),
  promptPath: z.string().min(1).optional(),
  env: z.record(z.string().min(1), z.string()).default({}),
  command: z
    .array(z.string().min(1))
    .min(1)
    .default(["ypi", "-e", "{adapter}", "--append-system-prompt", "{prompt}"]),
  items: z.array(MateItemConfigSchema).default([]),
});

const ServerConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(4100),
  dataDir: z.string().min(1).default("~/.fleet-v3/board"),
  chaseIntervalSeconds: z.number().int().min(1).default(60),
  staleAfterSeconds: z.number().int().min(10).default(600),
});

const SpawnConfigSchema = z.object({
  mode: z.enum(["local", "docker", "container"]).default("local"),
  viewport: z.enum(["headless", "herdr"]).default("headless"),
  direnv: z.boolean().default(true),
  command: z.array(z.string().min(1)).min(1),
  container: ContainerConfigSchema.optional(),
  docker: ContainerConfigSchema.optional(),
  herdr: HerdrConfigSchema.optional(),
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
    matesFilter: z.array(z.string().min(1)).default([]),
    workspacesRoot: z.string().min(1).default("~/fleet-workspaces"),
    concurrency: z.number().int().min(1).max(32).default(4),
    leaseSeconds: z.number().int().min(30).max(3600).default(900),
    idleTimeoutSeconds: z.number().int().min(1).default(1800),
    maxWallSeconds: z.number().int().min(1).default(7200),
    maxAttempts: z.number().int().min(1).default(3),
    maxReviewRounds: z.number().int().min(1).max(4).default(4),
    pollWaitSeconds: z.number().int().min(1).max(60).default(15),
    workerPromptPath: z.string().min(1).optional(),
    server: ServerConfigSchema.optional(),
    spawn: SpawnConfigSchema,
    mates: MatesConfigSchema.optional(),
    verify: VerifyConfigSchema.default({
      command: ["no-mistakes", "axi", "run", "--wait", "5m"],
      respondCommand: ["no-mistakes", "axi", "respond", "--wait", "5m", "--action", "fix"],
    }),
    repos: z.record(z.string().min(1), RepoConfigSchema),
  })
  .superRefine((cfg, ctx) => {
    const items = cfg.mates?.items ?? [];
    const parentOf = new Map<string, string>();
    for (const [index, item] of items.entries()) {
      if (item.name === "captain" || parentOf.has(item.name)) {
        ctx.addIssue({
          code: "custom",
          message: `mate name "${item.name}" is reserved or duplicated`,
          path: ["mates", "items", index, "name"],
        });
        continue;
      }
      parentOf.set(item.name, item.parent);
    }
    for (const [index, item] of items.entries()) {
      const seen = new Set<string>([item.name]);
      let cursor = item.parent;
      while (cursor !== "captain") {
        const next = parentOf.get(cursor);
        if (next === undefined || seen.has(cursor)) {
          ctx.addIssue({
            code: "custom",
            message: `mate "${item.name}" does not reach captain through its parent chain`,
            path: ["mates", "items", index, "parent"],
          });
          break;
        }
        seen.add(cursor);
        cursor = next;
      }
    }
  })
  .refine(
    (cfg) =>
      cfg.spawn.mode === "local" ||
      cfg.spawn.container !== undefined ||
      cfg.spawn.docker !== undefined,
    {
      message:
        "spawn.container (or spawn.docker) is required when spawn.mode is docker or container",
      path: ["spawn", "container"],
    },
  );

export type ContainerConfig = z.infer<typeof ContainerConfigSchema>;
export type HerdrConfig = z.infer<typeof HerdrConfigSchema>;
export type MateItemConfig = z.infer<typeof MateItemConfigSchema>;
export type MatesConfig = z.infer<typeof MatesConfigSchema>;
type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

function expandPath(input: string, baseDir: string = process.cwd()): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function expandMountSpec(mount: string): string {
  const firstColon = mount.indexOf(":");
  if (firstColon <= 0) return mount;
  const source = mount.slice(0, firstColon);
  const rest = mount.slice(firstColon);
  if (source === "~") return `${homedir()}${rest}`;
  if (source.startsWith("~/")) return `${resolve(homedir(), source.slice(2))}${rest}`;
  return mount;
}

export function resolveContainerConfig(spawn: RunnerConfig["spawn"]): ContainerConfig | undefined {
  return spawn.container ?? spawn.docker;
}

export function resolveHerdrConfig(spawn: RunnerConfig["spawn"]): HerdrConfig {
  return {
    workspace: spawn.herdr?.workspace ?? "workers",
    ...(spawn.herdr?.session !== undefined ? { session: spawn.herdr.session } : {}),
    keepPane: spawn.herdr?.keepPane ?? "on-failure",
  };
}

export function extractMateParents(config: RunnerConfig | undefined): Record<string, string> {
  const parents: Record<string, string> = {};
  for (const item of config?.mates?.items ?? []) {
    parents[item.name] = item.parent;
  }
  return parents;
}

function normalizeContainerConfig(cfg: ContainerConfig | undefined): ContainerConfig | undefined {
  if (cfg === undefined) return undefined;
  return {
    ...cfg,
    mounts: cfg.mounts.map(expandMountSpec),
  };
}

function normalizeMatesConfig(cfg: MatesConfig | undefined): MatesConfig | undefined {
  if (cfg === undefined) return undefined;
  const stateDir = expandPath(cfg.stateDir);
  return {
    ...cfg,
    stateDir,
    ...(cfg.promptPath !== undefined ? { promptPath: expandPath(cfg.promptPath) } : {}),
    items: cfg.items.map((item) => ({
      ...item,
      ...(item.cwd !== undefined ? { cwd: expandPath(item.cwd) } : {}),
      ...(item.promptPath !== undefined ? { promptPath: expandPath(item.promptPath) } : {}),
    })),
  };
}

function normalizeServerConfig(cfg: ServerConfig | undefined): ServerConfig | undefined {
  if (cfg === undefined) return undefined;
  return {
    ...cfg,
    dataDir: expandPath(cfg.dataDir),
  };
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
  const container = normalizeContainerConfig(parsed.spawn.container ?? parsed.spawn.docker);
  const mates = normalizeMatesConfig(parsed.mates);
  const server = normalizeServerConfig(parsed.server);
  return {
    ...parsed,
    boardUrl: envUrl ?? parsed.boardUrl,
    workspacesRoot: expandPath(parsed.workspacesRoot),
    workerPromptPath:
      parsed.workerPromptPath === undefined ? undefined : expandPath(parsed.workerPromptPath),
    ...(server !== undefined ? { server } : {}),
    spawn: {
      ...parsed.spawn,
      ...(container !== undefined ? { container } : {}),
    },
    ...(mates !== undefined ? { mates } : {}),
    repos,
  };
}
