import { join, resolve } from "node:path";
import { createLogger, type LogLevel } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { GenerateRequest, ImageBackground, ImageFormat, ImageQuality } from "../core/types.js";
import { generate } from "../engine/generate.js";

export interface GenerateCliOptions {
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  format?: ImageFormat;
  exactSize?: string;
  model?: string;
  out?: string;
  outDir?: string;
  n?: string;
  json?: boolean;
  /**
   * Commander's `--no-cache` sets `cache: false`, NOT `noCache: true`. Naming the
   * field for the negated flag is a silent no-op, so the field is named `cache`.
   */
  cache?: boolean;
  /**
   * `--overwrite` / `--no-overwrite`. Defaults to false: the spec says never
   * overwrite without being told to, and a sibling is written instead.
   */
  overwrite?: boolean;
  timeout?: string;
  verbose?: boolean;
  quiet?: boolean;
}

export function logLevelFor(options: GenerateCliOptions): LogLevel {
  if (options.quiet) return "error";
  if (options.verbose) return "debug";
  return "info";
}

export async function runGenerate(prompt: string, options: GenerateCliOptions): Promise<void> {
  const outDir = resolve(options.outDir ?? process.cwd());
  const stateDir = join(process.cwd(), ".subpixel");

  const request: GenerateRequest = {
    prompt,
    size: options.size,
    quality: options.quality,
    background: options.background,
    format: options.format,
    exactSize: options.exactSize,
    model: options.model,
    outputPath: options.out ? resolve(options.out) : undefined,
    n: options.n ? Number(options.n) : undefined,
  };

  const result = await generate(request, {
    outDir,
    stateDir,
    noCache: options.cache === false,
    overwrite: options.overwrite === true,
    timeoutMs: options.timeout ? Number(options.timeout) * 1000 : undefined,
    logger: createLogger({ level: logLevelFor(options) }),
    // Format mismatches and sibling redirects survive --quiet, per the spec's
    // "never lie about bytes" rule. They bypass the level-filtered logger.
    warnAlways: (message) => process.stderr.write(`warning: ${message}\n`),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const image of result.images) {
    process.stdout.write(`${image.path}\n`);
  }
}
