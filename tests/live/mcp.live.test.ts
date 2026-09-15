import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import { manifestPathFor } from "../../src/engine/manifest.js";

// This test spends real subscription quota. It must never run unattended.
const live = process.env.SUBPIXEL_LIVE === "1";

const PROMPT = "a simple flat-style blue anchor icon on a white background";

/** The tool result body, which every tool returns as one JSON text block. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // No `onprogress`, deliberately. Without a progressToken the server takes the job
  // path, which is the half of the dual contract the in-process tests cannot prove
  // against a real generation: only a real one outlives the cut-over.
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(result.isError ?? false, JSON.stringify(body)).toBe(false);
  return body;
}

describe.runIf(live)("live MCP", () => {
  it("returns a job for a real generation and polls it to a file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel-live-mcp-"));
    const server = await createMcpServer({ cwd: dir });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "live-host", version: "0" }, { capabilities: {} });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

    try {
      const started = await call(client, "generate_image", { prompt: PROMPT, out_dir: dir });
      expect(started.status).toBe("running");
      expect(started.tool).toBe("generate_image");
      expect(typeof started.job_id).toBe("string");
      // The host is told how to find out. If this stops being said, a host that
      // reads the instruction rather than the schema will retry and pay twice.
      expect(String(started.poll)).toContain("get_image_job");

      // Poll, do not retry. A second generate_image call is a second image and a
      // second charge, which is the whole reason the job path exists.
      let job: Record<string, unknown> = started;
      const deadline = Date.now() + 600_000;
      while (job.status === "running" && Date.now() < deadline) {
        await sleep(5000);
        job = await call(client, "get_image_job", { job_id: started.job_id });
      }

      expect(job.status, JSON.stringify(job)).toBe("done");
      // The record carries the whole tool result, not a flattened copy of it.
      const result = job.result as { cached: boolean; images: Array<{ path: string }> };
      expect(result.cached).toBe(false);
      expect(result.images).toHaveLength(1);
      const images = result.images;

      const bytes = await readFile(images[0]!.path);
      expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");

      // A manifest beside the image is what makes `spx regen` possible. An image
      // without one is a dead end, so the job path has to write it too.
      const manifest = JSON.parse(
        await readFile(manifestPathFor(images[0]!.path), "utf8"),
      ) as { prompt: string };
      expect(manifest.prompt).toBe(PROMPT);
    } finally {
      await client.close();
    }
  }, 900_000);
});
