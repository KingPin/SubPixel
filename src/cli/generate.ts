import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../core/errors.js";
import { createLogger, type LogLevel } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type {
  GenerateRequest,
  ImageBackground,
  ImageFormat,
  ImageQuality,
  StyleDefinition,
} from "../core/types.js";
import type { SubpixelConfig } from "../config/schema.js";
import { cacheKey } from "../engine/cache.js";
import { emit, type EmitFormat } from "../engine/emit.js";
import { generate } from "../engine/generate.js";
import { augmentPrompt } from "../engine/prompt.js";
import { hasCodexBinary } from "../providers/codex-exec.js";
import { resolveModel } from "../providers/models.js";
import { resolveChain } from "../providers/resolve.js";
import { parseBackend, parseCount, parseSeconds } from "./options.js";
import { resolveStyle } from "./styles.js";

/**
 * The flags `generate` and `edit` share.
 *
 * Declared once so the two commands cannot drift. Anything both commands accept
 * belongs here, and anything here is resolved by `resolveSharedFields`.
 */
export interface SharedCliOptions {
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  format?: ImageFormat;
  exactSize?: string;
  model?: string;
  /** The named style to apply, from the project config. */
  style?: string;
  out?: string;
  outDir?: string;
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
  stallTimeout?: string;
  concurrency?: string;
  backend?: string;
  allowPaid?: boolean;
  /** Sugar for `--no-cache --overwrite`. The only place the two are combined. */
  force?: boolean;
  /** Print the resolved plan and stop, without a network call or a byte written. */
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  /** Reference images, in the order the user gave them. */
  image?: string[];
}

/**
 * Resolve every request field the CLI shares between `generate` and `edit`.
 *
 * Precedence is the spec's, and it is the same in both commands: flag > style >
 * config > built-in. Anything added to a shared request belongs HERE — adding it to
 * `runGenerate`'s literal alone is how `spx edit --transparent` ends up parsing the
 * flag, printing no error, and producing an opaque image.
 */
export function resolveSharedFields(
  options: SharedCliOptions,
  style: StyleDefinition | undefined,
  config: SubpixelConfig,
): Omit<GenerateRequest, "prompt" | "outputPath"> {
  return {
    size: options.size ?? style?.size,
    quality: options.quality ?? style?.quality,
    background: options.background ?? style?.background,
    format: options.format ?? style?.format ?? config.format,
    exactSize: options.exactSize,
    model: options.model,
    style,
  };
}

export interface GenerateCliOptions extends SharedCliOptions {
  n?: string;
  emit?: EmitFormat;
}

export function logLevelFor(options: SharedCliOptions): LogLevel {
  if (options.quiet) return "error";
  if (options.verbose) return "debug";
  return "info";
}

export async function runGenerate(prompt: string, options: GenerateCliOptions): Promise<void> {
  const warn = (message: string) => process.stderr.write(`warning: ${message}\n`);
  const { config } = await loadConfig({ warn });
  const style = resolveStyle(config, options.style ?? config.style);

  const request: GenerateRequest = {
    prompt,
    outputPath: options.out ? resolve(options.out) : undefined,
    n: parseCount(options.n, "-n"),
    referenceImages: options.image,
    ...resolveSharedFields(options, style, config),
  };

  await runGenerateRequest(request, { ...options, config });
}

/**
 * Run an already-built request: budget, dry-run, generate, report.
 *
 * Shared by `generate` and `edit`. The two commands differ only in how the request
 * is built; everything after that is identical, and a second copy of it is a second
 * place for `--dry-run` or the budget check to go missing.
 */
export async function runGenerateRequest(
  request: GenerateRequest,
  options: GenerateCliOptions & { config: SubpixelConfig },
): Promise<void> {
  const { config } = options;

  // The precedence rule, in one place: a flag the user typed beats the project's
  // config, and the config beats the built-in default. Commander gives `--out-dir`
  // a default of process.cwd(), which would otherwise outrank the config and make
  // the setting dead on arrival, so the default is declared here instead.
  const outDir = resolve(options.outDir ?? config.outDir ?? process.cwd());
  const stateDir = join(process.cwd(), ".subpixel");

  const backend = parseBackend(options.backend ?? config.backend);
  const allowPaid = options.allowPaid ?? config.allowPaid;

  // Every numeric flag is parsed HERE, above the --dry-run branch, not at the
  // generate() call below it. --dry-run exists to validate the plan before any
  // quota is spent, so a flag that would abort the real run has to abort the
  // rehearsal too; parsing them inside the call site made --dry-run report a
  // clean plan for `--timeout soon`.
  const concurrency = parseCount(options.concurrency, "--concurrency") ?? config.concurrency;
  const stallMs = parseSeconds(options.stallTimeout, "--stall-timeout");
  const timeoutMs = parseSeconds(options.timeout, "--timeout");

  // A budget is a spending limit, so it is checked before anything is spent and it
  // refuses rather than silently clamping. Clamping would hand the user four images
  // when they asked for ten and said nothing about which four.
  const maxImages = config.budget?.maxImagesPerRun;
  if (maxImages !== undefined && (request.n ?? 1) > maxImages) {
    throw new ConfigError(
      `-n ${request.n} exceeds budget.maxImagesPerRun (${maxImages}) set in the project config.`,
    );
  }

  // --force is the one place the two independent decisions are combined, and it
  // says so in its own help text. Everywhere else, bypassing the cache and
  // replacing a file on disk stay separate: --no-cache still refuses to clobber,
  // and --overwrite still serves a cache hit.
  const noCache = options.force === true || options.cache === false;
  const overwrite = options.force === true || options.overwrite === true;

  if (options.dryRun) {
    const resolved = await resolveModel({ override: options.model });
    const chain = resolveChain({
      hasCodexBinary: await hasCodexBinary(),
      requested: backend,
      allowPaid,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          chain,
          model: resolved.slug,
          modelSource: resolved.source,
          // --dry-run is the one path that prints the prompt verbatim, and it is
          // the path people reach for when something looks wrong — often with the
          // config that broke it pasted into the prompt. Same door as `alt` in
          // `toJsonResult` and `effectivePrompt` in `storeCache`; same mask.
          effectivePrompt: redact(augmentPrompt(request.prompt, request)),
          outDir,
          cacheKey: cacheKey(request),
          ...(request.referenceImages && { referenceImages: request.referenceImages }),
          // Printed so --force can be verified without spending anything.
          noCache,
          overwrite,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const result = await generate(request, {
    outDir,
    stateDir,
    backend,
    allowPaid,
    noCache,
    overwrite,
    concurrency,
    stallMs,
    timeoutMs,
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
