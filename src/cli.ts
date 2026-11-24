#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { board } from "@vercel/board";
import { loadConfig } from "./config.ts";
import { runLoop } from "./runner/loop.ts";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../fleet.example.yaml", import.meta.url));

const HELP = `fleet - thin multi-machine execution runner on @vercel/board

Usage:
  fleet init                   Copy fleet.example.yaml to ./fleet.yaml
  fleet run [options]          Claim and run ready tasks labeled host=<config.host>

Options:
  --config <path>              Path to fleet.yaml (default: $FLEET_CONFIG or ./fleet.yaml)
  --once                       Claim and run at most one ready task, then exit
  -h, --help                   Show this help
`;

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command] = parsed.positionals;
  if (parsed.values.help || command === undefined) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "init") {
    const target = resolve(process.cwd(), "fleet.yaml");
    if (existsSync(target)) {
      throw new Error(`${target} already exists`);
    }
    copyFileSync(EXAMPLE_CONFIG, target);
    process.stdout.write(`Created ${target}\n`);
    return;
  }

  if (command !== "run") {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }

  const config = loadConfig(parsed.values.config);
  const client = board(config.boardUrl !== undefined ? { url: config.boardUrl } : {}).as(
    `runner-${config.host}`,
  );

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await runLoop(client, config, { once: parsed.values.once, signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
