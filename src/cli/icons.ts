import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OutputError } from "../core/errors.js";
import { atomicPublish } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { ICON_SNIPPET, MANIFEST_SNIPPET, buildIconPack } from "../engine/icons.js";
import { readImageFile } from "../engine/references.js";

export interface IconsCliOptions {
  outDir?: string;
  overwrite?: boolean;
  json?: boolean;
}

export async function runIcons(source: string, options: IconsCliOptions): Promise<void> {
  const warn = (message: string) => process.stderr.write(`warning: ${redact(message)}\n`);

  // `readImageFile` reads and sniffs with the same wording the rest of the tool
  // uses, without the 12 MiB reference cap. That cap exists because a reference
  // travels base64-encoded inside a request body; an icon source never leaves this
  // machine, so a valid high-resolution master must not be refused by it.
  const sourcePath = resolve(source);
  const { data: bytes } = await readImageFile(sourcePath);

  const outDir = resolve(options.outDir ?? "icons");
  const files = await buildIconPack(bytes, warn);

  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const path = join(outDir, file.name);
    const published = await atomicPublish(path, file.data, {
      overwrite: options.overwrite === true,
    });
    if (!published) {
      throw new OutputError(`${path} already exists. Pass --overwrite to replace the pack.`);
    }
    written.push(path);
  }

  if (options.json) {
    process.stdout.write(
      `${redact(JSON.stringify({ source: sourcePath, files: written }, null, 2))}\n`,
    );
    return;
  }

  process.stdout.write(
    redact(
      `Wrote ${written.length} files to ${outDir}\n\n` +
        `Add to your <head>:\n${ICON_SNIPPET}\n\n` +
        `Add to site.webmanifest:\n${MANIFEST_SNIPPET}\n`,
    ),
  );
}
