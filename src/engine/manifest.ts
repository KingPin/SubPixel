import { readFile } from "node:fs/promises";
import { atomicWrite } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import type { BackendName, ImageFormat, VariantRecord } from "../core/types.js";

export interface ManifestEntry {
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
}

export function manifestPathFor(imagePath: string): string {
  return `${imagePath}.json`;
}

/**
 * Write the sidecar manifest.
 *
 * Every string field passes through redact(), because a user prompt can contain
 * anything — including a key someone pasted by accident.
 */
export async function writeManifest(imagePath: string, entry: ManifestEntry): Promise<void> {
  const record: ManifestEntry = {
    ...entry,
    prompt: redact(entry.prompt),
    effectivePrompt: redact(entry.effectivePrompt),
    generatedAt: entry.generatedAt ?? new Date().toISOString(),
  };
  await atomicWrite(manifestPathFor(imagePath), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readManifest(imagePath: string): Promise<ManifestEntry | undefined> {
  try {
    return JSON.parse(await readFile(manifestPathFor(imagePath), "utf8")) as ManifestEntry;
  } catch {
    return undefined;
  }
}
