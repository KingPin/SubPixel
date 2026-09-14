import { ConfigError } from "../core/errors.js";
import type { BackendName, ImageBackground, ImageFormat, ImageQuality } from "../core/types.js";

/**
 * One named style.
 *
 * The descriptive field names are taken from OpenAI's own imagegen skill —
 * subject, scene, style, composition, lighting, palette, materials, text,
 * constraints, negative — because that is the structure the backend was tuned on.
 * The four generation fields at the end are defaults the style implies; a CLI flag
 * still beats them.
 */
export interface StyleDefinition {
  subject?: string;
  scene?: string;
  style?: string;
  composition?: string;
  lighting?: string;
  palette?: string;
  materials?: string;
  text?: string;
  constraints?: string;
  negative?: string;
  modifiers?: string;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  format?: ImageFormat;
}

export const STYLE_TEXT_FIELDS = [
  "subject",
  "scene",
  "style",
  "composition",
  "lighting",
  "palette",
  "materials",
  "text",
  "constraints",
  "modifiers",
  "negative",
] as const;

export interface SubpixelConfig {
  outDir?: string;
  format?: ImageFormat;
  /** The style applied when `--style` is absent. */
  style?: string;
  backend?: BackendName | "auto";
  allowPaid?: boolean;
  concurrency?: number;
  budget?: { maxImagesPerRun?: number };
  styles?: Record<string, StyleDefinition>;
}

const CONFIG_KEYS = [
  "outDir",
  "format",
  "style",
  "backend",
  "allowPaid",
  "concurrency",
  "budget",
  "styles",
] as const;

const FORMATS: ImageFormat[] = ["png", "jpeg", "webp"];
const QUALITIES: ImageQuality[] = ["low", "medium", "high", "auto"];
const BACKGROUNDS: ImageBackground[] = ["transparent", "opaque", "auto"];
const BACKENDS = ["codex-http", "codex-exec", "api", "auto"];

function fail(source: string, key: string, expected: string, received: unknown): never {
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

function validateStyle(value: unknown, source: string, name: string): StyleDefinition {
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
  if (input.size !== undefined) style.size = asString(input.size, source, `styles.${name}.size`);
  if (input.quality !== undefined) {
    style.quality = asEnum(input.quality, QUALITIES, source, `styles.${name}.quality`);
  }
  if (input.background !== undefined) {
    style.background = asEnum(input.background, BACKGROUNDS, source, `styles.${name}.background`);
  }
  if (input.format !== undefined) {
    style.format = asEnum(input.format, FORMATS, source, `styles.${name}.format`);
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
      warn(`${source}: unknown key "${key}" ignored.`);
    }
  }

  if (input.outDir !== undefined) config.outDir = asString(input.outDir, source, "outDir");
  if (input.style !== undefined) config.style = asString(input.style, source, "style");
  if (input.format !== undefined) config.format = asEnum(input.format, FORMATS, source, "format");
  if (input.backend !== undefined) {
    config.backend = asEnum(input.backend, BACKENDS, source, "backend") as BackendName | "auto";
  }
  if (input.allowPaid !== undefined) {
    if (typeof input.allowPaid !== "boolean") fail(source, "allowPaid", "a boolean", input.allowPaid);
    config.allowPaid = input.allowPaid;
  }
  if (input.concurrency !== undefined) {
    config.concurrency = asPositiveInt(input.concurrency, source, "concurrency");
  }
  if (input.budget !== undefined) {
    const budget = input.budget;
    if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
      fail(source, "budget", "an object", budget);
    }
    const max = (budget as Record<string, unknown>).maxImagesPerRun;
    config.budget =
      max === undefined ? {} : { maxImagesPerRun: asPositiveInt(max, source, "budget.maxImagesPerRun") };
  }
  if (input.styles !== undefined) {
    const styles = input.styles;
    if (typeof styles !== "object" || styles === null || Array.isArray(styles)) {
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
