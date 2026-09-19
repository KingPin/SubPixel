import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { SubpixelConfig } from "../config/schema.js";
import { ConfigError, withDetails } from "../core/errors.js";
import type { EventSink } from "../core/events.js";
import { within } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { IMAGE_BACKGROUNDS, IMAGE_FORMATS, IMAGE_QUALITIES } from "../core/types.js";
import type {
  GenerateRequest,
  ImageBackground,
  ImageFormat,
  ImageQuality,
  StyleDefinition,
} from "../core/types.js";
import { ASSETS_FILENAME, loadAssets } from "../assets/load.js";
import { syncAssets } from "../assets/sync.js";
import { collectDoctorReport, publicDoctorReport } from "../cli/doctor.js";
import { buildEditRequest } from "../cli/edit.js";
import {
  resolveGenerateDeps,
  resolveSharedFields,
  type SharedCliOptions,
} from "../cli/generate.js";
import { collectModelReport } from "../cli/models.js";
import { parseBackend } from "../cli/options.js";
import { checkAssets } from "../cli/sync.js";
import { collectStyleReport, resolveStyle } from "../cli/styles.js";
import { toJsonResult } from "../engine/emit.js";
import { generate, type ProviderFn } from "../engine/generate.js";
import { planGenerate } from "../engine/plan.js";
import { jobsDirFor, readJob } from "./jobs.js";

/**
 * The subset of JSON Schema these tool definitions use.
 *
 * A hand-rolled subset rather than a validator dependency: the schemas below are
 * flat objects of scalars and arrays of scalars, and `validateArgs` is shorter than
 * the wiring any library would need. If a schema ever grows a nested object, add the
 * case there rather than growing this type sideways.
 */
export interface PropertySchema {
  type: "string" | "integer" | "number" | "boolean" | "array";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  items?: { type: "string" | "integer"; minimum?: number };
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolSchema;
  /** True when the tool cannot spend quota and cannot write a file. */
  readOnly: boolean;
}

/**
 * `api` is deliberately absent.
 *
 * The paid OpenAI backend spends money from a different purse than the ChatGPT
 * subscription, and a host picking a backend from a dropdown has no way to know
 * that. No provider implements it yet either, so the value would only ever
 * resolve to an error.
 */
const BACKEND_VALUES = ["codex-http", "codex-exec", "auto"] as const;

const BACKEND: PropertySchema = {
  type: "string",
  description: "Which driver to use. Defaults to the project config, else auto.",
  enum: BACKEND_VALUES,
};

const STYLE: PropertySchema = {
  type: "string",
  description: "Name of a style defined in the project config. See list_styles.",
};

/** The knobs generate_image and edit_image share, in the same order and wording. */
const IMAGE_PROPERTIES: Record<string, PropertySchema> = {
  size: {
    type: "string",
    description: "Requested generation size, e.g. 1024x1536. Best effort: the model may return another size.",
  },
  quality: {
    type: "string",
    description: "Rendering effort. Best effort.",
    enum: IMAGE_QUALITIES,
  },
  background: {
    type: "string",
    description: "Background handling. Best effort.",
    enum: IMAGE_BACKGROUNDS,
  },
  format: {
    type: "string",
    description: "Output file format. Defaults to the project config, else png.",
    enum: IMAGE_FORMATS,
  },
  exact_size: {
    type: "string",
    description: "Post-process the result to exactly this size, e.g. 512x512. Requires sharp.",
  },
  transparent: {
    type: "boolean",
    description: "Generate against a key colour and remove it, giving a real alpha channel.",
  },
  variants: {
    type: "array",
    description: "Extra widths to write beside the result, e.g. [400, 800]. Widths above the source are skipped.",
    items: { type: "integer", minimum: 1 },
  },
  style: STYLE,
  model: {
    type: "string",
    description: "Pin a driver model slug instead of the resolved default. See list_models.",
  },
  out: {
    type: "string",
    description: "Write to this exact path.",
  },
  out_dir: {
    type: "string",
    description: "Directory for the result. Defaults to the project config, else the working directory.",
  },
  backend: BACKEND,
  n: {
    type: "integer",
    description: "Number of images. Only 1 is accepted here: every image costs subscription quota.",
    minimum: 1,
    maximum: 1,
  },
  no_cache: {
    type: "boolean",
    description:
      "Skip the cache lookup and draw this request again. THIS SPENDS QUOTA every time, " +
      "including for a request that has already been drawn. Use it when you want a different " +
      "result for the same prompt, not as a retry: a call that failed has no cache entry to skip. " +
      "It does not overwrite anything - a second image is written beside the first as a -v2 sibling.",
  },
  dry_run: {
    type: "boolean",
    description:
      "Report what this call would do - driver model, backend chain, effective prompt, cache key, " +
      "output directory - and stop. Makes no network call and spends no quota. A preview is not a " +
      "reservation: nothing is held, and the cache can change before the real call.",
  },
};

