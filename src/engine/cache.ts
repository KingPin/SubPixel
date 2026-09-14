import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicPublish, atomicWrite } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { STYLE_TEXT_FIELDS } from "../core/types.js";
import type { BackendName, GenerateRequest, ImageArtifact, ImageFormat } from "../core/types.js";
import { writeImage, type WriteImageOptions } from "./output.js";

/**
 * Hash the inputs that change the picture.
 *
 * The driver model is deliberately excluded. It is an implementation detail that
 * rotates whenever OpenAI ships a new model, and including it would invalidate
 * every cached image on the day that happens — costing the user real quota for
 * pictures they already have. The model is recorded in the manifest instead.
 */
export interface CacheKeyInput
  extends Pick<
    GenerateRequest,
    "prompt" | "size" | "quality" | "background" | "format" | "exactSize" | "style" | "transparent"
  > {
  /**
   * sha256 of each reference image's CONTENTS, in the order the user gave them.
   *
   * Deliberately not the paths. A path says where a file was, not what was in it,
   * and the cache exists to answer "have I drawn exactly this before".
   */
  referenceHashes?: string[];
}

export function cacheKey(request: CacheKeyInput): string {
  const hash = createHash("sha256");
  const part = (value: string | undefined) => hash.update(`${value ?? ""}\0`);

  part(request.prompt);
  part(request.size);
  part(request.quality);
  part(request.background);
  part(request.format ?? "png");
  part(request.exactSize);
  // `transparent` changes the PROMPT, so it changes what the backend draws. It
  // therefore belongs in the raw key as well as the derived one — a magenta-backed
  // render is not an alternate encoding of an ordinary render.
  part(request.transparent ? "transparent" : "");
  // Style text goes into the key because it goes into the prompt. Editing a style
  // in the config must invalidate every image that style produced; leaving it out
  // would serve yesterday's look forever.
  for (const field of STYLE_TEXT_FIELDS) {
    part(request.style?.[field]);
  }
  for (const digest of request.referenceHashes ?? []) {
    hash.update(digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function entryPath(stateDir: string, key: string): string {
  return join(stateDir, "cache", `${key}.json`);
}

function blobPath(stateDir: string, digest: string): string {
  // Two-character fan-out keeps directory listings small on a large project.
  return join(stateDir, "blobs", digest.slice(0, 2), digest.slice(2));
}

/**
 * What the index records for a key.
 *
 * The cache owns BYTES, not a path. Pointing an index entry at a file the user
 * owns is what made the previous design wrong in two ways: the user could edit or
 * replace that file and the cache would happily serve the new content for the old
 * prompt, and a hit could only ever be reported at the path it was first written
 * to, so a second run with a different `--output` got the old path back.
 */
export interface CacheEntry {
  sha256: string;
  bytes: number;
  format: ImageFormat;
  /** Where the image was first written. Informational only; never served. */
  firstWrittenTo?: string;
  storedAt: string;
  /**
   * How the bytes were produced. A cache hit still has to write a manifest, and a
   * manifest that says `model: "(cached)"` describes nothing — the point of the
   * sidecar is to tell you what made this picture. Optional because entries written
   * by an older build do not have it; a reader must cope with that rather than
   * invent a model name.
   */
  model?: string;
  backend?: BackendName;
  effectivePrompt?: string;
}

/** The generation facts a manifest needs, carried alongside the bytes. */
export interface CacheProvenance {
  model: string;
  backend: BackendName;
  effectivePrompt: string;
}

/**
 * Return the cached bytes for a key.
 *
 * The blob is verified against the digest in the index on every read. A cache is
 * a correctness-critical store — a silently corrupted blob would be published as a
 * finished asset — and hashing a file that is at most a few megabytes is cheap
 * next to the generation it replaces.
 */
export async function lookupCache(
  stateDir: string,
  key: string,
): Promise<{ entry: CacheEntry; data: Buffer } | undefined> {
  let raw: string;
  try {
    raw = await readFile(entryPath(stateDir, key), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entry = parsed as CacheEntry;
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return undefined;

  let data: Buffer;
  try {
    data = await readFile(blobPath(stateDir, entry.sha256));
  } catch {
    // The blob was pruned or never written. A miss, not an error.
    return undefined;
  }

  if (createHash("sha256").update(data).digest("hex") !== entry.sha256) {
    // Corruption. Drop the index entry so the next run regenerates cleanly instead
    // of hitting the same bad blob forever.
    await rm(entryPath(stateDir, key), { force: true }).catch(() => {});
    return undefined;
  }

  return { entry, data };
}

/**
 * Store the bytes and index them under the request key.
 *
 * Blobs are immutable and content-addressed, so a second store of the same bytes
 * is a no-op and two processes storing concurrently cannot disagree about what a
 * digest means. `atomicPublish` with `overwrite: false` makes the no-op explicit:
 * a refusal means the blob is already there, which is success.
 *
 * `effectivePrompt` is redacted on the way in. It is user text that lands in a
 * long-lived file, and a prompt like "make a diagram of this config: sk-proj-…"
 * would otherwise sit in `~/.local/state/subpixel` in the clear. The logger
 * redactor covers what is printed and the manifest writer covers the sidecar;
 * neither of them sees this file, so the guard has to be here, at the boundary
 * this function owns.
 */
export async function storeCache(
  stateDir: string,
  key: string,
  artifact: Pick<ImageArtifact, "path" | "bytes" | "format" | "sha256">,
  data: Uint8Array,
  provenance?: CacheProvenance,
): Promise<void> {
  await atomicPublish(blobPath(stateDir, artifact.sha256), data, { overwrite: false });

  const entry: CacheEntry = {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    format: artifact.format,
    firstWrittenTo: artifact.path,
    storedAt: new Date().toISOString(),
    ...(provenance && {
      ...provenance,
      effectivePrompt: redact(provenance.effectivePrompt),
    }),
  };
  await atomicWrite(entryPath(stateDir, key), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Realise a cache hit at the destination THIS run asked for.
 *
 * A hit must still produce the file the user requested. Returning the path the
 * image was first written to means `spx "a fox" -o a.png` followed by
 * `spx "a fox" -o b.png` reports success and never creates `b.png`, and a build
 * step that deleted its output directory gets a path that no longer exists.
 *
 * It goes through `writeImage`, so a hit obeys exactly the same rules as a fresh
 * generation: format sniffed from the bytes, no clobber, sibling on collision.
 */
export async function materialiseFromCache(
  hit: { entry: CacheEntry; data: Buffer },
  destination: string,
  options: WriteImageOptions = {},
): Promise<ImageArtifact> {
  return writeImage(destination, hit.data, options);
}
