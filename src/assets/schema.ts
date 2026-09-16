import { ConfigError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import { validateStyle } from "../config/schema.js";
import { parseSize } from "../engine/prompt.js";
import { isSafeVariantSuffix } from "../engine/variants.js";
import { IMAGE_FORMATS, IMAGE_QUALITIES } from "../core/types.js";
import type {
  ImageFormat,
  ImageQuality,
  StyleDefinition,
} from "../core/types.js";

/**
 * The names the spec allows for `size`.
 *
 * A manifest is read by people, and `landscape` says what the author meant in a way
 * `1536x1024` does not. The literal form still works for anything these three do
 * not cover.
 */
export const NAMED_SIZES = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
} as const;

export interface VariantSpec {
  width: number;
  /** Overrides the derived `-<width>w` name. */
  suffix?: string;
}

export interface AssetSpec {
  id: string;
  prompt: string;
  /** The output path, as written. Resolved against the manifest in `load.ts`. */
  out?: string;
  size?: string;
  quality?: ImageQuality;
  format?: ImageFormat;
  style?: string;
  transparent?: boolean;
  exactSize?: string;
  references?: string[];
  variants?: VariantSpec[];
}

export interface AssetDefaults {
  outDir?: string;
  size?: string;
  quality?: ImageQuality;
  format?: ImageFormat;
  style?: string;
}

export interface AssetsFile {
  defaults: AssetDefaults;
  styles: Record<string, StyleDefinition>;
  assets: AssetSpec[];
}

const ASSET_KEYS = [
  "id",
  "prompt",
  "out",
  "size",
  "quality",
  "format",
  "style",
  "transparent",
  "exactSize",
  "references",
  "variants",
] as const;

// From core, not copied. See the note in config/schema.ts.
const FORMATS = IMAGE_FORMATS;
const QUALITIES = IMAGE_QUALITIES;

function fail(
  source: string,
  where: string,
  expected: string,
  received: unknown,
): never {
  throw new ConfigError(
    `${source}: ${where} must be ${expected}, received ${JSON.stringify(received)}.`,
  );
}

function asString(value: unknown, source: string, where: string): string {
  if (typeof value !== "string") fail(source, where, "a string", value);
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  where: string,
): T {
  const text = asString(value, source, where);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(source, where, `one of ${allowed.join(", ")}`, value);
  }
  return text as T;
}

function resolveSize(value: unknown, source: string, where: string): string {
  const text = asString(value, source, where);
  const named = NAMED_SIZES[text as keyof typeof NAMED_SIZES];
  if (named) return named;
  try {
    parseSize(text);
  } catch {
    fail(
      source,
      where,
      `WIDTHxHEIGHT or one of ${Object.keys(NAMED_SIZES).join(", ")}`,
      value,
    );
  }
  return text;
}

function validateVariant(
  value: unknown,
  source: string,
  where: string,
): VariantSpec {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1)
      fail(source, where, "a positive whole number", value);
    return { width: value };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(source, where, "a width or an object with a width", value);
  }
  const input = value as Record<string, unknown>;
  const width = input.width;
  if (typeof width !== "number" || !Number.isInteger(width) || width < 1) {
    fail(source, `${where}.width`, "a positive whole number", width);
  }
  const suffix =
    input.suffix === undefined
      ? undefined
      : asString(input.suffix, source, `${where}.suffix`);
  if (suffix !== undefined && !isSafeVariantSuffix(suffix)) {
    fail(
      source,
      `${where}.suffix`,
      'a non-empty name fragment with no path separators or ".."',
      suffix,
    );
  }
  return suffix === undefined ? { width } : { width, suffix };
}

