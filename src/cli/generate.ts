import { join, resolve } from "node:path";
import { createLogger, type LogLevel } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { GenerateRequest, ImageBackground, ImageFormat, ImageQuality } from "../core/types.js";
import { emit, type EmitFormat } from "../engine/emit.js";
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
  emit?: EmitFormat;
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
  concurrency?: string;
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
    concurrency: options.concurrency ? Number(options.concurrency) : undefined,
    logger: createLogger({ level: logLevelFor(options) }),
    // Format mismatches and sibling redirects survive --quiet, per the spec's
    // "never lie about bytes" rule. They bypass the level-filtered logger.
    warnAlways: (message) => process.stderr.write(`warning: ${message}\n`),
  });

  // Paths first, unconditionally. They are the artifact, and the spec says stdout
  // carries the artifact path and nothing else. A caller piping stdout into a
  // build step gets what did succeed even when the batch was partial.
  const format: EmitFormat = options.json ? "json" : (options.emit ?? "path");
  process.stdout.write(`${emit(result, process.cwd(), format)}\n`);

  if (result.failures && result.failures.length > 0) {
    for (const failure of result.failures) {
      process.stderr.write(
        `error: image ${failure.index + 1} of ${result.requested} failed: ${failure.message}\n`,
      );
    }
    const missing = result.requested - result.images.length;
    process.stderr.write(
      `error: produced ${result.images.length} of ${result.requested} images (${missing} missing)\n`,
    );
    // process.exitCode, never process.exit. process.exit tears the process down at
    // once, which can cut off a write that is still flushing and would abandon any
    // work still settling. Setting the code lets the process end normally.
    process.exitCode = 1;
  }
}
