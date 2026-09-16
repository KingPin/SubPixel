import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentBlocked } from "../../src/core/errors.js";
import type { EventSink } from "../../src/core/events.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { ToolDeps } from "../../src/mcp/tools.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/** What a provider must return. Shaped like the smallest real one. */
const IMAGE = { images: [PNG], model: "model-a", effectivePrompt: "a fox" };

let dir: string;
const open: Client[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-mcp-"));
  // A generous cut-over, because the flaky direction is the fast one: a test that
  // expects an inline answer is asserting that the whole call beat a wall clock, and
  // on a loaded runner it does not. The job-path tests want the opposite — a provider
  // that loses to the clock, which load only makes more certain — so they shorten it
  // for themselves with SUBPIXEL_MCP_CUTOVER_MS.
  await writeFile(join(dir, "subpixel.config.json"), JSON.stringify({ mcp: { cutoverMs: 5000 } }));
  delete process.env.SUBPIXEL_MCP_CUTOVER_MS;
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
});

/** A real client and a real server, talking over a real protocol, in one process. */
async function connect(deps: ToolDeps): Promise<Client> {
  const server = await createMcpServer({ cwd: dir, ...deps });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0" }, { capabilities: {} });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  open.push(client);
  return client;
}

interface ToolOutcome {
  isError: boolean;
  body: Record<string, unknown>;
  progress: Array<{ progress: number; message?: string }>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options: { watch?: boolean } = {},
): Promise<ToolOutcome> {
  const progress: Array<{ progress: number; message?: string }> = [];
  const result = (await client.callTool(
    { name, arguments: args },
    undefined,
    // Passing `onprogress` is what makes the SDK attach a `_meta.progressToken`,
    // which is the signal the server reads to choose the streaming path.
    options.watch ? { onprogress: (event) => progress.push(event) } : undefined,
  )) as { isError?: boolean; content: Array<{ type: string; text: string }> };

  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    progress,
  };
}

/** Two assets, so the concurrent streams have something to interleave. */
async function manifest(): Promise<void> {
  await writeFile(
    join(dir, "assets.yml"),
    "assets:\n  - id: hero\n    prompt: a dashboard\n  - id: icon\n    prompt: a glyph\n",
  );
}

