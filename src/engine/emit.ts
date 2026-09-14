import { isAbsolute, relative } from "node:path";
import { redact } from "../core/redact.js";
import type { BackendName, GenerateResult, ImageFormat } from "../core/types.js";

const MAX_ALT = 120;

/**
 * Derive alt text from the prompt.
 *
 * The augmentation block is machine instruction, not description, so it is cut
 * before anything else. Truncation stops at a word boundary; a caption that ends
 * mid-word reads as a bug to anyone who sees it.
 */
export function altTextFor(prompt: string): string {
  const body = prompt.split("\n\n[Image requirements]")[0] ?? prompt;
  const clean = body.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_ALT) return clean;

  const cut = clean.slice(0, MAX_ALT - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface JsonImage {
  path: string;
  relativePath: string;
  bytes: number;
  format: ImageFormat;
  sha256: string;
  width?: number;
  height?: number;
  alt: string;
}

/** One image in a batch that did not make it, as it appears in `--json`. */
export interface JsonFailure {
  index: number;
  kind: string;
  message: string;
}

export interface JsonResult {
  /**
   * False when any requested image is missing. NOT a constant.
   *
   * A machine reading this is deciding whether to use the output. A hardcoded
   * `true` makes "three of four rendered" indistinguishable from "all four
   * rendered", and the caller has no way to find out — stderr is prose and the
   * exit status is gone by the time the JSON is parsed.
   */
  ok: boolean;
  images: JsonImage[];
  /** How many images were asked for. `images.length` is how many exist. */
  requested: number;
  /** Present only when at least one image failed while another succeeded. */
  failures?: JsonFailure[];
  /**
   * Requested images that were never attempted, because an earlier failure stopped
   * the batch. Not failures: no quota was spent and no error describes them.
   */
  skipped: number;
  model: string;
  backend: BackendName;
  cached: boolean;
  elapsedMs: number;
}

function relativeTo(base: string, target: string): string {
  const rel = relative(base, target);
  // A path that climbs out of the base is not useful to paste into source.
  if (rel.startsWith("..") || isAbsolute(rel)) return target;
  return rel;
}

export function toJsonResult(result: GenerateResult, base: string): JsonResult {
  // The prompt is user text on its way to stdout, to a Markdown/JSX/HTML snippet,
  // and into whatever file that snippet is pasted into. `describeFailure` masks the
  // error path and `storeCache` masks the cache copy; this is the third door out of
  // the same room, and it is the one an agent reads on every successful run.
  const alt = altTextFor(redact(result.effectivePrompt));
  const requested = result.requested ?? result.images.length;
  // Already redacted: `describeFailure` in the engine masks the message when it
  // turns an exception into data, because that is the only place that knows it is
  // about to become data. This function must not un-redact it, and must not gain a
  // branch that forwards a raw `Error` message instead.
  const failures = result.failures ?? [];
  return {
    ok: result.images.length === requested,
    requested,
    ...(failures.length > 0 ? { failures } : {}),
    // Whatever is neither produced nor explained by a failure was never started.
    skipped: Math.max(0, requested - result.images.length - failures.length),
    images: result.images.map((image) => ({
      path: image.path,
      relativePath: relativeTo(base, image.path),
      bytes: image.bytes,
      format: image.format,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      alt,
    })),
    model: result.model,
    backend: result.backend,
    cached: result.cached,
    elapsedMs: result.elapsedMs,
  };
}

/**
 * Escaping is per target language, and every interpolated value is escaped.
 *
 * A snippet is pasted straight into someone's source file. Both halves are
 * attacker-influenced in the ordinary sense: the alt text comes from a prompt a
 * user or an agent wrote, and the path comes from a slug derived from that same
 * prompt or from `--output`. An unescaped `]`, `"`, or `&` does not merely look
 * wrong — it silently produces a broken link, a broken attribute, or, pasted into
 * a page, markup the author did not write.
 */

/** Escape text used as the label in `![label](…)`. */
function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[[\]]/g, (char) => `\\${char}`)
    .replace(/\r?\n/g, " ");
}

/**
 * Render a path as a Markdown destination.
 *
 * A bare path breaks on a space or a parenthesis, both of which are legal in a
 * filename. The angle-bracket form handles them, so it is used whenever the path
 * is not plainly safe.
 */
function markdownDestination(path: string): string {
  if (!/[\s()<>\\]/.test(path)) return path;
  return `<${path.replace(/[<>\\]/g, (char) => `\\${char}`)}>`;
}

/** Escape text used inside a double-quoted HTML or JSX attribute. */
function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function emitMarkdown(result: JsonResult): string {
  return result.images
    .map(
      (image) =>
        `![${escapeMarkdownText(image.alt)}](${markdownDestination(image.relativePath)})`,
    )
    .join("\n");
}

export function emitJsx(result: JsonResult): string {
  return result.images
    .map((image) => {
      const dims =
        image.width && image.height ? ` width={${image.width}} height={${image.height}}` : "";
      // A JSX attribute value is a string literal that also decodes entities, so
      // the HTML attribute escaping is correct here and `&quot;` renders as `"`.
      return (
        `<img src="${escapeAttribute(image.relativePath)}" ` +
        `alt="${escapeAttribute(image.alt)}"${dims} />`
      );
    })
    .join("\n");
}

export function emitHtml(result: JsonResult, altOverride?: string): string {
  return result.images
    .map((image) => {
      const alt = escapeAttribute(altOverride ?? image.alt);
      const dims =
        image.width && image.height ? ` width="${image.width}" height="${image.height}"` : "";
      // The path is escaped too. A quote in a filename would otherwise close the
      // src attribute and let the rest of the name become markup.
      return `<img src="${escapeAttribute(image.relativePath)}" alt="${alt}"${dims}>`;
    })
    .join("\n");
}

export type EmitFormat = "path" | "json" | "markdown" | "jsx" | "html";

export function emit(result: GenerateResult, base: string, format: EmitFormat): string {
  const json = toJsonResult(result, base);
  switch (format) {
    case "json":
      return JSON.stringify(json, null, 2);
    case "markdown":
      return emitMarkdown(json);
    case "jsx":
      return emitJsx(json);
    case "html":
      return emitHtml(json);
    case "path":
    default:
      return json.images.map((image) => image.path).join("\n");
  }
}
