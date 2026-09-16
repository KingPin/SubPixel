import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config/load.js";
import { detailsOf, SubpixelError } from "../core/errors.js";
import { redact } from "../core/redact.js";
import { packageVersion } from "../core/version.js";
import { createJob, completeJob, failJob, jobsDirFor, reapOrphans } from "./jobs.js";
import { createProgressReporter, resolveCutoverMs, type ProgressToken } from "./progress.js";
import { TOOLS, callTool, type ToolDeps } from "./tools.js";

/**
 * The tools that can spend quota, and therefore the tools that get the job path.
 *
 * Derived from `readOnly` rather than listed again: a new generating tool is one
 * that costs money, and the failure mode of a stale list here is a six-minute call
 * held open until the host gives up and retries it.
 */
const LONG_TOOLS = new Set(TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name));

export interface RunToolOptions {
  /** How long the job path waits before handing back a `job_id`. */
  cutoverMs: number;
  /**
   * True when the host sent a `progressToken`.
   *
   * A streaming call is held open for as long as it takes: the host has said it
   * wants progress, and it is watching notifications rather than a clock.
   */
  streaming: boolean;
}

/** The envelope a host gets when the work outlived the cut-over. */
export interface RunningResult {
  status: "running";
  job_id: string;
  tool: string;
  poll: string;
}

/**
 * Run one tool call, choosing the path the host asked for.
 *
 * Exported for the tests, which drive it through a real server rather than around
 * it. Nothing here writes to stdout, which is the transport.
 */
export async function runTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
  options: RunToolOptions,
): Promise<unknown> {
  if (options.streaming || !LONG_TOOLS.has(name)) return callTool(name, args, deps);

  const jobsDir = deps.jobsDir ?? jobsDirFor(join(deps.cwd ?? process.cwd(), ".subpixel"));
  const job = await createJob(jobsDir, name);

  // Settled is read after the race, so the fast cases — a cache hit, a validation
  // error — answer the host directly instead of making it poll for something this
  // call already has.
  let settled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  const work = callTool(name, args, { ...deps, jobsDir })
    .then(
      async (value) => {
        settled = { ok: true, value };
        await completeJob(jobsDir, job.id, value);
      },
      async (error) => {
        settled = { ok: false, error };
        await failJob(jobsDir, job.id, error);
      },
    )
    // The background continuation owns the last reference to this promise. Without
    // this the record-writing failure becomes an unhandled rejection that takes the
    // whole server down mid-generation.
    .catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((done) => {
        timer = setTimeout(done, options.cutoverMs);
        // The cut-over must never be the reason the process stays alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (settled) {
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  // The work keeps running, and it keeps running only as long as this process. A
  // record is not a worker: if the host restarts the server, `reapOrphans` marks
  // this failed rather than buying the image a second time.
  return {
    status: "running",
    job_id: job.id,
    tool: name,
    poll: `Call get_image_job with job_id "${job.id}". Do not retry ${name}.`,
  } satisfies RunningResult;
}

/**
 * Turn a thrown error into a tool result.
 *
 * A failed tool is a result with `isError`, not a protocol error: the host shows it
 * to the model, and the model can act on the taxonomy `code` — `AUTH_EXPIRED` means
 * run `doctor`, `RATE_LIMITED` means wait. A protocol error is for a call that
 * never happened.
 */
function errorResult(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const code = err instanceof SubpixelError ? err.code : "UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  // `details` is whatever survived the failure — for a partial sync, the list of
  // assets that DID land. Without it the model's only move is to run the whole
  // thing again, which re-bills everything that already succeeded.
  const details = detailsOf(err);
  return {
    content: [
      {
        type: "text",
        // The WHOLE document, not just the message: details is a report assembled
        // from user text — prompts, paths, style names — and the message is only
        // one of the strings in it.
        text: redact(
          JSON.stringify({ error: { code, message, ...(details !== undefined && { details }) } }, null, 2),
        ),
      },
    ],
    isError: true,
  };
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build the server, wired but not connected.
 *
 * `reapOrphans` runs here, once, before the first tool call: every `running` record
 * from a previous process is a promise nothing is keeping.
 */
export async function createMcpServer(deps: ToolDeps = {}): Promise<Server> {
  const cwd = deps.cwd ?? process.cwd();
  const jobsDir = deps.jobsDir ?? jobsDirFor(join(cwd, ".subpixel"));
  await reapOrphans(jobsDir);

  const { config } = await loadConfig({ cwd });
  const cutoverMs = resolveCutoverMs(config);

  const server = new Server(
    { name: "subpixel", version: await packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const token = extra._meta?.progressToken as ProgressToken | undefined;
    const reporter =
      token === undefined
        ? undefined
        : createProgressReporter(token, (notification) => extra.sendNotification(notification));

    try {
      return textResult(
        await runTool(
          request.params.name,
          request.params.arguments,
          { ...deps, jobsDir, cwd, onEvent: reporter?.onEvent },
          { cutoverMs, streaming: reporter !== undefined },
        ),
      );
    } catch (err) {
      return errorResult(err);
    } finally {
      // Before the result goes out, not after: a notification against a token the
      // host has already retired is a notification it has nowhere to put.
      reporter?.stop();
    }
  });

  return server;
}

/** `spx mcp`: serve on stdio and never return. */
export async function serveStdio(deps: ToolDeps = {}): Promise<void> {
  const server = await createMcpServer(deps);
  await server.connect(new StdioServerTransport());
}
