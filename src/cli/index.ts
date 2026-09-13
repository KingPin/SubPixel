#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { collectDoctorReport, formatDoctorReport } from "./doctor.js";
import { collectModelReport, formatModelReport } from "./models.js";

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

  await program.parseAsync(argv);
}
