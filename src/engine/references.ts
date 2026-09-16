import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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

/**
 * Read one reference, refusing anything over the cap BEFORE it is in memory.
 *
 * The size comes from stat, not from the buffer. Reading first and measuring after
 * means the 3 GiB file the user pointed at by mistake is resident in this process
 * before anything objects to it, and the objection is then an allocation failure
 * rather than the message below.
 *
 * `budget` is what is left of the whole-request cap. Same reason: the tenth
 * reference should be refused before it is read, not after.
 *
 * Shared by both readers. `loadReference` turns the bytes into a request body and
 * `referenceHashes` turns them into hashes, but the limit is a property of the
 * FILE, so the reader that skips the copy must not also skip the guard.
 *
 * ponytail: a stat is a check, not a lock. A file that grows between the stat and
 * the read is still read whole; the cap that matters for the transport is applied
 * to the bytes in hand below.
 */
async function readReferenceWithinCaps(
  path: string,
  budget: number,
): Promise<{ data: Buffer; format: ImageFormat }> {
  const cap = Math.min(MAX_REFERENCE_BYTES, budget);
  let declared: number | undefined;
  try {
    declared = (await stat(path)).size;
  } catch {
    // Unreadable, missing, or not a file. `readImageFile` reports it properly.
  }
  if (declared !== undefined && declared > cap) {
    throw new ConfigError(
      declared > MAX_REFERENCE_BYTES
        ? `Reference image "${path}" is too large: ${mib(declared)}, cap ${mib(MAX_REFERENCE_BYTES)}.`
        : `Reference images are too large combined: "${path}" is ${mib(declared)} and only ` +
            `${mib(budget)} of the ${mib(MAX_REFERENCE_TOTAL_BYTES)} cap is left.`,
    );
  }

  const read = await readImageFile(path);

  if (read.data.length > cap) {
    throw new ConfigError(
      `Reference image "${path}" is too large: ${mib(read.data.length)}, cap ${mib(MAX_REFERENCE_BYTES)}.`,
    );
  }

  return read;
}

export async function loadReference(
  path: string,
  budget: number = MAX_REFERENCE_TOTAL_BYTES,
): Promise<LoadedReference> {
  const { data, format } = await readReferenceWithinCaps(path, budget);

  return {
    path,
    format,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    dataUrl: `data:${MEDIA_TYPES[format]};base64,${data.toString("base64")}`,
  };
}

/**
 * The digests of a reference set's CONTENTS, and nothing else.
 *
 * `loadReference` builds a base64 data URL for the request body — a second copy of
 * the file, a third longer than the first. A caller that only wants the hashes for a
 * cache key was paying for that copy and throwing it away; `spx sync --check` did it
 * once per reference per asset, on every run, having sent nothing anywhere.
 */
export async function referenceHashes(paths: string[] | undefined): Promise<string[]> {
  if (!paths || paths.length === 0) return [];

  // Same shape and the same caps as `loadReferences`, because the same set of files
  // is being read. Skipping the base64 copy is the optimisation; skipping the guard
  // was not part of it, and `spx sync --check` never reaches `loadReferences`, so
  // this is the only place the limits get applied on that run.
  const hashes: string[] = [];
  let total = 0;
  for (const path of paths) {
    const { data } = await readReferenceWithinCaps(path, MAX_REFERENCE_TOTAL_BYTES - total);
    total += data.length;
    if (total > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ConfigError(
        `Reference images are too large combined: ${mib(total)} across ${hashes.length + 1} files, ` +
          `cap ${mib(MAX_REFERENCE_TOTAL_BYTES)}.`,
      );
    }
    hashes.push(createHash("sha256").update(data).digest("hex"));
  }

  return hashes;
}

export async function loadReferences(paths: string[] | undefined): Promise<LoadedReference[]> {
  if (!paths || paths.length === 0) return [];

  // Sequential on purpose. References are read once per run and the list is short;
  // reading them in parallel would only make the first failure non-deterministic,
  // which is the opposite of what an error message needs.
  const loaded: LoadedReference[] = [];
  let total = 0;
  for (const path of paths) {
    // The running total goes in, so the file that breaks the budget is refused at
    // its own stat rather than after every remaining file has been read and
    // base64-encoded. Ten 4 MiB references used to mean 40 MiB resident before the
    // 32 MiB cap was consulted.
    const reference = await loadReference(path, MAX_REFERENCE_TOTAL_BYTES - total);
    total += reference.bytes;
    if (total > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ConfigError(
        `Reference images are too large combined: ${mib(total)} across ${loaded.length + 1} files, ` +
          `cap ${mib(MAX_REFERENCE_TOTAL_BYTES)}.`,
      );
    }
    loaded.push(reference);
  }

  return loaded;
}
