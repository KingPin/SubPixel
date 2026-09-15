import { resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../core/errors.js";
import type { GenerateRequest } from "../core/types.js";
import { MANIFEST_VERSION, manifestPathFor, readManifest } from "../engine/manifest.js";
import type { ManifestEntry } from "../engine/manifest.js";
import { runGenerateRequest, type GenerateCliOptions } from "./generate.js";
import { resolveStyle } from "./styles.js";

/**
 * The flags `regen` accepts on top of the manifest.
 *
 * Deliberately narrow. `regen` replays a recorded request; a caller who wants to
 * change more than one field of it wants `spx generate`. These four plus `-o` are
 * the ones the spec's CLI surface lists.
 */
export interface RegenCliOptions {
  size?: string;
  style?: string;
  model?: string;
  backend?: string;
  out?: string;
  json?: boolean;
  emit?: GenerateCliOptions["emit"];
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * Rebuild the request that produced an image from its sidecar manifest.
 *
 * Exported for the tests: this is where a v1 manifest's absent fields turn into an
 * impoverished request, and where a flag override beats what was recorded.
 */
export function requestFromManifest(
  imagePath: string,
  manifest: ManifestEntry,
  options: RegenCliOptions,
  style: ReturnType<typeof resolveStyle>,
): GenerateRequest {
  return {
    prompt: manifest.prompt,
    outputPath: resolve(options.out ?? imagePath),
    size: options.size ?? manifest.size,
    quality: manifest.quality,
    background: manifest.background,
    transparent: manifest.transparent,
    exactSize: manifest.exactSize,
    // The manifest records the format of the bytes that were WRITTEN, which is the
    // format this replay has to reproduce for the file to land on the same path.
    format: manifest.format,
    model: options.model ?? manifest.model,
    // `readManifest` already resolved these against the sidecar's own directory, so
    // the replay reads the same files whatever directory it runs in.
    referenceImages: manifest.referenceImages,
    variants: manifest.variantSpecs,
    // A `--style` flag replaces the recorded definition wholesale. Merging a named
    // style into a recorded one would produce a third style that neither the
    // original run nor the flag asked for.
    style: style ?? manifest.style,
  };
}

export async function runRegen(image: string, options: RegenCliOptions): Promise<void> {
  const warn = (message: string) => process.stderr.write(`warning: ${message}\n`);
  const imagePath = resolve(image);

  // Before any quota is spent, and before the config is even loaded: a missing or
  // malformed manifest is a `ConfigError`, never a silent regenerate-from-nothing.
  const manifest = await readManifest(imagePath);
  if (!manifest) {
    throw new ConfigError(
      `No usable manifest at ${manifestPathFor(image)}. ` +
        "`spx regen` replays the sidecar written beside an image; without it there is " +
        "nothing to replay. Use `spx generate` instead.",
    );
  }

  if ((manifest.manifestVersion ?? 1) < MANIFEST_VERSION) {
    warn(
      `${manifestPathFor(image)} predates the replayable manifest fields. Style, reference ` +
        "images, quality, background, transparency and custom variant names were not " +
        "recorded, so this replay uses only what is in the file.",
    );
  }

  const { config } = await loadConfig({ warn });
  const style = resolveStyle(config, options.style);
  const request = requestFromManifest(imagePath, manifest, options, style);

  await runGenerateRequest(request, {
    ...options,
    config,
    // A replay is by definition not a cache lookup — the whole point is new pixels
    // for the same request — and it writes over the image it replayed rather than
    // dropping a `-v2` sibling beside it. `--force` is exactly those two decisions.
    force: true,
    // The manifest records the backend that actually produced the image, and a
    // replay that silently picks a different driver is not a replay. Without the
    // flag, `resolveGenerateDeps` would fall back to whatever this project's config
    // says today, which may have changed since the image was made.
    backend: options.backend ?? manifest.backend,
  });
}