/**
 * The line the spec calls the most important one in the schema.
 *
 * A host that retries a slow call buys the image twice. There is no refund and no
 * way to detect it after the fact, so the instruction is stated before anything
 * else the description says.
 */
const LONG_OPERATION =
  "This can take up to 6 minutes on the codex-exec backend, and about 30 seconds on codex-http. " +
  "If the result says status=running, poll get_image_job with the job_id. Do not retry this call: " +
  "a retry spends quota a second time. A job lives only as long as the server process that started it.";

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "generate_image",
    title: "Generate an image",
    description: `Generate an image from a text prompt using the signed-in ChatGPT subscription. ${LONG_OPERATION}`,
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw." },
        reference_images: {
          type: "array",
          description:
            "Paths to images that guide the result. This is reference-guided generation, not in-place pixel editing.",
          items: { type: "string" },
        },
        ...IMAGE_PROPERTIES,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_image",
    title: "Edit an image",
    description:
      `Re-generate an existing image against an instruction. The source image is a reference, so the result ` +
      `is a new image in the same spirit, not the original with pixels changed. ${LONG_OPERATION}`,
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Path to the image to edit." },
        instruction: { type: "string", description: "What to change." },
        ...IMAGE_PROPERTIES,
      },
      required: ["image", "instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "list_styles",
    title: "List styles",
    description:
      "List the named styles defined in the project config, with the prompt block each one contributes. " +
      "Makes no network call and spends no quota.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Show only this style." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    title: "List driver models",
    description:
      "List the driver models subpixel will try, in order, and which one is selected. " +
      "Makes no network call and spends no quota.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Show the effect of pinning this model slug." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sync_assets",
    title: "Sync declared assets",
    description:
      `Generate the assets declared in assets.yml that are missing or out of date. ` +
      `With check=true it only reports drift: no network call, no quota. ` +
      `With check=false it generates, once per drifted asset. ${LONG_OPERATION}`,
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the manifest. Defaults to assets.yml." },
        check: {
          type: "boolean",
          description: "Report drift and stop. Makes no network call and spends no quota.",
        },
        force: { type: "boolean", description: "Regenerate every asset, not only the drifted ones." },
        backend: BACKEND,
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_image_job",
    title: "Get image job",
    description:
      "Read the status of a job started by generate_image, edit_image, or sync_assets. " +
      "Status is running, done, or failed. Poll this instead of retrying the original call.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id returned by the original call." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "doctor",
    title: "Check the setup",
    description:
      "Report credentials, driver model, quota, and optional dependencies. " +
      "Run this first when a generation fails. Makes no network call and spends no quota.",
    readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function toolNamed(name: string): ToolDefinition {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new ConfigError(`Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
  return tool;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function checkScalar(key: string, schema: PropertySchema | { type: string; minimum?: number }, value: unknown): void {
  const expected = schema.type;
  if (expected === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ConfigError(`"${key}" must be a whole number, received ${typeOf(value)}.`);
    }
  } else if (expected === "array") {
    if (!Array.isArray(value)) throw new ConfigError(`"${key}" must be an array, received ${typeOf(value)}.`);
  } else if (typeOf(value) !== expected) {
    throw new ConfigError(`"${key}" must be a ${expected}, received ${typeOf(value)}.`);
  }

  const bounded = schema as PropertySchema;
  if (bounded.minimum !== undefined && typeof value === "number" && value < bounded.minimum) {
    throw new ConfigError(`"${key}" must be at least ${bounded.minimum}, received ${value}.`);
  }
  if (bounded.maximum !== undefined && typeof value === "number" && value > bounded.maximum) {
    throw new ConfigError(`"${key}" must be at most ${bounded.maximum}, received ${value}.`);
  }
  if (bounded.enum && typeof value === "string" && !bounded.enum.includes(value)) {
    throw new ConfigError(`"${key}" must be one of ${bounded.enum.join(", ")}, received "${value}".`);
  }
}

/**
 * Validate arguments against a tool's schema, and return them typed as a bag.
 *
 * Hosts vary in how much of an `inputSchema` they enforce before the call arrives,
 * and some enforce none of it. The server therefore treats every argument object as
 * untrusted input, which is also what makes `api` genuinely unreachable rather than
 * merely absent from a dropdown.
 */
export function validateArgs(name: string, args: unknown): Record<string, unknown> {
  const { inputSchema } = toolNamed(name);
  if (args === undefined || args === null) return validateArgs(name, {});
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ConfigError(`${name} expects an object of arguments, received ${typeOf(args)}.`);
  }

  const bag = args as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    // hasOwn, not `in`. `"constructor" in {}` is true, and so is `toString`,
    // `__proto__` and the rest of Object.prototype, so `in` let a whole set of
    // names through the one gate whose job is to reject names the tool does not
    // declare. JSON.parse puts `__proto__` on the object as an own property, so
    // that one arrives from the wire.
    if (!Object.hasOwn(inputSchema.properties, key)) {
      const known = Object.keys(inputSchema.properties).sort().join(", ");
      throw new ConfigError(`${name} has no argument "${key}". Accepted: ${known || "none"}.`);
    }
  }
  for (const key of inputSchema.required ?? []) {
    if (bag[key] === undefined) throw new ConfigError(`${name} requires "${key}".`);
  }

  for (const [key, schema] of Object.entries(inputSchema.properties)) {
    const value = bag[key];
    if (value === undefined) continue;
    checkScalar(key, schema, value);
    if (schema.type === "array" && schema.items) {
      for (const [index, item] of (value as unknown[]).entries()) {
        checkScalar(`${key}[${index}]`, schema.items, item);
      }
    }
  }
  return bag;
}

export interface ToolDeps {
  /** The project directory. Defaults to the process working directory. */
  cwd?: string;
  /** Where job records live. Defaults to `<cwd>/.subpixel/jobs`. */
  jobsDir?: string;
  /**
   * Progress, forwarded straight to the engine.
   *
   * Set only on the streaming path, where the host gave a `progressToken`. On the
   * job path it is absent, because there is no request left to attach a
   * notification to once the `job_id` has been returned.
   */
  onEvent?: EventSink;
  /** The backend, for tests. Absent means the real resolver chain. */
  provider?: ProviderFn;
}

type Handler = (args: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;

function cwdOf(deps: ToolDeps): string {
  return deps.cwd ?? process.cwd();
}

/**
 * The tools this build can run.
 *
 * Every entry returns the object the matching `--json` command prints, unchanged.
 * A second shape for the same facts is a second thing to keep true, and the CLI
 * reference already documents these.
 */
/**
 * Translate the tool's snake_case arguments into the flags the CLI resolver takes.
 *
 * Both paths then run the SAME resolution — `resolveSharedFields` for the request
 * and `resolveGenerateDeps` for the dependencies — so a flag cannot mean one thing
 * typed at a shell and another sent by an agent.
 *
 * Paths are resolved here against the project directory. The CLI builders resolve
 * relative paths against `process.cwd()`, which is the shell the user typed in; an
 * MCP server has no such shell, and resolving twice is harmless because the second
 * resolve is handed an absolute path.
 *
 * They are also CONFINED to it. A shell path is typed by the person who owns the
 * shell; these are composed by a model from whatever is in its context — a web page,
 * an issue body, a file it was asked to summarise. `../../.ssh/config` was a
 * perfectly good out_dir, and `out` names a file the run then writes. The same rule
 * assets.yml has applied all along, for the same reason.
 */
function sharedOptionsFrom(args: Record<string, unknown>, cwd: string): SharedCliOptions {
  const out = args.out as string | undefined;
  const outDir = args.out_dir as string | undefined;
  const variants = args.variants as number[] | undefined;
  return {
    size: args.size as string | undefined,
    quality: args.quality as ImageQuality | undefined,
    background: args.background as ImageBackground | undefined,
    format: args.format as ImageFormat | undefined,
    exactSize: args.exact_size as string | undefined,
    model: args.model as string | undefined,
    style: args.style as string | undefined,
    out: out === undefined ? undefined : within(cwd, out, "out"),
    outDir: outDir === undefined ? undefined : within(cwd, outDir, "out_dir"),
    backend: args.backend as string | undefined,
    transparent: args.transparent as boolean | undefined,
    // `cache`, not `noCache`: the CLI field is named for commander's `--no-cache`,
    // which sets `cache: false`. `undefined` and not `true` in the default case, so
    // an absent argument leaves the project config's answer alone.
    cache: args.no_cache === true ? false : undefined,
    dryRun: args.dry_run as boolean | undefined,
    // The CLI takes "400,800" from a shell that has no arrays. The schema takes the
    // array an agent can actually build, and the one parser stays the CLI's.
    variants: variants === undefined ? undefined : variants.join(","),
  };
}

/**
 * The shared half of `generate_image` and `edit_image`: everything after the
 * request has been built.
 *
 * `n` is never read. The schema caps it at 1, and the identical-retry guarantee in
 * the spec holds only while a call buys at most one image.
 */
async function runImageTool(
  args: Record<string, unknown>,
  deps: ToolDeps,
  build: (
    options: SharedCliOptions,
    style: StyleDefinition | undefined,
    config: SubpixelConfig,
    cwd: string,
  ) => GenerateRequest,
): Promise<unknown> {
  const cwd = cwdOf(deps);
  const { config } = await loadConfig({ cwd });
  const options = sharedOptionsFrom(args, cwd);
  const style = resolveStyle(config, options.style ?? config.style);
  const request = build(options, style, config, cwd);

  // The budget lives in here, which is the reason the helper exists: a handler that
  // called `generate()` with hand-built dependencies would spend past the project's
  // own `budget.maxImagesPerRun`.
  const generateDeps = resolveGenerateDeps(request, { ...options, config, cwd });

  // Before `generate` is named, and handed none of `deps`. `planGenerate` takes no
  // provider and has no argument that could carry one, so the zero-quota promise in
  // the schema is a property of the code rather than of this branch being correct.
  if (options.dryRun === true) {
    return planGenerate(request, {
      outDir: generateDeps.outDir,
      backend: generateDeps.backend,
      model: options.model,
      noCache: generateDeps.noCache,
      overwrite: generateDeps.overwrite,
    });
  }

  const result = await generate(request, {
    ...generateDeps,
    provider: deps.provider,
    onEvent: deps.onEvent,
    // No logger and no `warnAlways`. The engine falls back to a silent logger, and
    // every other writer in this process would be writing to the transport.
  });
  return toJsonResult(result, cwd);
}

export const HANDLERS: Record<string, Handler> = {
  generate_image: async (args, deps) =>
    runImageTool(args, deps, (options, style, config, cwd) => ({
      prompt: args.prompt as string,
      outputPath: options.out,
      referenceImages: (args.reference_images as string[] | undefined)?.map((path) =>
        within(cwd, path, "reference_images"),
      ),
      ...resolveSharedFields(options, style, config),
    })),
  edit_image: async (args, deps) =>
    runImageTool(args, deps, (options, style, config, cwd) =>
      buildEditRequest(
        within(cwd, args.image as string, "image"),
        args.instruction as string,
        options,
        style,
        config,
      ),
    ),
  sync_assets: async (args, deps) => {
    const cwd = cwdOf(deps);
    const check = args.check === true;
    const force = args.force === true;
    if (check && force) {
      throw new ConfigError("check reports drift and force regenerates. Pass one or the other.");
    }

    // Warnings from the manifest loader go nowhere on purpose. The only two streams
    // here are the transport and stderr, and a host shows neither to the model.
    const loaded = await loadAssets(
      within(cwd, (args.file as string | undefined) ?? ASSETS_FILENAME, "file"),
      () => {},
    );

    // `checkAssets` and not `syncAssets({check})`: the zero-quota guarantee is that
    // this path is handed no provider and no generation dependencies at all, rather
    // than being handed them and asked not to use them.
    if (check) {
      const statuses = await checkAssets(loaded);
      return { drift: statuses.some((status) => status.state !== "current"), statuses };
    }

    // Drift is reported, never thrown. An agent that asked what is out of date has
    // been answered, and `drift: true` is the answer, not a failure.
    const { failure, ...report } = await syncAssets(loaded, {
      force,
      ...(parseBackend(args.backend as string | undefined)
        ? { backend: parseBackend(args.backend as string | undefined)! }
        : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    });

    // `syncAssets` returns this rather than throwing so the CLI can print the report
    // and THEN exit non-zero. MCP has no such two-step: a result without `isError`
    // is a success, and swallowing the failure told the host every asset was fine
    // while handing it a report full of them. The taxonomy code is the half the
    // model acts on — `AUTH_EXPIRED` means run doctor, `RATE_LIMITED` means wait —
    // and `failures` inside the report carries the per-asset detail regardless.
    //
    // The report rides along. Throwing it away told an agent "the sync failed" and
    // nothing else, so its only move was to run the whole thing again — re-billing
    // every asset that had already succeeded before the failure landed.
    if (failure !== undefined) throw withDetails(failure, report);
    return report;
  },
  list_styles: async (args, deps) => {
    const { config } = await loadConfig({ cwd: cwdOf(deps) });
    return collectStyleReport(config, args.name as string | undefined);
  },
  list_models: async (args) => collectModelReport({ override: args.model as string | undefined }),
  doctor: async (_args, deps) => publicDoctorReport(await collectDoctorReport({ cwd: cwdOf(deps) })),
  get_image_job: async (args, deps) => {
    const id = args.job_id as string;
    const record = await readJob(deps.jobsDir ?? jobsDirFor(join(cwdOf(deps), ".subpixel")), id);
    if (!record) {
      throw new ConfigError(
        `No job "${id}". A job record is kept only by the server process that created it, ` +
          `and that process has restarted or the id is wrong.`,
      );
    }
    return record;
  },
};

/**
 * Validate, run, and mask.
 *
 * Redaction runs once here, over the serialised result, whichever handler produced
 * it. Doing it per handler is a list that goes stale the moment a report grows a
 * field, and the mask contains no quote or backslash, so the document survives the
 * round trip.
 */
export async function callTool(name: string, args: unknown, deps: ToolDeps = {}): Promise<unknown> {
  const bag = validateArgs(name, args);
  const handler = HANDLERS[name];
  if (!handler) {
    throw new ConfigError(`Tool "${name}" is declared but not available in this build.`);
  }
  return JSON.parse(redact(JSON.stringify(await handler(bag, deps)))) as unknown;
}
