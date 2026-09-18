import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ConfigError, OutputError } from "../core/errors.js";
import { atomicPublish } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { manifestPathFor, sidecarIsOursToWrite } from "./manifest.js";
import type { ImageArtifact, ImageFormat } from "../core/types.js";

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Identify the image format from its magic number.
 *
 * The declared output_format is a request, not a guarantee, and a backend error
 * page would otherwise be written to disk with a .png extension.
 */
export function sniffFormat(data: Uint8Array): ImageFormat | undefined {
  if (data.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => data[index] === byte)) return "png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpeg";
  }
  if (data.length >= 12) {
    const text = Buffer.from(data.subarray(0, 12)).toString("latin1");
    if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "webp";
  }
  return undefined;
}

const MAX_SLUG = 40;

export function slugify(text: string): string {
  // The `[^a-z0-9]+` collapse below leaves single dashes only, never runs, so the
  // trims match one dash rather than `-+`. Keep it that way: `-+` anchored at the
  // end is a polynomial-backtracking shape, and it only stays harmless because
  // nothing upstream can produce `--`. Reorder these and that stops being true.
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-$/g, "");
  return slug.length > 0 ? slug : "image";
}

export interface ResolveOutputPathOptions {
  outDir: string;
  prompt: string;
  /**
   * The format to use as the extension.
   *
   * Callers MUST pass the SNIFFED format, not the requested one. `writeImage`
   * enforces this again, but resolving the name from a format nobody verified is
   * how a JPEG ends up called `.png`.
   */
  format: ImageFormat;
  explicit?: string;
  /** Index within a multi-image request, so images do not overwrite each other. */
  index?: number;
  /**
   * The canonical request hash. Naming from it is what makes a derived name
   * STABLE: the same request run twice lands on the same file, so a cache hit
   * re-materialises over its own bytes instead of littering the output directory
   * with a fresh copy per run, and `spx sync` in CI is idempotent. Falls back to
   * the prompt, which is the only identity a caller without a key has.
   */
  key?: string;
}

export function resolveOutputPath(options: ResolveOutputPathOptions): string {
  if (options.explicit) return options.explicit;

  const index = options.index ?? 0;
  const hash = createHash("sha256")
    .update(`${options.key ?? options.prompt}\0${index}`)
    .digest("hex")
    .slice(0, 8);

  // The prompt is redacted BEFORE it becomes a name, not after. `slugify` only
  // lowercases and replaces punctuation, so `sk-proj-abc…` survives it intact and
  // then gets printed to stdout, pasted into a Markdown snippet, and persisted as
  // `firstWrittenTo` in the cache. Redacting here — rather than masking the path on
  // the way out — keeps the emitted path pointing at the file that actually exists.
  const name = basename(`${slugify(redact(options.prompt))}-${hash}.${options.format}`);
  return join(options.outDir, name);
}

const EXTENSION_FOR: Record<ImageFormat, string> = { png: ".png", jpeg: ".jpg", webp: ".webp" };
/** Extensions that are an acceptable spelling of a given sniffed format. */
const ACCEPTED_EXTENSIONS: Record<ImageFormat, string[]> = {
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  webp: [".webp"],
};

/** Rewrite a path so its extension matches the bytes. */
export function pathForFormat(path: string, format: ImageFormat): string {
  const current = extname(path).toLowerCase();
  if (ACCEPTED_EXTENSIONS[format].includes(current)) return path;
  const stem = current ? path.slice(0, path.length - current.length) : path;
  return `${stem}${EXTENSION_FOR[format]}`;
}

/**
 * Name what the caller asked for, for the format-mismatch warning.
 *
 * An explicit `--format` wins. Otherwise the destination's extension is the
 * request. An extensionless destination expressed no preference, so the warning
 * falls back to generic wording rather than printing an empty string.
 *
 * This is a named function on purpose. Written inline it would have to mix `??`
 * with `||`, which is a parse error, and the parenthesised one-liner that fixes
 * that is unreadable inside a template literal.
 */
function describeRequested(requestedFormat: string | undefined, path: string): string {
  if (requestedFormat) return requestedFormat;
  const fromPath = extname(path).replace(".", "");
  return fromPath || "the requested format";
}

/**
 * Produce the next sibling name for a path that is already taken.
 *
 * `hero.png` → `hero-v2.png` → `hero-v3.png`, matching the spec's example. An
 * existing `-vN` suffix is incremented rather than stacked, so repeated runs do
 * not produce `hero-v2-v2-v2.png`.
 */
export function siblingPath(path: string, attempt: number): string {
  const ext = extname(path);
  const stem = ext ? path.slice(0, path.length - ext.length) : path;
  const base = stem.replace(/-v\d+$/, "");
  return `${base}-v${attempt}${ext}`;
}

