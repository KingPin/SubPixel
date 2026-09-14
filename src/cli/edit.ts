import { resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import type { SubpixelConfig } from "../config/schema.js";
import { ConfigError } from "../core/errors.js";
import type { GenerateRequest, StyleDefinition } from "../core/types.js";
import { resolveSharedFields, runGenerateRequest, type GenerateCliOptions } from "./generate.js";
import { resolveStyle } from "./styles.js";

// Everything `generate` takes except the count: `edit` changes one image into one
// image. `--image` is registered nowhere for `edit` either — the source is the
// positional argument — but it costs nothing to carry the field.
export type EditCliOptions = Omit<GenerateCliOptions, "n">;

/**
 * `spx edit` is `spx generate` with one reference and a framing sentence.
 *
 * There is no separate edit endpoint here — the model edits by being shown the
 * image and told what to change. The framing sentence matters: without it the model
 * routinely treats the attached image as inspiration and draws something new.
 */
export function buildEditRequest(
  source: string,
  instruction: string,
  options: EditCliOptions,
  style: StyleDefinition | undefined,
  config: SubpixelConfig,
): GenerateRequest {
  if (instruction.trim() === "") {
    throw new ConfigError(
      'spx edit needs an instruction, for example: spx edit photo.png "make the sky orange".',
    );
  }

  return {
    prompt:
      "Edit the attached image as instructed. Keep everything not mentioned unchanged. " +
      `Instruction: ${instruction.trim()}`,
    // Resolved here, not in the loader. A relative path is relative to the shell the
    // user typed it in, and the loader runs well after the working directory has
    // stopped being interesting.
    referenceImages: [resolve(source)],
    outputPath: options.out ? resolve(options.out) : undefined,
    // Everything else comes from the SHARED resolver, so a flag cannot mean one
    // thing under `generate` and another under `edit`.
    ...resolveSharedFields(options, style, config),
  };
}

export async function runEdit(
  source: string,
  instruction: string,
  options: EditCliOptions,
): Promise<void> {
  const warn = (message: string) => process.stderr.write(`warning: ${message}\n`);
  const { config } = await loadConfig({ warn });
  const style = resolveStyle(config, options.style ?? config.style);

  const request = buildEditRequest(source, instruction, options, style, config);

  await runGenerateRequest(request, { ...options, config });
}
