import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { atomicPublish, atomicWrite, within } from "../core/fsx.js";
import { ConfigError, OutputError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import {
  BACKEND_NAMES,
  IMAGE_BACKGROUNDS,
  IMAGE_FORMATS,
  IMAGE_QUALITIES,
  STYLE_TEXT_FIELDS,
} from "../core/types.js";
import { isSafeVariantSuffix } from "./variants.js";
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
   * Reference image paths, stored RELATIVE TO THE SIDECAR with `/` separators.
   * `readManifest` returns them as recorded; `resolveManifestReferences` turns them
   * into absolute paths a replay may open. See `toSidecarRelative` for why.
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
 * Is the sidecar slot beside this image ours to write?
 *
 * True when nothing is there, and when what is there is a manifest we wrote. False
 * for an unrelated `hero.png.json` that a user, a build step, or another tool put
 * beside the image.
 *
 * It matters because `writeManifest` replaces its target unconditionally, and it runs
 * AFTER the image has landed. Without this the no-clobber rule covers half a
 * destination: `hero.png` being free is enough to take `hero.png`, and the run then
 * destroys the neighbouring JSON that nobody passed `--overwrite` for. The sidecar is
 * part of the destination, so it is checked while the destination is still being
 * chosen.
 */
export async function sidecarIsOursToWrite(
  imagePath: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(manifestPathFor(imagePath), "utf8");
  } catch (err) {
    // ENOENT is the only error that means "nothing is there". A sidecar slot that
    // holds a directory, or one this process cannot read, is a slot we cannot write
    // — treating that as empty publishes the image and then fails on the manifest,
    // leaving a picture on disk with no record of what produced it.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    return isManifestEntry(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * A reference path as it must live on disk: relative to the sidecar's directory,
 * with `/` separators whatever platform wrote it.
 *
 * A path "as typed" is relative to whatever directory `spx generate` ran in, and
 * nothing on disk records that directory. `readImageFile()` resolves against the
 * REPLAY process's cwd, so a manifest holding `refs/source.png` read from a
 * different directory either fails while the real reference still exists, or finds
 * a different file of the same name and overwrites the image with it.
 *
 * The separator is normalised because a sidecar travels: it is committed, pulled,
 * and replayed on a different machine from the one that wrote it. `refs\source.png`
 * written on Windows is ONE filename on POSIX, so the replay silently looks for a
 * file that does not exist. Node accepts `/` on Windows too, so one direction of
 * normalisation covers both.
 *
 * ponytail: write-side only. A sidecar already written on Windows still carries
 * backslashes, and rewriting them here would corrupt a POSIX filename that legally
 * contains one. Those sidecars are regenerated, not migrated.
 */
function toSidecarRelative(imagePath: string, path: string): string {
  const rel = relative(dirname(resolve(imagePath)), resolve(path));
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * Turn the recorded reference paths into absolute ones a replay can read, refusing
 * any that leave `projectDir`.
 *
 * This is deliberately NOT part of `readManifest`. A sidecar is attacker-reachable
 * input — it arrives over a pull request, out of a cache, from a colleague — and
 * `spx regen` hands these paths to the reference loader, which base64-encodes the
 * bytes and posts them upstream. A sidecar naming `/home/dev/Pictures/scan.png` or
 * `../../../secrets/id_rsa.png` therefore exfiltrates a file the user never chose
 * to send, on a command whose whole promise is "make that image again".
 *
 * Every other reference path in the tool is already confined: `assets.yml` through
 * `within()` in the asset loader, MCP arguments through `within()` at the tool
 * boundary. This closes the third door with the same call.
 *
 * Splitting it from `readManifest` is what makes that durable. Reading a sidecar for
 * inspection needs no root and gets no absolute paths; obtaining a path a replay can
 * actually open requires naming the root it must stay inside. A future caller cannot
 * reach the dangerous form without answering the question.
 */
export function resolveManifestReferences(
  imagePath: string,
  projectDir: string,
  paths: readonly string[],
): string[] {
  const sidecarDir = dirname(resolve(imagePath));
  return paths.map((path) => {
    try {
      return within(projectDir, resolve(sidecarDir, path), `${basename(manifestPathFor(imagePath))} referenceImages`);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      throw new ConfigError(
        `${err.message} A sidecar may only replay reference images from inside the project, ` +
          "because replaying one uploads it. Copy the reference into the project and regenerate, " +
          "or run `spx generate` with an explicit --image.",
        err,
      );
    }
  });
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
export async function writeManifest(
  imagePath: string,
  entry: ManifestEntry,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const record: ManifestEntry = {
    manifestVersion: MANIFEST_VERSION,
    ...entry,
    ...(entry.referenceImages
      ? {
          referenceImages: entry.referenceImages.map((p) =>
            toSidecarRelative(imagePath, p),
          ),
        }
      : {}),
    generatedAt: entry.generatedAt ?? new Date().toISOString(),
  };
  const target = manifestPathFor(imagePath);
  const document = redact(`${JSON.stringify(record, null, 2)}\n`);

  if (options.overwrite) {
    await atomicWrite(target, document);
    return;
  }

  // Claimed with link()/EEXIST, the same way the image beside it is claimed.
  // `sidecarIsOursToWrite` runs while the destination is being CHOSEN, which leaves
  // the whole generation between the look and the write; a plain rename here hands
  // that window to anything else writing into the directory. Publishing
  // conditionally means the only file this can replace is one it has just read and
  // recognised as ours.
  if (await atomicPublish(target, document, { overwrite: false })) return;

  if (await sidecarIsOursToWrite(imagePath)) {
    await atomicWrite(target, document);
    return;
  }

  throw new OutputError(
    `${basename(target)} appeared beside the image during this run and is not a subpixel ` +
      "manifest, so it was left alone. The image was written; re-run with --overwrite to " +
      "replace the sidecar.",
  );
}

const FORMATS: readonly string[] = IMAGE_FORMATS;
const BACKENDS: readonly string[] = BACKEND_NAMES;
const QUALITIES: readonly string[] = IMAGE_QUALITIES;
const BACKGROUNDS: readonly string[] = IMAGE_BACKGROUNDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` passes: an absent optional field is fine, a wrong-typed one is not. */
function optional(value: unknown, ok: (v: unknown) => boolean): boolean {
  return value === undefined || ok(value);
}

const isString = (v: unknown): boolean => typeof v === "string";
const isNumber = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v);
const isWidth = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 1;
const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every(isString);
const isNumberArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every(isNumber);
const oneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && values.includes(v);

/**
 * The same rules `assets.yml` applies, because the sidecar reaches the same code.
 *
 * A sidecar arrives with the image — over a pull request, out of a cache, from a
 * colleague — and `spx regen` concatenates its suffix straight into an output path.
 * Accepting a fractional width here only defers the complaint to the resizer;
 * accepting `../` here writes outside the image's directory.
 */
function isVariantSpecArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        isRecord(v) &&
        isWidth(v.width) &&
        optional(
          v.suffix,
          (s) => isString(s) && isSafeVariantSuffix(s as string),
        ),
    )
  );
}

/**
 * Every field of a style, not just the outer object.
 *
 * `composeStyleBlock` calls `.trim()` on each text field. A sidecar holding
 * `{ style: { subject: 7 } }` therefore used to reach replay and throw a raw
 * `TypeError`, when the honest answer is that the sidecar is unusable.
 *
 * Deliberately not `validateStyle` from the config layer: this wants a boolean, and
 * the engine does not import config.
 */
function isStyleDefinition(value: unknown): boolean {
  return (
    isRecord(value) &&
    STYLE_TEXT_FIELDS.every((field) => optional(value[field], isString)) &&
    optional(value.size, isString) &&
    optional(value.quality, oneOf(QUALITIES)) &&
    optional(value.background, oneOf(BACKGROUNDS)) &&
    optional(value.format, oneOf(FORMATS))
  );
}

function isVariantRecordArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        isRecord(v) &&
        isWidth(v.width) &&
        isWidth(v.height) &&
        isString(v.path) &&
        isNumber(v.bytes) &&
        optional(v.sha256, isString),
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
    optional(value.style, isStyleDefinition) &&
    optional(value.referenceImages, isStringArray) &&
    optional(value.variants, isVariantRecordArray) &&
    optional(value.skippedVariants, isNumberArray) &&
    optional(value.variantSpecs, isVariantSpecArray)
  );
}

/**
 * Read the sidecar beside an image, or `undefined` when there is not a valid one.
 *
 * Reference paths come back EXACTLY AS RECORDED — relative to the sidecar, and not
 * yet checked against anything. Call `resolveManifestReferences` to get paths a
 * replay may open; see there for why the two steps are separate.
 */
export async function readManifest(
  imagePath: string,
): Promise<ManifestEntry | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPathFor(imagePath), "utf8"));
  } catch {
    return undefined;
  }
  return isManifestEntry(parsed) ? parsed : undefined;
}
