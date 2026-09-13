import { modelCachePath, resolveModel } from "../providers/models.js";

export interface ModelReport {
  selected: string;
  source: string;
  fetchedAt?: string;
  candidates: string[];
}

export interface ModelReportOptions {
  override?: string;
  cachePath?: string;
}

export async function collectModelReport(options: ModelReportOptions = {}): Promise<ModelReport> {
  const resolved = await resolveModel({
    override: options.override,
    cachePath: options.cachePath ?? modelCachePath(),
  });
  return {
    selected: resolved.slug,
    source: resolved.source,
    fetchedAt: resolved.fetchedAt,
    candidates: resolved.candidates.map((model) => model.slug),
  };
}

export function formatModelReport(report: ModelReport): string {
  const lines = [`Driver models (source: ${report.source})`, ""];
  for (const slug of report.candidates) {
    lines.push(`${slug === report.selected ? "*" : " "} ${slug}`);
  }
  lines.push("");
  lines.push("The marked model drives the conversation and calls the image tool.");
  lines.push("Pin a different one with --model <slug>.");
  return lines.join("\n");
}
