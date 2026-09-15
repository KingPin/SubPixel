import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import { collectDoctorReport } from "../cli/doctor.js";
import { collectModelReport } from "../cli/models.js";
import { collectStyleReport } from "../cli/styles.js";
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
 * that. It stays a CLI-only choice behind `--allow-paid`.
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
    enum: ["low", "medium", "high", "auto"],
  },
  background: {
    type: "string",
    description: "Background handling. Best effort.",
    enum: ["transparent", "opaque", "auto"],
  },
  format: {
    type: "string",
    description: "Output file format. Defaults to the project config, else png.",
    enum: ["png", "jpeg", "webp"],
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
    if (!(key in inputSchema.properties)) {
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
export const HANDLERS: Record<string, Handler> = {
  list_styles: async (args, deps) => {
    const { config } = await loadConfig({ cwd: cwdOf(deps) });
    return collectStyleReport(config, args.name as string | undefined);
  },
  list_models: async (args) => collectModelReport({ override: args.model as string | undefined }),
  doctor: async (_args, deps) => collectDoctorReport({ cwd: cwdOf(deps) }),
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
