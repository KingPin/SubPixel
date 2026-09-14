import type { SubpixelConfig } from "../config/schema.js";
import { ConfigError } from "../core/errors.js";
import type { StyleDefinition } from "../core/types.js";
import { composeStyleBlock } from "../engine/prompt.js";

/**
 * Find a style by name, or explain what is available.
 *
 * A typo in a style name is the most likely failure here, and the fix is always
 * "one of these". Listing them costs one line and removes a trip to the config file.
 */
export function resolveStyle(
  config: SubpixelConfig,
  name: string | undefined,
): StyleDefinition | undefined {
  if (!name) return undefined;
  const style = config.styles?.[name];
  if (style) return style;

  const available = Object.keys(config.styles ?? {});
  const suffix =
    available.length > 0
      ? ` Available: ${available.sort().join(", ")}.`
      : " No styles are defined in this project.";
  throw new ConfigError(`Unknown style "${name}".${suffix}`);
}

export interface StyleReport {
  styles: Array<{
    name: string;
    fields: string[];
    block: string;
    defaults: Partial<StyleDefinition>;
  }>;
}

export function collectStyleReport(config: SubpixelConfig, only?: string): StyleReport {
  const entries = Object.entries(config.styles ?? {}).filter(([name]) => !only || name === only);
  if (only && entries.length === 0) resolveStyle(config, only);

  return {
    styles: entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, style]) => {
        const { size, quality, background, format, ...rest } = style;
        return {
          name,
          fields: Object.keys(rest).sort(),
          block: composeStyleBlock(style),
          defaults: { size, quality, background, format },
        };
      }),
  };
}

export function formatStyleReport(report: StyleReport): string {
  if (report.styles.length === 0) return "No styles are defined in this project.";
  return report.styles
    .map((style) => {
      const defaults = Object.entries(style.defaults)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      const head = defaults ? `${style.name}  (${defaults})` : style.name;
      return style.block ? `${head}\n${style.block}` : head;
    })
    .join("\n\n");
}
