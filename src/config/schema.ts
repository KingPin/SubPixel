import { ConfigError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import type {
  BackendName,
  ImageBackground,
  ImageFormat,
  ImageQuality,
} from "../core/types.js";
import type { StyleDefinition } from "../core/types.js";
import {
  BACKEND_NAMES,
  IMAGE_BACKGROUNDS,
  IMAGE_FORMATS,
  IMAGE_QUALITIES,
  STYLE_TEXT_FIELDS,
} from "../core/types.js";

// Re-exported from their new home in core so config consumers do not all have to
// move. The engine composes styles and must not import the config layer, so the
// type itself lives in core/types.ts where both layers already depend on it.
export type { StyleDefinition } from "../core/types.js";
export { STYLE_TEXT_FIELDS } from "../core/types.js";

export interface SubpixelConfig {
  outDir?: string;
  format?: ImageFormat;
  /** The style applied when `--style` is absent. */
  style?: string;
  backend?: BackendName | "auto";
  concurrency?: number;
  budget?: { maxImagesPerRun?: number };
  /**
   * Settings for the MCP server.
   *
   * `cutoverMs` is how long a generating tool call waits before it stops holding the
   * host's request open and hands back a `job_id` instead. Hosts disagree about how
   * long a tool may take, so the number has to be tunable per project. Overridden by
   * `SUBPIXEL_MCP_CUTOVER_MS`.
   */
  mcp?: { cutoverMs?: number };
  styles?: Record<string, StyleDefinition>;
}

const CONFIG_KEYS = [
  "outDir",
  "format",
  "style",
  "backend",
  "concurrency",
  "budget",
  "mcp",
  "styles",
] as const;

// From core, not copied. A value added there but not here is one Commander, the MCP
// schema, and the manifest validator accept and project config rejects — which is
// exactly the drift the single declaration was made to stop.
const FORMATS = IMAGE_FORMATS;
const QUALITIES = IMAGE_QUALITIES;
const BACKGROUNDS = IMAGE_BACKGROUNDS;
// "auto" is a config-only value: it means "pick one", which is not something a
// resolved request or a sidecar can hold.
const BACKENDS = [...BACKEND_NAMES, "auto"] as const;

function fail(
  source: string,
  key: string,
  expected: string,
  received: unknown,
): never {
  throw new ConfigError(
    `${source}: "${key}" must be ${expected}, received ${JSON.stringify(received)}.`,
  );
}

function asString(value: unknown, source: string, key: string): string {
  if (typeof value !== "string") fail(source, key, "a string", value);
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  key: string,
): T {
  const text = asString(value, source, key);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(source, key, `one of ${allowed.join(", ")}`, value);
  }
  return text as T;
}

function asPositiveInt(value: unknown, source: string, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(source, key, "a positive whole number", value);
  }
  return value;
}

export function validateStyle(
  value: unknown,
  source: string,
  name: string,
): StyleDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(source, `styles.${name}`, "an object", value);
  }
  const input = value as Record<string, unknown>;
  const style: StyleDefinition = {};

  for (const field of STYLE_TEXT_FIELDS) {
    const raw = input[field];
    if (raw === undefined) continue;
    style[field] = asString(raw, source, `styles.${name}.${field}`);
  }
  if (input.size !== undefined)
    style.size = asString(input.size, source, `styles.${name}.size`);
  if (input.quality !== undefined) {
    style.quality = asEnum(
      input.quality,
      QUALITIES,
      source,
      `styles.${name}.quality`,
    );
  }
  if (input.background !== undefined) {
    style.background = asEnum(
      input.background,
      BACKGROUNDS,
      source,
      `styles.${name}.background`,
    );
  }
  if (input.format !== undefined) {
    style.format = asEnum(
      input.format,
      FORMATS,
      source,
      `styles.${name}.format`,
    );
  }
  return style;
}

/**
 * Turn parsed JSON into a `SubpixelConfig`, or explain exactly what is wrong.
 *
 * An unknown key WARNS rather than throws. A config file outlives the version of
 * subpixel that reads it: someone on a newer release adds a key, a colleague on an
 * older one runs the same repository, and failing there would break a working
 * project over a field it does not need. A wrong TYPE on a known key still throws,
 * because that is a mistake rather than a version skew.
 */
export function validateConfig(
  value: unknown,
  source: string,
  warn: (message: string) => void = () => {},
): SubpixelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${source}: the config must be a JSON object.`);
  }
  const input = value as Record<string, unknown>;
  const config: SubpixelConfig = {};

  for (const key of Object.keys(input)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      warn(redact(`${source}: unknown key "${key}" ignored.`));
    }
  }

  if (input.outDir !== undefined)
    config.outDir = asString(input.outDir, source, "outDir");
  if (input.style !== undefined)
    config.style = asString(input.style, source, "style");
  if (input.format !== undefined)
    config.format = asEnum(input.format, FORMATS, source, "format");
  if (input.backend !== undefined) {
    config.backend = asEnum(input.backend, BACKENDS, source, "backend") as
      | BackendName
      | "auto";
  }
  if (input.concurrency !== undefined) {
    config.concurrency = asPositiveInt(
      input.concurrency,
      source,
      "concurrency",
    );
  }
  if (input.budget !== undefined) {
    const budget = input.budget;
    if (
      typeof budget !== "object" ||
      budget === null ||
      Array.isArray(budget)
    ) {
      fail(source, "budget", "an object", budget);
    }
    const max = (budget as Record<string, unknown>).maxImagesPerRun;
    config.budget =
      max === undefined
        ? {}
        : {
            maxImagesPerRun: asPositiveInt(
              max,
              source,
              "budget.maxImagesPerRun",
            ),
          };
  }
  if (input.mcp !== undefined) {
    const mcp = input.mcp;
    if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
      fail(source, "mcp", "an object", mcp);
    }
    const cutover = (mcp as Record<string, unknown>).cutoverMs;
    config.mcp =
      cutover === undefined
        ? {}
        : { cutoverMs: asPositiveInt(cutover, source, "mcp.cutoverMs") };
  }
  if (input.styles !== undefined) {
    const styles = input.styles;
    if (
      typeof styles !== "object" ||
      styles === null ||
      Array.isArray(styles)
    ) {
      fail(source, "styles", "an object", styles);
    }
    config.styles = Object.fromEntries(
      Object.entries(styles as Record<string, unknown>).map(([name, style]) => [
        name,
        validateStyle(style, source, name),
      ]),
    );
  }

  return config;
}
