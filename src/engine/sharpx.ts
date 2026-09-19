import { ConfigError } from "../core/errors.js";
import type { ImageFormat } from "../core/types.js";
import { sniffFormat } from "./output.js";
import { parseSize } from "./prompt.js";

/** The quality every lossy re-encode in this file settles on. */
const REENCODE_QUALITY = 90;

/**
 * Encode `image` as `format`, or leave the encoder alone when the format is unknown.
 *
 * `toBuffer()` with no format call does NOT pass the bytes through. It re-encodes
 * into the source format at sharp's own defaults, and for JPEG and WebP that default
 * is quality 80. Measured on a 1024px source cropped to 800x600, pinning the quality
 * at 90 instead yields 33% more bytes for JPEG and 35% for WebP — which is to say the
 * default was quietly throwing away a third of an image the caller had paid for. PNG
 * is lossless and unaffected, which is why this went unnoticed: the generated images
 * are usually PNG.
 *
 * `undefined` keeps the old behaviour for bytes nothing here can name. There is no
 * better guess available, and it is the same thing that happened before.
 */
function encode(image: SharpInstance, format: ImageFormat | undefined): Promise<Buffer> {
  if (format === "png") return image.png().toBuffer();
  if (format === "jpeg") return image.jpeg({ quality: REENCODE_QUALITY }).toBuffer();
  if (format === "webp") return image.webp({ quality: REENCODE_QUALITY }).toBuffer();
  return image.toBuffer();
}

/**
 * Crop and resize to exactly the requested pixel dimensions.
 *
 * This is the "enforce" layer of the size policy. The backend honours the
 * requested size only approximately, so a caller that needs a precise asset —
 * an app icon, an OG card — opts into a deterministic local resize.
 *
 * The output format is the input's, pinned rather than inherited; see `encode` for
 * why the difference is worth a sniff.
 */
export async function enforceExactSize(data: Uint8Array, exactSize: string): Promise<Buffer> {
  const { width, height } = parseSize(exactSize);
  const sharp = await loadSharp("--exact-size");
  const buffer = Buffer.from(data);

  return encode(
    sharp(buffer).resize(width, height, { fit: "cover", position: "attention" }),
    sniffFormat(buffer),
  );
}

export interface SharpMetadata {
  width?: number;
  height?: number;
  format?: string;
  hasAlpha?: boolean;
}

export interface RawResult {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

/**
 * Only the corner of `sharp` this project uses.
 *
 * `sharp` is an OPTIONAL peer dependency, so `npm ci` does not install it and its
 * types are not on disk in a clean checkout. A `typeof import("sharp")` annotation
 * would make the optional dependency mandatory at build time, which is exactly what
 * optional is supposed to avoid. The cost of hand-declaring it is that this
 * interface must be kept honest against the real library; the tests below are
 * gated on sharp being present precisely so they catch a drift the compiler cannot.
 */
export interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  resize(
    width: number,
    height: number,
    options: { fit: "cover" | "contain"; position?: "attention" | "centre"; background?: RGBA },
  ): SharpInstance;
  png(options?: { compressionLevel?: number }): SharpInstance;
  jpeg(options?: { quality?: number }): SharpInstance;
  webp(options?: { quality?: number }): SharpInstance;
  ensureAlpha(): SharpInstance;
  toColourspace(space: "srgb"): SharpInstance;
  raw(): SharpInstance;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<RawResult>;
}

export type SharpFactory = (
  input: Buffer,
  options?: { raw: { width: number; height: number; channels: number } },
) => SharpInstance;

export async function loadSharp(feature: string): Promise<SharpFactory> {
  try {
    // The specifier is held in a variable so the compiler does not try to resolve a
    // package that is legitimately absent. Resolution failure belongs at runtime,
    // where the catch below turns it into an actionable ConfigError.
    const specifier = "sharp";
    const mod: unknown = await import(specifier);
    const factory = (mod as { default?: unknown }).default ?? mod;
    if (typeof factory !== "function") throw new TypeError("sharp did not export a function");
    return factory as SharpFactory;
  } catch {
    throw new ConfigError(
      `${feature} needs the optional sharp dependency. Install it with \`npm i sharp\`.`,
    );
  }
}

/** Is the optional `sharp` dependency installed? Used by `spx doctor`. */
export async function sharpAvailable(): Promise<boolean> {
  try {
    await loadSharp("probe");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check everything `--exact-size` needs BEFORE any provider call.
 *
 * Discovering a typo in `--exact-size`, or a missing `sharp`, after the image has
 * already been generated costs the user a unit of subscription quota for an image
 * they never receive. Both checks are free and both are deterministic, so the
 * orchestrator runs this first and fails fast.
 */
export async function preflightExactSize(exactSize: string | undefined): Promise<void> {
  if (!exactSize) return;
  parseSize(exactSize); // Throws ConfigError on a malformed value.
  await loadSharp("--exact-size"); // Throws ConfigError naming `npm i sharp`.
}

/**
 * Read the real pixel dimensions.
 *
 * Returns `undefined` rather than throwing when sharp is absent, because every
 * caller of this function wants dimensions as a NICE-TO-HAVE for the manifest.
 * Refusing to write a manifest because an optional dependency is missing would
 * make an optional dependency mandatory through the back door. Bytes sharp cannot
 * decode are undefined for the same reason: a manifest without dimensions is
 * better than a run that dies writing one.
 */
export async function probeDimensions(
  data: Uint8Array,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const sharp = await loadSharp("image metadata");
    const meta = await sharp(Buffer.from(data)).metadata();
    if (typeof meta.width !== "number" || typeof meta.height !== "number") return undefined;
    return { width: meta.width, height: meta.height };
  } catch {
    return undefined;
  }
}

/** Re-encode to `format`. A no-op when the bytes are already in that format. */
export async function convert(data: Uint8Array, format: ImageFormat): Promise<Buffer> {
  const buffer = Buffer.from(data);
  if (sniffFormat(buffer) === format) return buffer;

  const sharp = await loadSharp(`converting to ${format}`);
  return encode(sharp(buffer), format);
}

/**
 * Resize to exact dimensions.
 *
 * `cover` crops to fill and is what an icon or a card wants. `contain` pads and is
 * what a variant of a whole illustration wants — cropping a hero image to a narrow
 * phone width would cut the subject out of it. The padding is transparent, which is
 * only meaningful in a format that has an alpha channel; a caller asking for
 * `contain` into JPEG gets black, which is sharp's behaviour and not worth hiding.
 *
 * `cover` crops from the CENTRE, which is what `spx icons` tells the user it does.
 * sharp's `position: "attention"` picks the crop by saliency instead, which is a
 * different promise: it moves with the content, so two icons in a set can be cropped
 * to different regions of the same source, and the non-square warning that says
 * "centre-cropped" is then simply untrue.
 *
 * `format` re-encodes the result. It is not optional bookkeeping: `.toBuffer()`
 * alone returns the SOURCE format, so a JPEG source resized "to a PNG icon" yields
 * JPEG bytes in a file named `.png`, and an ICO built from them is not a PNG-payload
 * ICO at all. Callers that need a specific container say so here.
 */
export async function resizeTo(
  data: Uint8Array,
  width: number,
  height: number,
  fit: "cover" | "contain",
  format?: ImageFormat,
): Promise<Buffer> {
  const sharp = await loadSharp("resizing");
  const image = sharp(Buffer.from(data)).resize(width, height, {
    fit,
    ...(fit === "cover"
      ? { position: "centre" as const }
      : { background: { r: 0, g: 0, b: 0, alpha: 0 } }),
  });
  return encode(image, format);
}
