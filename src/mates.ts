import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { MateItemConfig, MatesConfig, RunnerConfig } from "./config.ts";
import { runHerdr, shellQuoteSingle } from "./runner/herdr.ts";

const DEFAULT_MATE_PROMPT = fileURLToPath(new URL("../prompts/mate.md", import.meta.url));
const DEFAULT_PI_ADAPTER = fileURLToPath(new URL("adapters/pi.ts", import.meta.url));

const WorkspaceEntrySchema = z.object({
  workspace_id: z.string(),
  label: z.string(),
});
const WorkspaceListResultSchema = z.object({ workspaces: z.array(WorkspaceEntrySchema) });
const WorkspaceListSchema = z.object({ result: WorkspaceListResultSchema });

const TabEntrySchema = z.object({
  tab_id: z.string(),
  label: z.string(),
  workspace_id: z.string(),
});
const TabListResultSchema = z.object({ tabs: z.array(TabEntrySchema) });
const TabListSchema = z.object({ result: TabListResultSchema });

const PaneEntrySchema = z.object({
  pane_id: z.string(),
  tab_id: z.string(),
  workspace_id: z.string(),
});
const PaneListResultSchema = z.object({ panes: z.array(PaneEntrySchema) });
const PaneListSchema = z.object({ result: PaneListResultSchema });

const WorkspaceIdSchema = z.object({ workspace_id: z.string() });
const TabIdSchema = z.object({ tab_id: z.string() });
const PaneIdSchema = z.object({ pane_id: z.string() });

const WorkspaceCreatedResultSchema = z.object({
  workspace: WorkspaceIdSchema,
  tab: TabIdSchema,
  root_pane: PaneIdSchema,
});
const WorkspaceCreatedSchema = z.object({ result: WorkspaceCreatedResultSchema });

const TabCreatedResultSchema = z.object({
  tab: TabIdSchema,
  root_pane: PaneIdSchema,
});
const TabCreatedSchema = z.object({ result: TabCreatedResultSchema });

const ProcessPidSchema = z.object({ pid: z.number().int() });
const ProcessInfoDetailSchema = z.object({
  shell_pid: z.number().int().nullable().optional(),
  foreground_processes: z.array(ProcessPidSchema).default([]),
});
const ProcessInfoResultSchema = z.object({ process_info: ProcessInfoDetailSchema });
const ProcessInfoSchema = z.object({ result: ProcessInfoResultSchema });

const MATE_LAUNCHER_SCRIPT = `import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: "inherit",
});

process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

child.on("error", (err) => {
  process.stderr.write(String(err) + "\\n");
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
`;

