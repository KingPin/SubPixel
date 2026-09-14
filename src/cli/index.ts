#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
import { collectModelReport, formatModelReport } from "./models.js";
import { runGenerate } from "./generate.js";

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
    .command("generate")
    .argument("<prompt>", "what to draw")
    .description("Generate an image from a prompt")
    .option("--size <WxH>", "requested generation size, e.g. 1024x1536")
    .option("--quality <level>", "low | medium | high | auto")
    .option("--background <mode>", "transparent | opaque | auto")
    .option("--format <fmt>", "png | jpeg | webp", "png")
    .option("--exact-size <WxH>", "post-process to exactly this size (requires sharp)")
    .option("--model <slug>", "pin a driver model")
    .option("-o, --out <path>", "write to this exact file")
    .option("--out-dir <dir>", "directory for generated images", process.cwd())
    .option("-n <count>", "number of images", "1")
    .option("--json", "emit the result as JSON on stdout")
    .option("--emit <format>", "path | markdown | jsx | html", "path")
    .option("--no-cache", "ignore the cache for this request")
    .option("--overwrite", "replace an existing output file")
    .option("--no-overwrite", "write a -v2 sibling instead of replacing (the default)")
    .option("--timeout <seconds>", "whole-request budget, measured from the moment the request starts")
    .option("-v, --verbose", "verbose logging on stderr")
    .option("-q, --quiet", "errors only on stderr")
    .action(runGenerate);

  await program.parseAsync(argv);
}