describe("the MCP server", () => {
  it("lists every tool with its schema", async () => {
    const { tools } = await (await connect({})).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "doctor",
      "edit_image",
      "generate_image",
      "get_image_job",
      "list_models",
      "list_styles",
      "sync_assets",
    ]);
    expect(tools.find((tool) => tool.name === "doctor")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "generate_image")?.annotations?.readOnlyHint).toBe(false);
  });

  it("carries provider events through the real engine to real notifications", async () => {
    // The provider is fake; everything between it and the host is not. A mocked
    // adapter would pass this while the engine-to-provider connection was missing.
    const provider = vi.fn(async (_request: unknown, options: { onEvent?: EventSink }) => {
      options.onEvent?.({ stage: "submitted", message: "request accepted" });
      // Deliberately repeated: the engine contract allows equal consecutive values
      // and the wire forbids them.
      options.onEvent?.({ stage: "generating", progress: 0 });
      options.onEvent?.({ stage: "generating", progress: 0 });
      return IMAGE;
    });

    const outcome = await call(
      await connect({ provider: provider as never }),
      "generate_image",
      { prompt: "a fox" },
      { watch: true },
    );

    expect(outcome.isError).toBe(false);
    expect((outcome.body.images as unknown[])).toHaveLength(1);
    expect(outcome.progress.length).toBeGreaterThanOrEqual(5);
    expect(outcome.progress.map((event) => event.progress)).toEqual(
      [...outcome.progress].map((event) => event.progress).sort((a, b) => a - b),
    );
    expect(new Set(outcome.progress.map((event) => event.progress)).size).toBe(
      outcome.progress.length,
    );
    expect(outcome.progress.at(-1)?.message).toContain("done");
  });

  it("stops reporting once the call has returned", async () => {
    let captured: EventSink | undefined;
    const provider = async (_request: unknown, options: { onEvent?: EventSink }) => {
      captured = options.onEvent;
      return IMAGE;
    };

    const outcome = await call(
      await connect({ provider: provider as never }),
      "generate_image",
      { prompt: "a fox" },
      { watch: true },
    );
    const seen = outcome.progress.length;

    // A late event from a worker that has not noticed it is finished. The host's
    // token is gone by now, so nothing may go out.
    captured?.({ stage: "generating", message: "too late" });
    await new Promise((done) => setTimeout(done, 20));

    expect(outcome.progress).toHaveLength(seen);
  });

  it("hands back a job id when the host is not watching, and polls to done", async () => {
    process.env.SUBPIXEL_MCP_CUTOVER_MS = "60";
    const provider = async () => {
      await new Promise((done) => setTimeout(done, 200));
      return IMAGE;
    };
    const client = await connect({ provider: provider as never });

    const started = await call(client, "generate_image", { prompt: "a slow fox" });
    expect(started.body.status).toBe("running");
    expect(started.body.job_id).toEqual(expect.any(String));
    expect(started.body.poll).toContain("Do not retry");

    let record: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 60; attempt += 1) {
      record = (await call(client, "get_image_job", { job_id: started.body.job_id })).body;
      if (record.status !== "running") break;
      await new Promise((done) => setTimeout(done, 25));
    }

    expect(record.status).toBe("done");
    expect((record.result as { images: unknown[] }).images).toHaveLength(1);
  });

  it("answers before the cut-over when the cache already has the image", async () => {
    const provider = vi.fn(async () => IMAGE);
    const client = await connect({ provider: provider as never });

    const first = await call(client, "generate_image", { prompt: "a fox" });
    const second = await call(client, "generate_image", { prompt: "a fox" });

    // The second call never reaches a backend, which is what makes a host's retry
    // survivable rather than expensive.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(first.body.cached).toBe(false);
    expect(second.body.cached).toBe(true);
    expect(second.body.status).toBeUndefined();
  });

  it("reports a refusal as a failed result carrying the taxonomy code", async () => {
    const provider = vi.fn(async () => {
      throw new ContentBlocked("the model refused this prompt");
    });

    const outcome = await call(
      await connect({ provider: provider as never }),
      "generate_image",
      { prompt: "something refused" },
    );

    expect(outcome.isError).toBe(true);
    expect((outcome.body.error as { code: string }).code).toBe("CONTENT_BLOCKED");
    // A refusal is not a transport problem, so no second backend is tried and no
    // second image is bought.
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("refuses a second image before a provider is ever reached", async () => {
    const provider = vi.fn(async () => IMAGE);

    const outcome = await call(
      await connect({ provider: provider as never }),
      "generate_image",
      { prompt: "a fox", n: 2 },
    );

    expect(outcome.isError).toBe(true);
    expect((outcome.body.error as { message: string }).message).toMatch(/at most 1/);
    expect(provider).not.toHaveBeenCalled();
  });

  it("edits through the same path as generate", async () => {
    const source = join(dir, "fox.png");
    await writeFile(source, PNG);
    const provider = vi.fn(async () => IMAGE);

    const outcome = await call(
      await connect({ provider: provider as never }),
      "edit_image",
      { image: "fox.png", instruction: "make it night" },
      { watch: true },
    );

    expect(outcome.isError).toBe(false);
    expect((outcome.body.images as unknown[])).toHaveLength(1);
    expect(outcome.progress.length).toBeGreaterThan(0);
  });

  it("writes nothing to stdout, because stdout is the transport", async () => {
    const provider = async (_request: unknown, options: { onEvent?: EventSink }) => {
      options.onEvent?.({ stage: "generating" });
      return IMAGE;
    };
    const client = await connect({ provider: provider as never });

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await client.listTools();
      await call(client, "generate_image", { prompt: "a quiet fox" }, { watch: true });
      await call(client, "doctor", {});
    } finally {
      spy.mockRestore();
    }

    expect(written).toEqual([]);
  });

  it("reports asset drift without a provider to spend with", async () => {
    await manifest();
    const provider = vi.fn(async () => IMAGE);

    const outcome = await call(await connect({ provider: provider as never }), "sync_assets", {
      check: true,
    });

    expect(outcome.body.drift).toBe(true);
    expect((outcome.body.statuses as Array<{ id: string }>).map((status) => status.id)).toEqual([
      "hero",
      "icon",
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it("generates once per drifted asset and names each one in the progress", async () => {
    await manifest();
    const provider = vi.fn(async (request: { prompt: string }) => ({
      ...IMAGE,
      effectivePrompt: request.prompt,
    }));

    const outcome = await call(
      await connect({ provider: provider as never }),
      "sync_assets",
      {},
      { watch: true },
    );

    expect(provider).toHaveBeenCalledTimes(2);
    expect(outcome.body.generated).toEqual(["hero", "icon"]);
    const messages = outcome.progress.map((event) => event.message ?? "").join("\n");
    expect(messages).toContain("hero");
    expect(messages).toContain("icon");
    expect(new Set(outcome.progress.map((event) => event.progress)).size).toBe(
      outcome.progress.length,
    );
  });

  it("hands back one job for a whole slow sync run", async () => {
    process.env.SUBPIXEL_MCP_CUTOVER_MS = "60";
    await manifest();
    const provider = async () => {
      await new Promise((done) => setTimeout(done, 200));
      return IMAGE;
    };

    const outcome = await call(await connect({ provider: provider as never }), "sync_assets", {});

    expect(outcome.body.status).toBe("running");
    expect(outcome.body.tool).toBe("sync_assets");
  });

  it("refuses an over-budget sync before any provider is reached", async () => {
    await manifest();
    await writeFile(
      join(dir, "subpixel.config.json"),
      JSON.stringify({ mcp: { cutoverMs: 5000 }, budget: { maxImagesPerRun: 1 } }),
    );
    const provider = vi.fn(async () => IMAGE);

    const outcome = await call(await connect({ provider: provider as never }), "sync_assets", {});

    expect(outcome.isError).toBe(true);
    expect((outcome.body.error as { code: string }).code).toBe("CONFIG_ERROR");
    expect((outcome.body.error as { message: string }).message).toContain("maxImagesPerRun");
    expect(provider).not.toHaveBeenCalled();
  });

  it("lets the environment override the configured cut-over", async () => {
    process.env.SUBPIXEL_MCP_CUTOVER_MS = "1";
    const provider = async () => {
      await new Promise((done) => setTimeout(done, 150));
      return IMAGE;
    };

    const outcome = await call(
      await connect({ provider: provider as never }),
      "generate_image",
      { prompt: "a fox in a hurry" },
    );

    expect(outcome.body.status).toBe("running");
  });
});