export interface WriteImageOptions {
  /**
   * The format the caller asked the backend for. Used only to detect a mismatch;
   * it never names the file.
   */
  requestedFormat?: ImageFormat;
  /**
   * Replace an existing file. Off by default. The spec is explicit: never
   * overwrite without `--force`; write a sibling instead.
   */
  overwrite?: boolean;
  /**
   * Warning sink. These warnings survive `--quiet` per the spec, so this is the
   * unconditional stderr writer, not the level-filtered logger.
   */
  warn?: (message: string) => void;
  /** How many sibling names to try before giving up. */
  maxSiblings?: number;
}

const DEFAULT_MAX_SIBLINGS = 99;

/** Whether `path` already holds exactly `data`. A missing or unreadable file is not. */
async function sameBytes(path: string, data: Uint8Array): Promise<boolean> {
  try {
    const existing = await readFile(path);
    return existing.length === data.length && sha256(existing) === sha256(data);
  } catch {
    return false;
  }
}

/**
 * Write image bytes to disk without overwriting anything and without lying about
 * what the bytes are.
 *
 * Order matters. The format is sniffed FIRST, then the path is derived from the
 * sniffed format, then the file is published with a no-clobber create. Sniffing
 * after choosing the name is what produces a JPEG named `.png`; publishing with a
 * plain rename is what silently destroys a file another process just wrote.
 */
export async function writeImage(
  path: string,
  data: Uint8Array,
  options: WriteImageOptions = {},
): Promise<ImageArtifact> {
  const format = sniffFormat(data);
  if (!format) {
    throw new ConfigError(
      `The backend returned ${data.length} bytes that are not a PNG, JPEG, or WebP image. ` +
        "Nothing was written.",
    );
  }

  const warn = options.warn ?? (() => {});
  const intended = pathForFormat(path, format);
  if (intended !== path) {
    // Unconditional, per the spec's "never lie about bytes" rule. This fires for a
    // derived name AND for a user-supplied --output whose extension disagrees with
    // the bytes; in both cases the bytes win and the user is told.
    warn(
      `The backend returned ${format} bytes, not ${describeRequested(options.requestedFormat, path)}. ` +
        `Writing ${basename(intended)} instead of ${basename(path)}.`,
    );
  }

  const maxSiblings = options.maxSiblings ?? DEFAULT_MAX_SIBLINGS;
  let target = intended;
  // Why the redirect happened, so the warning can say which file was in the way. The
  // image and its sidecar are one destination and either can be the occupied half.
  let blocked: "image" | "sidecar" = "image";
  for (let attempt = 1; ; attempt += 1) {
    // A destination is only free when BOTH halves of it are. `writeManifest` replaces
    // `<target>.json` unconditionally once the image lands, so taking a free image
    // name whose sidecar slot holds a stranger's file destroys that file — with no
    // overwrite flag anywhere in the run. Checked here, while the destination is
    // still being chosen, rather than after the image is already on disk.
    const sidecarFree = options.overwrite === true || (await sidecarIsOursToWrite(target));
    // atomicPublish resolves false when the target already exists and overwrite is
    // off. It uses link()/EEXIST rather than rename(), so two concurrent writers
    // cannot both believe they won.
    const published = sidecarFree
      ? await atomicPublish(target, data, { overwrite: options.overwrite === true })
      : false;
    if (published) {
      if (target !== intended) {
        warn(
          blocked === "sidecar"
            ? `${basename(manifestPathFor(intended))} exists and is not a subpixel manifest. ` +
                `Wrote ${basename(target)} instead.`
            : `${basename(intended)} exists. Wrote ${basename(target)} instead.`,
        );
      }
      return {
        path: target,
        bytes: data.length,
        format,
        sha256: sha256(data),
        ...(options.requestedFormat && options.requestedFormat !== format
          ? { requestedFormat: options.requestedFormat }
          : {}),
        ...(target !== intended ? { siblingOf: intended } : {}),
      };
    }
    // The target exists. If it already holds exactly these bytes, this run is a
    // re-run of one that already succeeded — writing `-v2` beside an identical
    // file protects nothing and breaks idempotency. The no-clobber rule exists to
    // stop DIFFERENT content replacing the user's file; identical content is not
    // a collision.
    //
    // Gated on the sidecar too: returning early here is a promise that the manifest
    // about to be written lands somewhere it is allowed to.
    if (sidecarFree && (await sameBytes(target, data))) {
      return {
        path: target,
        bytes: data.length,
        format,
        sha256: sha256(data),
        ...(options.requestedFormat && options.requestedFormat !== format
          ? { requestedFormat: options.requestedFormat }
          : {}),
        ...(target !== intended ? { siblingOf: intended } : {}),
      };
    }
    if (attempt > maxSiblings) {
      throw new OutputError(
        `${intended} exists and ${maxSiblings} sibling names are taken too. ` +
          "Pass --overwrite, or choose a different --output.",
      );
    }
    blocked = sidecarFree ? "image" : "sidecar";
    target = siblingPath(intended, attempt + 1);
  }
}

export { enforceExactSize, preflightExactSize, sharpAvailable } from "./sharpx.js";
