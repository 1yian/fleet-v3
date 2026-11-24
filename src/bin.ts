#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "./version.ts";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("./cli.ts");
  await main();
}