function validateAsset(
  value: unknown,
  source: string,
  index: number,
  warn: (message: string) => void,
): AssetSpec {
  const where = `assets[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(source, where, "an object", value);
  }
  const input = value as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(ASSET_KEYS as readonly string[]).includes(key)) {
      warn(redact(`${source}: unknown key "${key}" on ${where} ignored.`));
    }
  }

  const id = asString(input.id, source, `${where}.id`).trim();
  if (id === "") fail(source, `${where}.id`, "a non-empty string", input.id);

  const prompt = asString(input.prompt, source, `${where}.prompt`).trim();
  if (prompt === "")
    fail(source, `${where}.prompt`, "a non-empty string", input.prompt);

  const asset: AssetSpec = { id, prompt };

  if (input.out !== undefined)
    asset.out = asString(input.out, source, `${where}.out`);
  if (input.size !== undefined)
    asset.size = resolveSize(input.size, source, `${where}.size`);
  if (input.exactSize !== undefined) {
    asset.exactSize = resolveSize(
      input.exactSize,
      source,
      `${where}.exactSize`,
    );
  }
  if (input.quality !== undefined) {
    asset.quality = asEnum(
      input.quality,
      QUALITIES,
      source,
      `${where}.quality`,
    );
  }
  if (input.format !== undefined) {
    asset.format = asEnum(input.format, FORMATS, source, `${where}.format`);
  }
  if (input.style !== undefined)
    asset.style = asString(input.style, source, `${where}.style`);
  if (input.transparent !== undefined) {
    if (typeof input.transparent !== "boolean") {
      fail(source, `${where}.transparent`, "a boolean", input.transparent);
    }
    asset.transparent = input.transparent;
  }
  if (input.references !== undefined) {
    if (!Array.isArray(input.references)) {
      fail(source, `${where}.references`, "a list of paths", input.references);
    }
    asset.references = input.references.map((entry, i) =>
      asString(entry, source, `${where}.references[${i}]`),
    );
  }
  if (input.variants !== undefined) {
    if (!Array.isArray(input.variants))
      fail(source, `${where}.variants`, "a list", input.variants);
    asset.variants = input.variants.map((entry, i) =>
      validateVariant(entry, source, `${where}.variants[${i}]`),
    );
  }

  return asset;
}

export function validateAssetsFile(
  value: unknown,
  source: string,
  warn: (message: string) => void = () => {},
): AssetsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${source}: the manifest must be a YAML mapping.`);
  }
  const input = value as Record<string, unknown>;

  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new ConfigError(`${source}: "assets" must list at least one asset.`);
  }

  const defaults: AssetDefaults = {};
  if (input.defaults !== undefined) {
    if (
      typeof input.defaults !== "object" ||
      input.defaults === null ||
      Array.isArray(input.defaults)
    ) {
      fail(source, "defaults", "an object", input.defaults);
    }
    const d = input.defaults as Record<string, unknown>;
    if (d.outDir !== undefined)
      defaults.outDir = asString(d.outDir, source, "defaults.outDir");
    if (d.style !== undefined)
      defaults.style = asString(d.style, source, "defaults.style");
    if (d.size !== undefined)
      defaults.size = resolveSize(d.size, source, "defaults.size");
    if (d.quality !== undefined) {
      defaults.quality = asEnum(
        d.quality,
        QUALITIES,
        source,
        "defaults.quality",
      );
    }
    if (d.format !== undefined) {
      defaults.format = asEnum(d.format, FORMATS, source, "defaults.format");
    }
  }

  const styles: Record<string, StyleDefinition> = {};
  if (input.styles !== undefined) {
    if (
      typeof input.styles !== "object" ||
      input.styles === null ||
      Array.isArray(input.styles)
    ) {
      fail(source, "styles", "an object", input.styles);
    }
    for (const [name, style] of Object.entries(
      input.styles as Record<string, unknown>,
    )) {
      styles[name] = validateStyle(style, source, name);
    }
  }

  const assets = input.assets.map((asset, index) =>
    validateAsset(asset, source, index, warn),
  );

  // Ids name files and name rows in the drift report. Two assets sharing one is
  // always a copy-paste mistake, and letting it through means one silently
  // overwrites the other on every sync.
  const seen = new Map<string, number>();
  for (const [index, asset] of assets.entries()) {
    const first = seen.get(asset.id);
    if (first !== undefined) {
      throw new ConfigError(
        `${source}: duplicate asset id "${asset.id}" at assets[${first}] and assets[${index}].`,
      );
    }
    seen.set(asset.id, index);
  }

  return { defaults, styles, assets };
}
