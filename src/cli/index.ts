#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
import { collectModelReport, formatModelReport } from "./models.js";
import { runEdit } from "./edit.js";
import { runGenerate } from "./generate.js";
import { runIcons } from "./icons.js";
import { normalizeArgv } from "./options.js";
import { collectStyleReport, formatStyleReport } from "./styles.js";
import { loadConfig } from "../config/load.js";
import { redact } from "../core/redact.js";

async function packageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, "..", "..", "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("spx")
    .description("Image generation and editing powered by your ChatGPT/Codex subscription")
    .version(await packageVersion());

  program
    .command("doctor")
    .description("Check credentials, driver model, and optional dependencies")
    .option("--json", "emit a single JSON object on stdout")
    .action(async (options: { json?: boolean }) => {
      const report = await collectDoctorReport();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }
      process.exitCode = report.ok ? 0 : 1;
    });

  program
    .command("models")
    .description("List the driver models subpixel will try, in order")
    .option("--json", "emit a single JSON object on stdout")
    .option("--model <slug>", "show the effect of pinning this model")
    .action(async (options: { json?: boolean; model?: string }) => {
      const report = await collectModelReport({ override: options.model });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatModelReport(report)}\n`);
      }
    });

  program
    .command("styles")
    .argument("[name]", "show only this style")
    .description("List the named styles defined in the project config")
    .option("--json", "emit a single JSON object on stdout")
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      const { config } = await loadConfig();
      const report = collectStyleReport(config, name);
      // Redact at the BOUNDARY, both branches.
      //
      // Style text is user prose from a file that is checked into a repository, and
      // `spx styles` is the one command whose entire job is to print it. The rule is
      // not "redact reasons and error messages"; it is that nothing leaves this
      // process unmasked. `redact()` is a string→string pass, and its mask contains
      // no quote or backslash, so running it over the serialised JSON leaves a
      // still-parseable document.
      process.stdout.write(
        redact(
          options.json
            ? `${JSON.stringify(report, null, 2)}\n`
            : `${formatStyleReport(report)}\n`,
        ),
      );
    });

  program
    .command("generate")
    .argument("<prompt>", "what to draw")
    .description("Generate an image from a prompt")
    .option("--size <WxH>", "requested generation size, e.g. 1024x1536")
    .option("--quality <level>", "low | medium | high | auto")
    .option("--background <mode>", "transparent | opaque | auto")
    .option("--format <fmt>", "png | jpeg | webp (default: the config, else png)")
    .option("--exact-size <WxH>", "post-process to exactly this size (requires sharp)")
    .option("--model <slug>", "pin a driver model")
    .option("--style <name>", "apply a named style from the project config")
    .option(
      "--image <path>",
      "reference image; repeat for several",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("-o, --out <path>", "write to this exact file")
    .option("--out-dir <dir>", "directory for generated images (default: the config, else the working directory)")
    .option("-n <count>", "number of images", "1")
    .option("--json", "emit the result as JSON on stdout")
    .option("--emit <format>", "path | markdown | jsx | html", "path")
    .option("--no-cache", "ignore the cache for this request")
    .option("--overwrite", "replace an existing output file")
    .option("--no-overwrite", "write a -v2 sibling instead of replacing (the default)")
    .option("--timeout <seconds>", "whole-request budget, measured from the moment the request starts")
    .option("--concurrency <n>", "maximum simultaneous requests (default: the config, else 2)")
    .option("-b, --backend <name>", "codex-http | codex-exec | api | auto (default: the config, else auto)")
    .option("--allow-paid", "permit the paid api backend (spends OpenAI credits)")
    .option("-f, --force", "shorthand for --no-cache --overwrite")
    .option("--dry-run", "print the resolved plan and exit without spending quota")
    .option("--stall-timeout <sec>", "give up after this many seconds with no stream activity")
    .option("-v, --verbose", "verbose logging on stderr")
    .option("-q, --quiet", "errors only on stderr")
    .action(runGenerate);

  program
    .command("icons")
    .argument("<image>", "the source image, ideally square and at least 512 pixels")
    .description("Build a favicon and PWA icon pack from an existing image")
    .option("--out-dir <dir>", "where to write the pack", "icons")
    .option("--overwrite", "replace an existing pack")
    .option("--json", "emit a single JSON object on stdout")
    .action(runIcons);

  program
    .command("edit")
    .argument("<image>", "the image to edit")
    .argument("<instruction>", "what to change")
    .description("Edit an existing image")
    .option("--size <WxH>", "requested generation size, e.g. 1024x1536")
    .option("--quality <level>", "low | medium | high | auto")
    .option("--format <fmt>", "png | jpeg | webp (default: the config, else png)")
    .option("--style <name>", "apply a named style from the project config")
    .option("--exact-size <WxH>", "resize the result to exactly this size")
    .option("-o, --out <path>", "write to this exact path")
    .option("--out-dir <dir>", "directory for the result")
    .option("--model <slug>", "pin the driver model")
    .option("-b, --backend <name>", "codex-http | codex-exec | api | auto")
    .option("--dry-run", "show what would be sent without generating")
    .option("--no-cache", "ignore any cached result")
    .option("--overwrite", "replace an existing file at the output path")
    .option("--json", "emit a single JSON object on stdout")
    .option("-v, --verbose", "verbose logging on stderr")
    .option("-q, --quiet", "errors only on stderr")
    .action(runEdit);

  await program.parseAsync(normalizeArgv(argv));
}
