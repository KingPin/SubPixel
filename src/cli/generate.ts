import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../core/errors.js";
import { describeEvent, type EventSink } from "../core/events.js";
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
import { emit, type EmitFormat } from "../engine/emit.js";
import { generate, type GenerateDeps } from "../engine/generate.js";
import { planGenerate } from "../engine/plan.js";
import { parseBackend, parseCount, parseSeconds } from "./options.js";
import { parseVariants } from "../engine/variants.js";
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
   * Serve only from the cache, and exit 7 rather than spend. For CI, where the
   * question is "is this image already paid for" and the wrong answer is a charge.
   */
  cacheOnly?: boolean;
  /**
   * `--overwrite` / `--no-overwrite`. Defaults to false: the spec says never
   * overwrite without being told to, and a sibling is written instead.
   */
  overwrite?: boolean;
  timeout?: string;
  stallTimeout?: string;
  concurrency?: string;
  backend?: string;
  /** Sugar for `--no-cache --overwrite`. The only place the two are combined. */
  force?: boolean;
  /** Print the resolved plan and stop, without a network call or a byte written. */
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  transparent?: boolean;
  variants?: string;
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
  const inherited = options.format ?? style?.format ?? config.format;
  const transparent = options.transparent === true;

  // JPEG has no alpha channel. Producing one anyway would flatten the transparency
  // onto black and hand the user a file that looks like the feature failed. Only an
  // EXPLICIT --format jpeg is an error: a jpeg inherited from a style or the project
  // config is a default for ordinary images, and refusing it would make
  // `spx generate --transparent` unusable in any project whose config says jpeg.
  // Checked here, so `generate` and `edit` refuse it identically.
  if (transparent && options.format === "jpeg") {
    throw new ConfigError(
      "--transparent cannot produce JPEG, which has no alpha channel. Use png or webp.",
    );
  }

  // An inherited jpeg — or no format at all — becomes png, which is what the CLI
  // reference promises. webp is left alone: it carries alpha too.
  const format = transparent && (inherited === undefined || inherited === "jpeg") ? "png" : inherited;

  return {
    size: options.size ?? style?.size,
    quality: options.quality ?? style?.quality,
    background: options.background ?? style?.background,
    format,
    exactSize: options.exactSize,
    model: options.model,
    transparent,
    variants: parseVariants(options.variants),
    style,
  };
}

export interface GenerateCliOptions extends SharedCliOptions {
  n?: string;
  emit?: EmitFormat;
}

export function logLevelFor(options: { quiet?: boolean; verbose?: boolean }): LogLevel {
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
 * Turn CLI options and the project config into engine dependencies, writing nothing.
 *
 * The MCP handlers call this too, which is the reason it is separate from
 * `runGenerateRequest`. Reusing that function whole is not an option: it writes the
 * result to stdout, and stdout is the MCP transport. Splitting it here also keeps
 * `budget.maxImagesPerRun` on both paths — the budget is enforced above the engine,
 * so a handler that called `generate()` directly would spend past the project's own
 * limit.
 */
export function resolveGenerateDeps(
  request: GenerateRequest,
  options: SharedCliOptions & { config: SubpixelConfig; cwd?: string },
): GenerateDeps {
  const { config } = options;
  const cwd = options.cwd ?? process.cwd();

  // The precedence rule, in one place: a flag the user typed beats the project's
  // config, and the config beats the built-in default. Commander gives `--out-dir`
  // a default of process.cwd(), which would otherwise outrank the config and make
  // the setting dead on arrival, so the default is declared here instead.
  const outDir = resolve(cwd, options.outDir ?? config.outDir ?? cwd);
  const stateDir = join(cwd, ".subpixel");

  const backend = parseBackend(options.backend ?? config.backend);

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
  const cacheOnly = options.cacheOnly === true;

  return {
    outDir,
    stateDir,
    backend,
    noCache,
    cacheOnly,
    overwrite,
    concurrency,
    stallMs,
    timeoutMs,
  };
}

/**
 * Run an already-built request: budget, dry-run, generate, report.
 *
 * Shared by `generate` and `edit`. The two commands differ only in how the request
 * is built; everything after that is identical, and a second copy of it is a second
 * place for `--dry-run` or the budget check to go missing.
 */
/**
 * Progress on stderr while the run is in flight.
 *
 * stderr, never stdout: stdout carries the artifact path or a single JSON
 * document, and a caller piping it into a build step must not receive status
 * lines interleaved with it.
 *
 * On a terminal the line rewrites itself in place and is erased before the result
 * is printed, so the transcript ends with the artifact and nothing else. Anywhere
 * else — a CI log, a pipe — each event is its own line, because \r in a log file
 * produces one unreadable run-on line.
 *
 * Elapsed time is the point of the whole thing. A generation takes tens of
 * seconds with no output of any kind, which is indistinguishable from a hang.
 */
function progressWriter(): { onEvent: EventSink; clear: () => void } {
  const started = Date.now();
  const tty = process.stderr.isTTY === true;
  let dirty = false;
  return {
    onEvent: (event) => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const line = `${describeEvent(event)} (${elapsed}s)`;
      if (!tty) {
        process.stderr.write(`${line}\n`);
        return;
      }
      // Erase the whole line first: a shorter message must not leave the tail of a
      // longer one behind it.
      process.stderr.write(`\u001b[2K\r${line}`);
      dirty = true;
    },
    clear: () => {
      if (dirty) process.stderr.write("\u001b[2K\r");
      dirty = false;
    },
  };
}

export async function runGenerateRequest(
  request: GenerateRequest,
  options: GenerateCliOptions & { config: SubpixelConfig },
): Promise<void> {
  const deps = resolveGenerateDeps(request, options);
  const { outDir, backend, noCache, cacheOnly, overwrite } = deps;

  if (options.dryRun) {
    // The WHOLE document, not just the prompt. `outDir` and every reference path is
    // a string the user composed, and a credential pasted into one of them would
    // otherwise go straight to stdout. Same rule as `emitSync`: redacting the
    // serialised document redacts every field there will ever be.
    process.stdout.write(
      redact(
        `${JSON.stringify(
          await planGenerate(request, {
            outDir,
            backend,
            model: options.model,
            noCache,
            cacheOnly,
            overwrite,
          }),
          null,
          2,
        )}\n`,
      ),
    );
    return;
  }

  // --quiet silences progress. Unlike the format and redirect warnings below, a
  // stage line states nothing about the bytes that were written, so there is
  // nothing here the spec's "never lie about bytes" rule protects.
  const progress = options.quiet ? undefined : progressWriter();
  let result;
  try {
    result = await generate(request, {
      ...deps,
      logger: createLogger({ level: logLevelFor(options) }),
      // Format mismatches and sibling redirects survive --quiet, per the spec's
      // "never lie about bytes" rule. They bypass the level-filtered logger.
      warnAlways: (message) => {
        progress?.clear();
        process.stderr.write(`warning: ${message}\n`);
      },
      onEvent: progress?.onEvent,
    });
  } finally {
    // In a finally, so a failed run does not leave a half-written status line as
    // the last thing on the terminal before the error.
    progress?.clear();
  }

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
