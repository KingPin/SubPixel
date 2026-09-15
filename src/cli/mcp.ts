import { serveStdio } from "../mcp/server.js";

/**
 * `spx mcp`: speak MCP on stdio until the host closes stdin.
 *
 * This function does not return, and nothing it calls may write to stdout —
 * stdout is the protocol transport, and one stray line of human-readable text
 * corrupts the frame a host is parsing. Every diagnostic in this process goes to
 * stderr, which hosts collect as server logs.
 */
export async function runMcp(): Promise<void> {
  await serveStdio();
  // The transport holds stdin open. Resolving here would let the process exit
  // between the handshake and the first tool call.
  await new Promise<never>(() => {});
}
