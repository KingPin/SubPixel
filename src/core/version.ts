import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * The package version, read from the installed `package.json`.
 *
 * One reader, because a version that is written down twice is a version that is
 * eventually wrong in one of the two places. `spx --version`, the MCP server
 * handshake, and anything else that reports a version all come through here.
 *
 * Read from disk rather than baked in at build time: the file is next to the
 * compiled output in every install layout this package supports, and a build-time
 * constant would make `npm version` produce a tarball that disagrees with itself.
 */
export async function packageVersion(): Promise<string> {
  if (cached === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "..", "package.json"), "utf8");
    cached = (JSON.parse(raw) as { version: string }).version;
  }
  return cached;
}
