import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createHttpBoardClient } from "./board/client.ts";
import { MateNameSchema } from "./board/types.ts";
import {
  loadFleetConfig,
  type FleetConfig,
  type MateItemConfig,
  type MatesConfig,
} from "./config.ts";
import { runHerdr, shellQuoteSingle } from "./runner/herdr.ts";

const DEFAULT_MATE_PROMPT = fileURLToPath(new URL("../prompts/mate.md", import.meta.url));
const DEFAULT_PI_ADAPTER = fileURLToPath(new URL("adapters/pi.ts", import.meta.url));
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5000;

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
  readonly mcpConfigPath: string;
  readonly usesMcpConfig: boolean;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface ExistingPane {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly duplicateTabIds: readonly string[];
}

export interface MateStatus {
  readonly name: string;
  readonly parent: string;
  readonly mode: "local" | "external";
  readonly workspace: string;
  readonly cwd: string;
  readonly autoStart: boolean;
  readonly status: "running" | "idle-shell" | "stopped" | "external";
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

export interface MateChatResult {
  readonly kind: "local" | "external";
  readonly mate: string;
  readonly exitCode: number;
}

interface DoctorCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly configPath?: string;
  readonly boardUrl: string;
  readonly mate?: string;
  readonly checks: readonly DoctorCheck[];
}

