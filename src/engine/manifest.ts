import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { atomicWrite } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import type {
  BackendName,
  ImageBackground,
  ImageFormat,
  ImageQuality,
  StyleDefinition,
  VariantRecord,
  VariantSpec,
} from "../core/types.js";

/**
 * The shape version. Bumped when a field is added that a replay depends on.
 *
 * Version 1 is "no version field at all" — everything written before the replayable
 * inputs below existed. Such a manifest still reads, but `spx regen` cannot know
 * whether a style or a reference image was absent or merely unrecorded, so it says
 * so once on stderr rather than quietly regenerating from different inputs.
 */
export const MANIFEST_VERSION = 2;

export interface ManifestEntry {
  /** Absent on manifests written before the replayable inputs landed. */
  manifestVersion?: number;
  prompt: string;
  effectivePrompt: string;
  model: string;
  backend: BackendName;
  size?: string;
  exactSize?: string;
  cacheKey: string;
  sha256: string;
  bytes: number;
  format: ImageFormat;
  generatedAt?: string;
  variants?: VariantRecord[];
  skippedVariants?: number[];
  /**
   * The rest of `GenerateRequest`, so the entry can replay the request that made
   * the image rather than an impoverished approximation of it.
   *
   * `resolvedReferences` is deliberately not here: it is bytes, and the paths below
   * are re-read at replay time.
   */
  quality?: ImageQuality;
  background?: ImageBackground;
  transparent?: boolean;
  /**
   * The resolved style, not the name. The engine never looks a name up, and the
   * project config that defined it may have changed since.
   */
  style?: StyleDefinition;
  /**
   * Reference image paths, stored RELATIVE TO THE SIDECAR and resolved back to
   * absolute on read. See `toSidecarRelative` for why.
   */
  referenceImages?: string[];
  /**
   * The variant widths as REQUESTED, including ones that were later skipped.
   *
   * `variants` above records what was written, which cannot reconstruct a custom
   * suffix or a width the engine refused to upscale. Replaying from the records
   * would republish `hero@sm.webp` under the default width-based name and drop
   * every skipped width, leaving the old files beside a new primary image.
   */
  variantSpecs?: VariantSpec[];
}

export function manifestPathFor(imagePath: string): string {
  return `${imagePath}.json`;
}

/**
 * A reference path as it must live on disk: relative to the sidecar's directory.
 *
 * A path "as typed" is relative to whatever directory `spx generate` ran in, and
 * nothing on disk records that directory. `readImageFile()` resolves against the
 * REPLAY process's cwd, so a manifest holding `refs/source.png` read from a
 * different directory either fails while the real reference still exists, or finds
 * a different file of the same name and overwrites the image with it.
 */
function toSidecarRelative(imagePath: string, path: string): string {
  return relative(dirname(resolve(imagePath)), resolve(path));
}

function fromSidecarRelative(imagePath: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dirname(resolve(imagePath)), path);
}

/**
 * Write the sidecar manifest.
 *
 * Redaction runs over the SERIALISED document, not field by field. A user prompt
 * can contain anything — including a key someone pasted by accident — and so can a
 * style's nested prompt text, an output path, or a reference filename. Redacting
 * the serialised form redacts every field there will ever be, and the mask contains
 * no quote or backslash, so the document stays parseable.
 */
export async function writeManifest(imagePath: string, entry: ManifestEntry): Promise<void> {
  const record: ManifestEntry = {
    manifestVersion: MANIFEST_VERSION,
    ...entry,
    ...(entry.referenceImages
      ? { referenceImages: entry.referenceImages.map((p) => toSidecarRelative(imagePath, p)) }
      : {}),
    generatedAt: entry.generatedAt ?? new Date().toISOString(),
  };
  await atomicWrite(manifestPathFor(imagePath), redact(`${JSON.stringify(record, null, 2)}\n`));
}

const FORMATS: readonly string[] = ["png", "jpeg", "webp"];
const BACKENDS: readonly string[] = ["codex-http", "codex-exec", "api"];
const QUALITIES: readonly string[] = ["low", "medium", "high", "auto"];
const BACKGROUNDS: readonly string[] = ["transparent", "opaque", "auto"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` passes: an absent optional field is fine, a wrong-typed one is not. */
function optional(value: unknown, ok: (v: unknown) => boolean): boolean {
  return value === undefined || ok(value);
}

const isString = (v: unknown): boolean => typeof v === "string";
const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
const isNumberArray = (v: unknown): boolean => Array.isArray(v) && v.every(isNumber);
const oneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && values.includes(v);

function isVariantSpecArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((v) => isRecord(v) && isNumber(v.width) && optional(v.suffix, isString))
  );
}

function isVariantRecordArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        isRecord(v) &&
        isNumber(v.width) &&
        isNumber(v.height) &&
        isString(v.path) &&
        isNumber(v.bytes),
    )
  );
}

/**
 * Is this parsed JSON actually a manifest?
 *
 * `readManifest` used to return any parseable JSON through a type assertion, so a
 * truncated file, a `{}`, or an unrelated document became a replayable request. A
 * missing OPTIONAL field is fine; a present one of the wrong type is not.
 */
export function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!isRecord(value)) return false;
  return (
    isString(value.prompt) &&
    isString(value.effectivePrompt) &&
    isString(value.model) &&
    oneOf(BACKENDS)(value.backend) &&
    isString(value.cacheKey) &&
    isString(value.sha256) &&
    isNumber(value.bytes) &&
    oneOf(FORMATS)(value.format) &&
    optional(value.manifestVersion, isNumber) &&
    optional(value.size, isString) &&
    optional(value.exactSize, isString) &&
    optional(value.generatedAt, isString) &&
    optional(value.quality, oneOf(QUALITIES)) &&
    optional(value.background, oneOf(BACKGROUNDS)) &&
    optional(value.transparent, (v) => typeof v === "boolean") &&
    optional(value.style, isRecord) &&
    optional(value.referenceImages, isStringArray) &&
    optional(value.variants, isVariantRecordArray) &&
    optional(value.skippedVariants, isNumberArray) &&
    optional(value.variantSpecs, isVariantSpecArray)
  );
}

/**
 * Read the sidecar beside an image, or `undefined` when there is not a valid one.
 *
 * Reference paths come back ABSOLUTE, resolved against the sidecar's own directory,
 * so a caller can replay them from any working directory.
 */
export async function readManifest(imagePath: string): Promise<ManifestEntry | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPathFor(imagePath), "utf8"));
  } catch {
    return undefined;
  }
  if (!isManifestEntry(parsed)) return undefined;
  if (!parsed.referenceImages) return parsed;
  return {
    ...parsed,
    referenceImages: parsed.referenceImages.map((p) => fromSidecarRelative(imagePath, p)),
  };
}
