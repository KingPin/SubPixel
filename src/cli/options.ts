import { ConfigError } from "../core/errors.js";
import type { BackendName } from "../core/types.js";

export const KNOWN_COMMANDS = ["generate", "doctor", "models", "styles", "edit", "icons", "sync", "help"] as const;

const BACKENDS: BackendName[] = ["codex-http", "codex-exec", "api"];

/**
 * Allow `spx "a red fox"` as shorthand for `spx generate "a red fox"`.
 *
 * Commander has no first-class "default command" that coexists with named ones,
 * so the rewrite happens here, before parsing. A first argument that starts with
 * a dash is left alone so --help and --version keep working.
 */
export function normalizeArgv(argv: string[]): string[] {
  const first = argv[2];
  if (first === undefined) return argv;
  if (first.startsWith("-")) return argv;
  if ((KNOWN_COMMANDS as readonly string[]).includes(first)) return argv;
  return [...argv.slice(0, 2), "generate", ...argv.slice(2)];
}

/**
 * "auto" is the resolver, which is what an absent --backend already means, so it
 * maps to undefined rather than becoming a fourth BackendName the resolver would
 * have to special-case.
 */
export function parseBackend(value: string | undefined): BackendName | undefined {
  if (value === undefined || value === "auto") return undefined;
  if ((BACKENDS as string[]).includes(value)) return value as BackendName;
  throw new ConfigError(
    `Unknown backend "${value}". Valid values: ${[...BACKENDS, "auto"].join(", ")}.`,
  );
}

export function parseSeconds(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ConfigError(`${flag} needs a positive number of seconds, received "${value}".`);
  }
  return Math.round(seconds * 1000);
}

export function parseCount(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new ConfigError(`${flag} needs a positive whole number, received "${value}".`);
  }
  return count;
}