function interpolate(template: string, vars: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

function resolveMate(config: FleetConfig, mates: MatesConfig, item: MateItemConfig): ResolvedMate {
  const stateDir = join(mates.stateDir, item.name);
  const cwd = item.cwd ?? stateDir;
  const promptPath = item.promptPath ?? mates.promptPath ?? DEFAULT_MATE_PROMPT;
  const mcpConfigPath = join(stateDir, "mcp.json");
  const workspace = item.workspace ?? mates.workspace ?? item.name;
  const vars: Record<string, string> = {
    name: item.name,
    prompt: promptPath,
    adapter: DEFAULT_PI_ADAPTER,
    mcpConfig: mcpConfigPath,
    cwd,
    stateDir,
  };
  const commandTemplate = item.command ?? mates.command;
  const usesMcpConfig = commandTemplate.some((token) => token.includes("{mcpConfig}"));
  const argv = commandTemplate.map((token) => interpolate(token, vars));
  const mergedEnv: Record<string, string> = {
    FLEET_MATE: item.name,
    BOARD_URL: config.boardUrl,
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
    mcpConfigPath,
    usesMcpConfig,
    argv,
    env: mergedEnv,
  };
}

function writeAtomicJson(path: string, payload: unknown): void {
  const tempPath = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function ensureMateRuntimeFiles(mate: ResolvedMate): void {
  mkdirSync(mate.stateDir, { recursive: true });
  mkdirSync(mate.cwd, { recursive: true });
  if (mate.usesMcpConfig) {
    writeAtomicJson(mate.mcpConfigPath, {
      mcpServers: {
        fleet: {
          command: "fleet",
          args: ["channel", "--mate", mate.item.name],
        },
      },
    });
  }
}

function isExecutableFile(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(bin: string): string | undefined {
  if (bin.length === 0) return undefined;
  if (bin.includes("/")) {
    return isExecutableFile(bin) ? bin : undefined;
  }
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function resolvePrimaryMateName(config: FleetConfig, explicit?: string): string {
  if (explicit !== undefined) {
    return MateNameSchema.parse(explicit);
  }
  const items = config.mates?.items ?? [];
  const topLevel = items.filter((entry) => entry.parent === "captain");
  if (topLevel.length === 1 && topLevel[0] !== undefined) {
    return topLevel[0].name;
  }
  const defaultNamed = topLevel.find((entry) => entry.name === "1stmate");
  if (defaultNamed !== undefined) return defaultNamed.name;
  if (topLevel.length > 1) {
    const names = topLevel.map((entry) => entry.name).join(", ");
    throw new Error(`Multiple top-level mates configured (${names}). Pass a mate name explicitly.`);
  }
  throw new Error(
    "No top-level mate (parent: captain) is configured in fleet.yaml. Pass a mate name or add one under mates.items.",
  );
}

function requireMates(config: FleetConfig): MatesConfig {
  if (config.mates === undefined) {
    return {
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

  const tabs = TabListSchema.parse(JSON.parse(tabsRaw)).result.tabs.filter(
    (entry) => entry.label === mateName,
  );
  const panes = PaneListSchema.parse(JSON.parse(panesRaw)).result.panes;
  const candidates = tabs.flatMap((tab) => {
    const pane = panes.find((entry) => entry.tab_id === tab.tab_id);
    return pane === undefined ? [] : [{ tab, pane }];
  });
  let chosen = candidates[0];
  for (const candidate of candidates) {
    if (await isPaneRunningCommand(session, candidate.pane.pane_id)) {
      chosen = candidate;
      break;
    }
  }
  if (chosen === undefined) return undefined;

  return {
    workspaceId: ws.workspace_id,
    tabId: chosen.tab.tab_id,
    paneId: chosen.pane.pane_id,
    duplicateTabIds: candidates
      .filter((candidate) => candidate !== chosen)
      .map((candidate) => candidate.tab.tab_id),
  };
}

async function closeDuplicateTabs(session: string | undefined, pane: ExistingPane): Promise<void> {
  for (const tabId of pane.duplicateTabIds) {
    await runHerdr(session, ["tab", "close", tabId]).catch(() => undefined);
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
      duplicateTabIds: [],
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
    duplicateTabIds: [],
  };
}

async function launchMateInPane(mate: ResolvedMate, pane: ExistingPane): Promise<void> {
  ensureMateRuntimeFiles(mate);
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

export async function listMates(config: FleetConfig): Promise<MateStatus[]> {
  const mates = requireMates(config);
  const results: MateStatus[] = [];
  for (const item of mates.items) {
    const resolved = resolveMate(config, mates, item);
    if (item.mode === "external") {
      results.push({
        name: item.name,
        parent: item.parent,
        mode: item.mode,
        workspace: resolved.workspace,
        cwd: resolved.cwd,
        autoStart: item.autoStart,
        status: "external",
      });
      continue;
    }
    const pane = await findExistingMatePane(resolved.session, resolved.workspace, item.name);
    if (pane === undefined) {
      results.push({
        name: item.name,
        parent: item.parent,
        mode: item.mode,
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
      mode: item.mode,
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
  config: FleetConfig,
  options: { readonly name?: string; readonly all?: boolean } = {},
): Promise<MateActionResult[]> {
  const mates = requireMates(config);
  const selected = selectMates(mates, options);
  const targets: MateItemConfig[] = [];
  for (const item of selected) {
    if (item.mode === "external") {
      if (options.name !== undefined) {
        throw new Error(
          `Mate "${item.name}" has mode "external" and is not managed as a Herdr pane. Wire wakes with \`fleet watch --mate ${item.name} --webhook <url>\`.`,
        );
      }
      continue;
    }
    targets.push(item);
  }
  const results: MateActionResult[] = [];
  for (const item of targets) {
    const resolved = resolveMate(config, mates, item);
    ensureMateRuntimeFiles(resolved);
    const existing = await findExistingMatePane(resolved.session, resolved.workspace, item.name);
    if (existing !== undefined) {
      await closeDuplicateTabs(resolved.session, existing);
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
  config: FleetConfig,
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
    await closeDuplicateTabs(resolved.session, existing);
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

function hasFlagToken(argv: readonly string[], flag: string): boolean {
  const prefix = `${flag}=`;
  return argv.some((token) => token === flag || token.startsWith(prefix));
}

function diagnoseLocalHarness(resolved: ResolvedMate): DoctorCheck {
  const bin = resolved.argv[0] ?? "";
  const resolvedBin = findExecutable(bin);
  if (resolvedBin === undefined) {
    return {
      name: "harness",
      status: "fail",
      detail: `Executable "${bin}" was not found on PATH for mate "${resolved.item.name}"`,
      fix: `Install "${bin}" or update mates.command / mates.items[].command in fleet.yaml`,
    };
  }
  if (!existsSync(resolved.promptPath)) {
    return {
      name: "harness",
      status: "fail",
      detail: `Prompt file not found at ${resolved.promptPath}`,
      fix: "Set promptPath to an existing Markdown prompt file or omit it to use prompts/mate.md",
    };
  }
  const binName = basename(bin);
  if (binName === "claude" || binName === "claude-code") {
    if (!hasFlagToken(resolved.argv, "--dangerously-load-development-channels")) {
      return {
        name: "harness",
        status: "fail",
        detail: `Claude Code command for "${resolved.item.name}" is missing --dangerously-load-development-channels (channel wakes will be silently dropped)`,
        fix: 'Add "--mcp-config", "{mcpConfig}", "--dangerously-load-development-channels", "server:fleet" to this mate command in fleet.yaml',
      };
    }
    if (!hasFlagToken(resolved.argv, "--mcp-config")) {
      return {
        name: "harness",
        status: "fail",
        detail: `Claude Code command for "${resolved.item.name}" is missing --mcp-config {mcpConfig}`,
        fix: 'Add "--mcp-config", "{mcpConfig}" to this mate command in fleet.yaml so Fleet writes mcp.json automatically',
      };
    }
  } else if (
    (binName === "pi" || binName === "ypi") &&
    !hasFlagToken(resolved.argv, "-e") &&
    !hasFlagToken(resolved.argv, "--extension")
  ) {
    return {
      name: "harness",
      status: "warn",
      detail: `Pi command for "${resolved.item.name}" does not pass -e {adapter}`,
      fix: 'Add "-e", "{adapter}" to mates.command so Fleet injects the Pi adapter at launch',
    };
  }
  return {
    name: "harness",
    status: "ok",
    detail: `local harness "${bin}" (${resolvedBin}) in ${resolved.cwd}`,
  };
}

function buildMateProcessEnv(mateEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...mateEnv };
  Reflect.deleteProperty(env, "FLEET_CLAIM_TOKEN");
  Reflect.deleteProperty(env, "FLEET_CLAIM_EPOCH");
  return env;
}

const ignoreSigint = (): undefined => undefined;

function spawnInteractiveMate(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    return Promise.reject(new Error("Mate command is empty"));
  }
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    const forwardSigterm = (): void => {
      child.kill("SIGTERM");
    };
    const cleanup = (): void => {
      process.removeListener("SIGINT", ignoreSigint);
      process.removeListener("SIGTERM", forwardSigterm);
    };
    process.on("SIGINT", ignoreSigint);
    process.on("SIGTERM", forwardSigterm);

    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal !== null) {
        resolve(128);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function runMateChat(options: {
  readonly config: FleetConfig;
  readonly mate?: string;
  readonly extraArgs?: readonly string[];
  readonly stdout?: { write: (chunk: string) => unknown };
  readonly stderr?: { write: (chunk: string) => unknown };
  readonly healthTimeoutMs?: number;
}): Promise<MateChatResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const mates = requireMates(options.config);
  const mateName = resolvePrimaryMateName(options.config, options.mate);
  const [item] = selectMates(mates, { name: mateName });
  if (item === undefined) {
    throw new Error(`Unknown mate "${mateName}"`);
  }

  const client = createHttpBoardClient(options.config.boardUrl);
  try {
    await client.latestEventId(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Card Server is unreachable at ${options.config.boardUrl} (${detail}). Start it with \`fleet serve\` before launching ${item.name}.`,
      { cause: error },
    );
  }

  const charter = await client
    .getCharter(item.name, AbortSignal.timeout(timeoutMs))
    .catch(() => "");
  if (charter.trim().length === 0) {
    stderr.write(
      `Warning: no charter is set for ${item.name}. Run \`fleet charter ${item.name} --set "<autonomy rules>"\`.\n`,
    );
  }

  if (item.mode === "external") {
    const heldCount = await client
      .listCards(
        { holder: item.name, state: "open", scope: item.name },
        AbortSignal.timeout(timeoutMs),
      )
      .then((page) => page.cards.length)
      .catch(() => 0);
    const lines = [
      `${item.name} is configured as an external mate (mode: external) and does not launch a local terminal session.`,
      `Board: ${options.config.boardUrl} (open cards held by ${item.name}: ${String(heldCount)})`,
      `Wire wakes with: fleet watch --mate ${item.name} --webhook <url>`,
      `Inspect cards with: fleet cards --mate ${item.name}`,
    ].join("\n");
    stdout.write(`${lines}\n`);
    return { kind: "external", mate: item.name, exitCode: 0 };
  }

  const resolved = resolveMate(options.config, mates, item);
  const harnessCheck = diagnoseLocalHarness(resolved);
  if (harnessCheck.status === "fail") {
    throw new Error(
      harnessCheck.fix === undefined
        ? harnessCheck.detail
        : `${harnessCheck.detail}. ${harnessCheck.fix}`,
    );
  }
  if (harnessCheck.status === "warn") {
    stderr.write(
      `Warning: ${harnessCheck.detail}.${harnessCheck.fix === undefined ? "" : ` ${harnessCheck.fix}`}\n`,
    );
  }

  ensureMateRuntimeFiles(resolved);
  const argv = [...resolved.argv, ...(options.extraArgs ?? [])];
  const exitCode = await spawnInteractiveMate(
    argv,
    resolved.cwd,
    buildMateProcessEnv(resolved.env),
  );
  return { kind: "local", mate: item.name, exitCode };
}

function diagnoseConfigFile(configPath: string | undefined): {
  readonly config?: FleetConfig;
  readonly check: DoctorCheck;
} {
  if (configPath === undefined) {
    return {
      check: {
        name: "config",
        status: "fail",
        detail:
          "No fleet.yaml found in FLEET_CONFIG, ./fleet.yaml, ~/.fleet/fleet.yaml, or ~/.config/fleet/fleet.yaml",
        fix: "Run `fleet init --config ~/.fleet/fleet.yaml` and configure your mates",
      },
    };
  }
  try {
    return {
      config: loadFleetConfig(configPath),
      check: {
        name: "config",
        status: "ok",
        detail: `Loaded ${configPath}`,
      },
    };
  } catch (error) {
    return {
      check: {
        name: "config",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: `Fix invalid YAML or schema errors in ${configPath}`,
      },
    };
  }
}

function diagnoseMateConfig(
  config: FleetConfig,
  configPath: string | undefined,
  explicitMate: string | undefined,
): {
  readonly matesConfig: MatesConfig;
  readonly mateName?: string;
  readonly mateItem?: MateItemConfig;
  readonly check: DoctorCheck;
} {
  const matesConfig = requireMates(config);
  try {
    const mateName = resolvePrimaryMateName(config, explicitMate);
    const found = matesConfig.items.find((entry) => entry.name === mateName);
    if (found === undefined) {
      const known = matesConfig.items.map((entry) => entry.name).join(", ") || "(none)";
      return {
        matesConfig,
        mateName,
        check: {
          name: "mate",
          status: "fail",
          detail: `Mate "${mateName}" is not configured in mates.items (configured: ${known})`,
          fix: `Add "${mateName}" under mates.items in ${configPath ?? "fleet.yaml"}`,
        },
      };
    }
    return {
      matesConfig,
      mateName,
      mateItem: found,
      check: {
        name: "mate",
        status: "ok",
        detail: `${found.name} (parent: ${found.parent}, mode: ${found.mode})`,
      },
    };
  } catch (error) {
    return {
      matesConfig,
      ...(explicitMate !== undefined ? { mateName: explicitMate } : {}),
      check: {
        name: "mate",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Pass --mate <name> or configure one top-level mate with parent: captain in fleet.yaml",
      },
    };
  }
}

async function diagnoseBoardAndCharter(
  boardUrl: string,
  mateName: string | undefined,
  timeoutMs: number,
): Promise<readonly DoctorCheck[]> {
  const client = createHttpBoardClient(boardUrl);
  const checks: DoctorCheck[] = [];
  try {
    const latestEventId = await client.latestEventId(AbortSignal.timeout(timeoutMs));
    checks.push({
      name: "board",
      status: "ok",
      detail: `Card Server reachable at ${boardUrl} (latestEventId: ${String(latestEventId)})`,
    });
  } catch (error) {
    checks.push({
      name: "board",
      status: "fail",
      detail: `Card Server unreachable at ${boardUrl} (${error instanceof Error ? error.message : String(error)})`,
      fix: "Start the Card Server with `fleet serve` or check BOARD_URL / SSH tunnel",
    });
    return checks;
  }

  if (mateName === undefined) return checks;
  try {
    const charter = await client.getCharter(mateName, AbortSignal.timeout(timeoutMs));
    if (charter.trim().length === 0) {
      checks.push({
        name: "charter",
        status: "warn",
        detail: `No charter set for ${mateName}`,
        fix: `Run \`fleet charter ${mateName} --set "<autonomy rules>"\``,
      });
    } else {
      checks.push({
        name: "charter",
        status: "ok",
        detail: `Charter loaded for ${mateName} (${String(charter.trim().length)} chars)`,
      });
    }
  } catch (error) {
    checks.push({
      name: "charter",
      status: "fail",
      detail: `Failed to read charter for ${mateName} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
  return checks;
}

export async function diagnoseMate(options: {
  readonly configPath?: string;
  readonly boardUrlOverride?: string;
  readonly mate?: string;
  readonly healthTimeoutMs?: number;
}): Promise<DoctorReport> {
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const checks: DoctorCheck[] = [];
  const cfgDiag = diagnoseConfigFile(options.configPath);
  checks.push(cfgDiag.check);

  const boardUrl =
    options.boardUrlOverride ??
    cfgDiag.config?.boardUrl ??
    process.env["BOARD_URL"] ??
    "http://127.0.0.1:4100";

  let resolvedMateName: string | undefined = options.mate;
  let mateItem: MateItemConfig | undefined;
  let matesConfig: MatesConfig | undefined;

  if (cfgDiag.config !== undefined) {
    const mateDiag = diagnoseMateConfig(cfgDiag.config, options.configPath, options.mate);
    checks.push(mateDiag.check);
    matesConfig = mateDiag.matesConfig;
    resolvedMateName = mateDiag.mateName;
    mateItem = mateDiag.mateItem;
  }

  checks.push(...(await diagnoseBoardAndCharter(boardUrl, resolvedMateName, timeoutMs)));

  if (cfgDiag.config !== undefined && matesConfig !== undefined && mateItem !== undefined) {
    checks.push(
      mateItem.mode === "external"
        ? {
            name: "harness",
            status: "ok",
            detail: `external mate "${mateItem.name}" (wire wakes with \`fleet watch --mate ${mateItem.name} --webhook <url>\`)`,
          }
        : diagnoseLocalHarness(resolveMate(cfgDiag.config, matesConfig, mateItem)),
    );
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    boardUrl,
    ...(resolvedMateName !== undefined ? { mate: resolvedMateName } : {}),
    checks,
  };
}
