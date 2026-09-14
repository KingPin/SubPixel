import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OutputError } from "../core/errors.js";
import { atomicPublish } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { ICON_SNIPPET, MANIFEST_SNIPPET, buildIconPack } from "../engine/icons.js";
import { loadReference } from "../engine/references.js";

export interface IconsCliOptions {
  outDir?: string;
  overwrite?: boolean;
  json?: boolean;
}

export async function runIcons(source: string, options: IconsCliOptions): Promise<void> {
  const warn = (message: string) => process.stderr.write(`warning: ${redact(message)}\n`);

  // `loadReference` already reads, sniffs, and size-caps an image, and produces the
  // same error messages the rest of the tool produces. A second reader here would
  // only be a second place for "that is not a PNG" to be worded differently.
  const image = await loadReference(resolve(source));
  const bytes = Buffer.from(image.dataUrl.split(",", 2)[1] ?? "", "base64");

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
      `${redact(JSON.stringify({ source: image.path, files: written }, null, 2))}\n`,
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
