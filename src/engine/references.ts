import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ConfigError } from "../core/errors.js";
import type { ImageFormat, LoadedReference } from "../core/types.js";
import { sniffFormat } from "./output.js";

/**
 * Per-file and whole-request caps.
 *
 * A reference travels to the model base64-encoded inside a JSON body, which costs
 * roughly a third more than the file on disk. The endpoint rejects an oversized
 * body with an opaque error long after the user has waited; refusing locally with
 * the real number is the difference between a fixable message and a mystery.
 */
export const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 32 * 1024 * 1024;

const MEDIA_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type { LoadedReference } from "../core/types.js";

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Read an image file and confirm the bytes really are an image.
 *
 * No size cap: the caps above are a property of the TRANSPORT, not of the file.
 * `spx icons` never sends its source anywhere — it resizes it locally — so a
 * perfectly good 20 MiB master would otherwise be refused by a limit that exists
 * to keep a base64 request body under the endpoint's ceiling.
 */
export async function readImageFile(path: string): Promise<{ data: Buffer; format: ImageFormat }> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    throw new ConfigError(
      `Reference image "${path}" could not be read (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const format = sniffFormat(data);
  if (!format) {
    throw new ConfigError(
      `Reference image "${basename(path)}" is not a PNG, JPEG, or WebP. subpixel reads the file's ` +
        "leading bytes rather than its extension, so a renamed file fails here.",
    );
  }

  return { data, format };
}

export async function loadReference(path: string): Promise<LoadedReference> {
  const { data, format } = await readImageFile(path);

  if (data.length > MAX_REFERENCE_BYTES) {
    throw new ConfigError(
      `Reference image "${path}" is too large: ${mib(data.length)}, cap ${mib(MAX_REFERENCE_BYTES)}.`,
    );
  }

  return {
    path,
    format,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    dataUrl: `data:${MEDIA_TYPES[format]};base64,${data.toString("base64")}`,
  };
}

export async function loadReferences(paths: string[] | undefined): Promise<LoadedReference[]> {
  if (!paths || paths.length === 0) return [];

  // Sequential on purpose. References are read once per run and the list is short;
  // reading them in parallel would only make the first failure non-deterministic,
  // which is the opposite of what an error message needs.
  const loaded: LoadedReference[] = [];
  for (const path of paths) loaded.push(await loadReference(path));

  const total = loaded.reduce((sum, reference) => sum + reference.bytes, 0);
  if (total > MAX_REFERENCE_TOTAL_BYTES) {
    throw new ConfigError(
      `Reference images are too large combined: ${mib(total)} across ${loaded.length} files, ` +
        `cap ${mib(MAX_REFERENCE_TOTAL_BYTES)}.`,
    );
  }

  return loaded;
}
