import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { ConfigError } from "../core/errors.js";
import { within } from "../core/fsx.js";
import { manifestPathFor } from "../engine/manifest.js";
import { pathForFormat } from "../engine/output.js";
import { variantPath } from "../engine/variants.js";
import type { GenerateRequest, ImageFormat, StyleDefinition } from "../core/types.js";
import { validateAssetsFile, type AssetSpec, type AssetsFile, type VariantSpec } from "./schema.js";

export const ASSETS_FILENAME = "assets.yml";

export interface ResolvedAsset {
  id: string;
  /** Absolute output path. */
  out: string;
  /** Everything the engine needs. Nothing is decided after this point. */
  request: GenerateRequest;
  variants: VariantSpec[];
}

export interface LoadedAssets {
  path: string;
  dir: string;
  file: AssetsFile;
  assets: ResolvedAsset[];
}

/**
 * Find the style an asset runs under, or fail naming the ones that exist.
 *
 * Separate from `buildRequest` because the output FILENAME depends on the style
 * too: a style whose format is webp has to produce `hero.webp`, and the name is
 * decided before the request is built.
 */
function styleFor(asset: AssetSpec, file: AssetsFile): StyleDefinition | undefined {
  const styleName = asset.style ?? file.defaults.style;
  if (styleName === undefined) return undefined;
  const style = file.styles[styleName];
  if (style === undefined) {
    const available = Object.keys(file.styles).sort().join(", ");
    throw new ConfigError(
      `assets.yml: asset "${asset.id}" uses unknown style "${styleName}".` +
        (available ? ` Available: ${available}.` : " The manifest defines no styles."),
    );
  }
  return style;
}

/**
 * The one precedence order, used for every field a style can supply.
 *
 * Asset beats `defaults` beats style. A style is the weakest of the three because
 * it is the most shared: it describes how a family of images should look, and the
 * asset that names it is the one thing that knows about itself.
 *
 * Attaching the style object without reading these fields is not neutral. The style
 * is hashed into the cache key, so the run is billed as if the style applied, and
 * then a `format: webp` style writes `hero.png` — which `assets.yml` declared as
 * `hero.webp` and therefore reports missing on every subsequent run.
 */
function buildRequest(
  asset: AssetSpec,
  file: AssetsFile,
  style: StyleDefinition | undefined,
  format: ImageFormat,
  dir: string,
  out: string,
): GenerateRequest {
  return {
    prompt: asset.prompt,
    size: asset.size ?? file.defaults.size ?? style?.size,
    quality: asset.quality ?? file.defaults.quality ?? style?.quality,
    // Only the style can supply this: `assets.yml` has no background key, and
    // inventing one here would be a schema change nobody asked for.
    background: style?.background,
    // Already resolved by the caller, because the filename was derived from it.
    format,
    exactSize: asset.exactSize,
    transparent: asset.transparent === true,
    outputPath: out,
    style,
    referenceImages: asset.references?.map((path) => within(dir, path, "assets.yml")),
    // The whole spec, suffix included. Mapping to widths here is what left the
    // declared `hero@sm.webp` with nothing to write it.
    variants: asset.variants,
  };
}

/**
 * Refuse a manifest whose assets write over each other.
 *
 * Every file `sync` will produce is claimed here, before anything is generated:
 * primaries, their sidecars, and every variant. Two assets sharing an `out` is not
 * a race that resolves to "last one wins" — `sync` overwrites unconditionally, so
 * the winner changes with file order and CI reports drift on whichever lost.
 *
 * Variants are included because a derived name can collide with a declared one:
 * `hero` with a 800w variant and an asset literally named `hero-800w` both claim
 * `hero-800w.png`, and nothing else in the pipeline would notice.
 */
function reserveDestinations(dir: string, assets: readonly ResolvedAsset[]): void {
  const claimed = new Map<string, string>();
  const claim = (path: string, by: string, what: string): void => {
    const previous = claimed.get(path);
    if (previous !== undefined) {
      throw new ConfigError(
        `assets.yml: "${by}" and "${previous}" both write ${path} (${what}). ` +
          "Give one of them a different out path or variant suffix.",
      );
    }
    claimed.set(path, by);
  };

  for (const asset of assets) {
    claim(asset.out, asset.id, "primary");
    claim(manifestPathFor(asset.out), asset.id, "sidecar");
    for (const variant of asset.variants) {
      // `within` again: the suffix is validated at the schema, and this is the
      // check on the joined result. Two cheap guards on the same trust boundary.
      claim(within(dir, variantPath(asset.out, variant.width, variant.suffix), "assets.yml"), asset.id, "variant");
    }
  }
}

export async function loadAssets(
  path: string,
  warn: (message: string) => void = () => {},
): Promise<LoadedAssets> {
  const absolute = resolve(path);
  const dir = dirname(absolute);

  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Could not read ${absolute} (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    // The `yaml` package's errors carry a line and column, which is the whole
    // value of the message. Wrapping keeps the exit code right without losing it.
    throw new ConfigError(`${absolute}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const file = validateAssetsFile(parsed, absolute, warn);
  const outDir = file.defaults.outDir ?? ".";

  const assets = file.assets.map((asset) => {
    const style = styleFor(asset, file);
    // The style is part of this chain, not an afterthought. A webp style has to
    // produce `hero.webp`, or the manifest declares a file nothing ever writes.
    const format = asset.format ?? file.defaults.format ?? style?.format ?? "png";
    const extension = format === "jpeg" ? "jpg" : format;
    const out = within(dir, asset.out ?? `${outDir}/${asset.id}.${extension}`, "assets.yml");
    // A declared `out` whose extension contradicts the format is refused, not
    // quietly corrected. `writeImage` names the file after the BYTES, so
    // `out: hero.png` with `format: webp` writes hero.webp while this record — and
    // therefore the destination reservation and every `--check` run after it —
    // keeps looking for hero.png, and the manifest reports stale forever.
    if (asset.out !== undefined && pathForFormat(out, format) !== out) {
      throw new ConfigError(
        `assets.yml: asset "${asset.id}" declares out "${asset.out}", which does not ` +
          `match format ${format}. Rename it, or drop the format.`,
      );
    }
    return {
      id: asset.id,
      out,
      request: buildRequest(asset, file, style, format, dir, out),
      variants: asset.variants ?? [],
    };
  });

  // Before anything is returned, and therefore long before anything is generated.
  reserveDestinations(dir, assets);

  return { path: absolute, dir, file, assets };
}
