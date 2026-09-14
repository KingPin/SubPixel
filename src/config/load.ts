import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { ConfigError } from "../core/errors.js";
import { validateConfig, type SubpixelConfig } from "./schema.js";

export const CONFIG_FILENAME = "subpixel.config.json";

export interface LoadConfigOptions {
  /** Where to start walking up from. Defaults to the process working directory. */
  cwd?: string;
  /**
   * The highest directory the walk may inspect, inclusive. Defaults to the
   * filesystem root. Tests set it so a stray config in a parent of the temp
   * directory cannot make them pass or fail for the wrong reason.
   */
  stopAt?: string;
  warn?: (message: string) => void;
}

export interface LoadedConfig {
  config: SubpixelConfig;
  /** The file the config came from. Absent when no config exists. */
  path?: string;
  /** The directory relative paths in the config resolve against. */
  dir: string;
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/**
 * Walk up looking for a config, nearest first.
 *
 * `subpixel.config.json` wins over a `package.json` key IN THE SAME DIRECTORY,
 * because a dedicated file is a deliberate statement and a package key is often
 * inherited. A `package.json` without a `subpixel` key is not a config and does not
 * stop the walk — a monorepo package almost always has one.
 */
export async function findConfigFile(
  cwd: string,
  stopAt: string = parse(resolve(cwd)).root,
): Promise<{ path: string; value: unknown } | undefined> {
  let dir = resolve(cwd);
  const ceiling = resolve(stopAt);
  for (;;) {
    const direct = join(dir, CONFIG_FILENAME);
    const value = await readJson(direct);
    if (value !== undefined) return { path: direct, value };

    const packagePath = join(dir, "package.json");
    const pkg = await readJson(packagePath);
    if (typeof pkg === "object" && pkg !== null && "subpixel" in pkg) {
      return { path: packagePath, value: (pkg as { subpixel: unknown }).subpixel };
    }

    if (dir === ceiling) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const found = await findConfigFile(cwd, options.stopAt);
  if (!found) return { config: {}, dir: cwd };

  const dir = dirname(found.path);
  const config = validateConfig(found.value, found.path, options.warn);

  // Relative paths belong to the file that wrote them. A developer in
  // packages/site who runs `spx` expects the repository's `public/images`, not
  // `packages/site/public/images` — the config is the project's, not the shell's.
  if (config.outDir && !isAbsolute(config.outDir)) {
    config.outDir = resolve(dir, config.outDir);
  }

  return { config, path: found.path, dir };
}