interface ResolvedMate {
  readonly item: MateItemConfig;
  readonly workspace: string;
  readonly session: string | undefined;
  readonly stateDir: string;
  readonly cwd: string;
  readonly promptPath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface ExistingPane {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface MateStatus {
  readonly name: string;
  readonly parent: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly autoStart: boolean;
  readonly status: "running" | "idle-shell" | "stopped";
  readonly paneId?: string;
  readonly tabId?: string;
  readonly workspaceId?: string;
}

export interface MateActionResult {
  readonly name: string;
  readonly parent: string;
  readonly workspace: string;
  readonly action: "started" | "restarted" | "already-running";
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
}

export interface MateStopResult {
  readonly name: string;
  readonly parent: string;
  readonly action: "stopped" | "not-running";
  readonly paneId?: string;
}

function interpolate(template: string, vars: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

function resolveMate(config: RunnerConfig, mates: MatesConfig, item: MateItemConfig): ResolvedMate {
  const stateDir = join(mates.stateDir, item.name);
  const cwd = item.cwd ?? stateDir;
  const promptPath = item.promptPath ?? mates.promptPath ?? DEFAULT_MATE_PROMPT;
  const workspace = item.workspace ?? mates.workspace;
  const vars: Record<string, string> = {
    name: item.name,
    parent: item.parent,
    prompt: promptPath,
    adapter: DEFAULT_PI_ADAPTER,
    cwd,
    stateDir,
  };
  const commandTemplate = item.command ?? mates.command;
  const argv = commandTemplate.map((token) => interpolate(token, vars));
  const mergedEnv: Record<string, string> = {
    FLEET_MATE: item.name,
    FLEET_PARENT: item.parent,
    ...(config.boardUrl !== undefined ? { BOARD_URL: config.boardUrl } : {}),
  };
  for (const [key, value] of Object.entries(mates.env)) {
    mergedEnv[key] = interpolate(value, vars);
  }
  for (const [key, value] of Object.entries(item.env)) {
    mergedEnv[key] = interpolate(value, vars);
  }
  return {
    item,
    workspace,
    session: mates.session,
    stateDir,
    cwd,
    promptPath,
    argv,
    env: mergedEnv,
  };
}

function requireMates(config: RunnerConfig): MatesConfig {
  if (config.mates === undefined) {
    return {
      workspace: "mates",
      stateDir: join(config.workspacesRoot, "mates"),
      env: {},
      command: ["ypi", "-e", "{adapter}", "--append-system-prompt", "{prompt}"],
      items: [],
    };
  }
  return config.mates;
}

async function listWorkspaces(
  session: string | undefined,
): Promise<readonly { readonly workspace_id: string; readonly label: string }[]> {
  try {
    const raw = await runHerdr(session, ["workspace", "list"]);
    return WorkspaceListSchema.parse(JSON.parse(raw)).result.workspaces;
  } catch {
    return [];
  }
}

async function findExistingMatePane(
  session: string | undefined,
  workspaceLabel: string,
  mateName: string,
): Promise<ExistingPane | undefined> {
  const workspaces = await listWorkspaces(session);
  const ws = workspaces.find((entry) => entry.label === workspaceLabel);
  if (ws === undefined) return undefined;

  const [tabsRaw, panesRaw] = await Promise.all([
    runHerdr(session, ["tab", "list", "--workspace", ws.workspace_id]).catch(() => undefined),
    runHerdr(session, ["pane", "list", "--workspace", ws.workspace_id]).catch(() => undefined),
  ]);
  if (tabsRaw === undefined || panesRaw === undefined) return undefined;

  const tabs = TabListSchema.parse(JSON.parse(tabsRaw)).result.tabs;
  const tab = tabs.find((entry) => entry.label === mateName);
  if (tab === undefined) return undefined;

  const panes = PaneListSchema.parse(JSON.parse(panesRaw)).result.panes;
  const pane = panes.find((entry) => entry.tab_id === tab.tab_id);
  if (pane === undefined) return undefined;

  return {
    workspaceId: ws.workspace_id,
    tabId: tab.tab_id,
    paneId: pane.pane_id,
  };
}

async function isPaneRunningCommand(session: string | undefined, paneId: string): Promise<boolean> {
  try {
    const raw = await runHerdr(session, ["pane", "process-info", "--pane", paneId]);
    const info = ProcessInfoSchema.parse(JSON.parse(raw)).result.process_info;
    const shellPid = info.shell_pid ?? null;
    return info.foreground_processes.some((proc) => proc.pid !== shellPid);
  } catch {
    return false;
  }
}

async function createMatePane(mate: ResolvedMate): Promise<ExistingPane> {
  const workspaces = await listWorkspaces(mate.session);
  const existingWs = workspaces.find((entry) => entry.label === mate.workspace);
  if (existingWs !== undefined) {
    const raw = await runHerdr(mate.session, [
      "tab",
      "create",
      "--workspace",
      existingWs.workspace_id,
      "--label",
      mate.item.name,
      "--cwd",
      mate.cwd,
      "--no-focus",
    ]);
    const parsed = TabCreatedSchema.parse(JSON.parse(raw));
    return {
      workspaceId: existingWs.workspace_id,
      tabId: parsed.result.tab.tab_id,
      paneId: parsed.result.root_pane.pane_id,
    };
  }

  const raw = await runHerdr(mate.session, [
    "workspace",
    "create",
    "--label",
    mate.workspace,
    "--cwd",
    mate.cwd,
    "--no-focus",
  ]);
  const parsed = WorkspaceCreatedSchema.parse(JSON.parse(raw));
  await runHerdr(mate.session, ["tab", "rename", parsed.result.tab.tab_id, mate.item.name]).catch(
    () => undefined,
  );
  return {
    workspaceId: parsed.result.workspace.workspace_id,
    tabId: parsed.result.tab.tab_id,
    paneId: parsed.result.root_pane.pane_id,
  };
}

async function launchMateInPane(mate: ResolvedMate, pane: ExistingPane): Promise<void> {
  mkdirSync(mate.stateDir, { recursive: true });
  mkdirSync(mate.cwd, { recursive: true });
  const scriptPath = join(mate.stateDir, "fleet-mate-run.mjs");
  const specPath = join(mate.stateDir, "fleet-mate-spec.json");
  writeFileSync(scriptPath, MATE_LAUNCHER_SCRIPT, "utf8");
  writeFileSync(
    specPath,
    JSON.stringify({
      argv: mate.argv,
      cwd: mate.cwd,
      env: mate.env,
    }),
    "utf8",
  );

  await runHerdr(mate.session, [
    "pane",
    "report-metadata",
    pane.paneId,
    "--source",
    "fleet-mates",
    "--title",
    mate.item.name,
    "--display-agent",
    "mate",
    "--token",
    `parent=${mate.item.parent}`,
  ]).catch(() => undefined);

  const cmd = `${shellQuoteSingle(process.execPath)} ${shellQuoteSingle(scriptPath)} ${shellQuoteSingle(specPath)}`;
  await runHerdr(mate.session, ["pane", "run", pane.paneId, cmd]);
}

function selectMates(
  mates: MatesConfig,
  options: { readonly name?: string; readonly all?: boolean },
): readonly MateItemConfig[] {
  if (options.name !== undefined) {
    const found = mates.items.find((entry) => entry.name === options.name);
    if (found === undefined) {
      const known = mates.items.map((entry) => entry.name).join(", ") || "(none)";
      throw new Error(`Unknown mate "${options.name}". Configured mates: ${known}`);
    }
    return [found];
  }
  if (options.all === true) return mates.items;
  return mates.items.filter((entry) => entry.autoStart);
}

export async function listMates(config: RunnerConfig): Promise<MateStatus[]> {
  const mates = requireMates(config);
  const results: MateStatus[] = [];
  for (const item of mates.items) {
    const resolved = resolveMate(config, mates, item);
    const pane = await findExistingMatePane(resolved.session, resolved.workspace, item.name);
    if (pane === undefined) {
      results.push({
        name: item.name,
        parent: item.parent,
        workspace: resolved.workspace,
        cwd: resolved.cwd,
        autoStart: item.autoStart,
        status: "stopped",
      });
      continue;
    }
    const running = await isPaneRunningCommand(resolved.session, pane.paneId);
    results.push({
      name: item.name,
      parent: item.parent,
      workspace: resolved.workspace,
      cwd: resolved.cwd,
      autoStart: item.autoStart,
      status: running ? "running" : "idle-shell",
      paneId: pane.paneId,
      tabId: pane.tabId,
      workspaceId: pane.workspaceId,
    });
  }
  return results;
}

export async function ensureMatesUp(
  config: RunnerConfig,
  options: { readonly name?: string; readonly all?: boolean } = {},
): Promise<MateActionResult[]> {
  const mates = requireMates(config);
  const targets = selectMates(mates, options);
  const results: MateActionResult[] = [];
  for (const item of targets) {
    const resolved = resolveMate(config, mates, item);
    mkdirSync(resolved.stateDir, { recursive: true });
    mkdirSync(resolved.cwd, { recursive: true });
    const existing = await findExistingMatePane(resolved.session, resolved.workspace, item.name);
    if (existing !== undefined) {
      const running = await isPaneRunningCommand(resolved.session, existing.paneId);
      if (running) {
        results.push({
          name: item.name,
          parent: item.parent,
          workspace: resolved.workspace,
          action: "already-running",
          paneId: existing.paneId,
          tabId: existing.tabId,
          workspaceId: existing.workspaceId,
        });
        continue;
      }
      await launchMateInPane(resolved, existing);
      results.push({
        name: item.name,
        parent: item.parent,
        workspace: resolved.workspace,
        action: "restarted",
        paneId: existing.paneId,
        tabId: existing.tabId,
        workspaceId: existing.workspaceId,
      });
      continue;
    }

    const created = await createMatePane(resolved);
    await launchMateInPane(resolved, created);
    results.push({
      name: item.name,
      parent: item.parent,
      workspace: resolved.workspace,
      action: "started",
      paneId: created.paneId,
      tabId: created.tabId,
      workspaceId: created.workspaceId,
    });
  }
  return results;
}

export async function stopMates(
  config: RunnerConfig,
  options: { readonly name?: string; readonly all?: boolean } = {},
): Promise<MateStopResult[]> {
  const mates = requireMates(config);
  const targets =
    options.name !== undefined
      ? selectMates(mates, { name: options.name })
      : options.all === true
        ? mates.items
        : [];
  const results: MateStopResult[] = [];
  for (const item of targets) {
    const resolved = resolveMate(config, mates, item);
    const existing = await findExistingMatePane(resolved.session, resolved.workspace, item.name);
    if (existing === undefined) {
      results.push({ name: item.name, parent: item.parent, action: "not-running" });
      continue;
    }
    await runHerdr(resolved.session, ["pane", "close", existing.paneId]);
    results.push({
      name: item.name,
      parent: item.parent,
      action: "stopped",
      paneId: existing.paneId,
    });
  }
  return results;
}
