import { AxiError } from "axi-sdk-js";

export interface FlagSpec {
  readonly type: "string" | "boolean";
  readonly required?: boolean;
  readonly short?: string;
}

export interface ParsedFlags {
  readonly positionals: string[];
  readonly values: Record<string, string | boolean | undefined>;
}

const UNIVERSAL_FLAGS = new Set(["--help", "-h"]);

function formatValidFlags(specs: Record<string, FlagSpec>): string {
  const names = Object.keys(specs).map((name) => `--${name}`);
  return names.length === 0
    ? "(--help always allowed)"
    : `${names.join(", ")} (--help always allowed)`;
}

function findFlagName(
  token: string,
  specs: Record<string, FlagSpec>,
): { readonly name: string; readonly inlineValue?: string } | undefined {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    const raw = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (Object.hasOwn(specs, raw)) {
      return eq === -1 ? { name: raw } : { name: raw, inlineValue: token.slice(eq + 1) };
    }
    return undefined;
  }
  if (token.startsWith("-") && token.length === 2) {
    const short = token.slice(1);
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.short === short) return { name };
    }
  }
  return undefined;
}

export function parseStrictFlags(
  command: string,
  args: readonly string[],
  specs: Record<string, FlagSpec>,
  helpBlock: string,
): ParsedFlags {
  const positionals: string[] = [];
  const values: Record<string, string | boolean | undefined> = {};
  const validLine = `valid flags for \`${command}\`: ${formatValidFlags(specs)}`;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (UNIVERSAL_FLAGS.has(token)) {
      values["help"] = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const match = findFlagName(token, specs);
    if (match === undefined) {
      throw new AxiError(`unknown flag ${token} for \`${command}\``, "VALIDATION_ERROR", [
        validLine,
        helpBlock,
      ]);
    }
    const spec = specs[match.name];
    if (spec === undefined) continue;
    if (spec.type === "boolean") {
      if (match.inlineValue !== undefined) {
        throw new AxiError(`flag --${match.name} does not take a value`, "VALIDATION_ERROR", [
          validLine,
          helpBlock,
        ]);
      }
      values[match.name] = true;
      continue;
    }
    const nextValue = match.inlineValue ?? args[++i];
    if (nextValue === undefined || (match.inlineValue === undefined && nextValue.startsWith("-"))) {
      throw new AxiError(`flag --${match.name} requires a value`, "VALIDATION_ERROR", [
        validLine,
        helpBlock,
      ]);
    }
    values[match.name] = nextValue;
  }

  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required === true && values[name] === undefined) {
      throw new AxiError(`--${name} is required for \`${command}\``, "VALIDATION_ERROR", [
        helpBlock,
      ]);
    }
  }

  return { positionals, values };
}

export function stringFlag(
  values: Record<string, string | boolean | undefined>,
  name: string,
): string | undefined {
  const val = values[name];
  return typeof val === "string" ? val : undefined;
}

export function boolFlag(
  values: Record<string, string | boolean | undefined>,
  name: string,
): boolean {
  return values[name] === true;
}
