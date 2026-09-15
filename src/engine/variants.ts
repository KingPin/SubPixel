import { extname } from "node:path";
import { ConfigError } from "../core/errors.js";
import type { ImageFormat, VariantSpec } from "../core/types.js";
import { probeDimensions, resizeTo } from "./sharpx.js";

export interface Variant {
  width: number;
  height: number;
  data: Buffer;
}

// `VariantSpec` lives in core because `GenerateRequest` carries it. Re-exported so
// engine callers import it from the module that uses it.
//
// `--variants` never sets a suffix; `assets.yml` may. Both produce this one shape so
// publication has a single thing to iterate. A `number[]` here is what made the
// declared `hero@sm.webp` unreachable: the suffix was parsed, validated, and then
// dropped one call before it was needed, and the drift check went on looking for a
// file nothing was ever going to write.
export type { VariantSpec } from "../core/types.js";

export function parseVariants(spec: string | undefined): VariantSpec[] | undefined {
  if (spec === undefined) return undefined;

  const parts = spec
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) {
    throw new ConfigError(
      "--variants needs at least one width, for example --variants 400,800,1200.",
    );
  }

  const widths = parts.map((part) => {
    const width = Number(part);
    if (!Number.isInteger(width) || width < 1) {
      throw new ConfigError(`--variants: "${part}" is not a positive whole number of pixels.`);
    }
    return width;
  });

  return [...new Set(widths)].sort((a, b) => a - b).map((width) => ({ width }));
}

/**
 * `hero.webp` + 800 → `hero-800w.webp`. The `w` suffix is what `srcset` uses.
 *
 * `suffix` overrides the derived name. `assets.yml` allows a per-variant suffix
 * (spec §11), because a project that already ships `hero@sm.webp` should be able to
 * adopt subpixel without renaming files across its templates.
 */
/**
 * Is this a suffix `variantPath` may safely concatenate into a filename?
 *
 * Two ways a suffix escapes: empty makes `variantPath` return the PRIMARY's path,
 * so the variant overwrites the image it was derived from; a separator or `..`
 * walks out of the output directory and past the containment check `out` gets.
 *
 * Lives here, beside the concatenation it guards, because both the `assets.yml`
 * schema and the sidecar manifest have to apply the same rule and a second copy of
 * it is a second chance to get it wrong.
 */
export function isSafeVariantSuffix(suffix: string): boolean {
  return suffix.trim() !== "" && !/[\\/]/.test(suffix) && !suffix.includes("..");
}

export function variantPath(path: string, width: number, suffix?: string): string {
  const ext = extname(path);
  const stem = ext ? path.slice(0, path.length - ext.length) : path;
  return `${stem}${suffix ?? `-${width}w`}${ext}`;
}

/**
 * Resize to each width, keeping the aspect ratio.
 *
 * Height is derived rather than taken from the caller. A variant set exists so a
 * browser can pick a size; a set whose members have different aspect ratios makes
 * the page jump when the browser switches between them.
 *
 * A width larger than the source is SKIPPED, not upscaled. Upscaling produces a
 * bigger file that looks worse than the original, and a `srcset` entry that claims
 * detail the file does not have — the browser then downloads more bytes for the
 * same picture.
 */
export async function buildVariants(
  source: Uint8Array,
  widths: number[],
  format: ImageFormat,
  warn: (message: string) => void = () => {},
): Promise<Variant[]> {
  const dimensions = await probeDimensions(source);
  if (!dimensions) {
    throw new ConfigError(
      "--variants needs the optional sharp dependency. Install it with `npm i sharp`.",
    );
  }

  const variants: Variant[] = [];

  for (const width of [...widths].sort((a, b) => a - b)) {
    if (width > dimensions.width) {
      warn(
        `Skipping the ${width}w variant: the image is only ${dimensions.width} pixels wide. ` +
          "Upscaling would add bytes without adding detail.",
      );
      continue;
    }
    const height = Math.max(1, Math.round((dimensions.height / dimensions.width) * width));
    variants.push({ width, height, data: await resizeTo(source, width, height, "cover", format) });
  }

  return variants;
}
