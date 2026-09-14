import { ConfigError } from "../core/errors.js";
import type { GenerateRequest, ImageToolParams } from "../core/types.js";

/** Marks text this module appended, so augmentation stays idempotent. */
const MARKER = "\n\n[Image requirements]";

export interface Dimensions {
  width: number;
  height: number;
}

export function parseSize(size: string): Dimensions {
  const match = /^(\d+)[xX](\d+)$/.exec(size.trim());
  if (!match) {
    throw new ConfigError(`Invalid size "${size}". Use WIDTHxHEIGHT, for example 1024x1536.`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new ConfigError(`Invalid size "${size}". Both dimensions must be positive.`);
  }
  return { width, height };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function describeAspect(size: string): string {
  const { width, height } = parseSize(size);
  const divisor = gcd(width, height);
  const w = width / divisor;
  const h = height / divisor;
  if (w === h) return "1:1 square";
  if (w === 2 && h === 3) return "2:3 portrait";
  if (w === 3 && h === 2) return "3:2 landscape";
  const orientation = w > h ? "landscape" : "portrait";
  return `${w}:${h} ${orientation}`;
}

/**
 * Restate the geometry and style requirements inside the prompt text.
 *
 * The server-side image tool treats size, quality, and background as hints and
 * routinely returns something else. Saying the same thing in the prompt raises the
 * hit rate substantially. This is the "mirror" layer; `--exact-size` is the
 * "enforce" layer that makes the result deterministic.
 */
export function augmentPrompt(
  prompt: string,
  request: Pick<GenerateRequest, "size" | "quality" | "background">,
): string {
  if (prompt.includes(MARKER)) return prompt;

  const requirements: string[] = [];
  if (request.size) {
    requirements.push(
      `Compose for a ${describeAspect(request.size)} frame at ${request.size} pixels. ` +
        "Fill the whole frame; do not add letterboxing or padding bars.",
    );
  }
  if (request.quality === "high") {
    requirements.push("Render with high detail and clean, sharp edges.");
  }
  if (request.background === "transparent") {
    requirements.push(
      "The background must be fully transparent. Place the subject on an empty " +
        "background with no scenery, no shadow plane, and no solid colour fill.",
    );
  }

  if (requirements.length === 0) return prompt;
  return `${prompt}${MARKER}\n${requirements.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * Build the tool parameters. Unset fields are omitted rather than sent as null,
 * because the endpoint rejects nulls on some of these keys.
 */
export function buildImageToolParams(
  request: Pick<GenerateRequest, "prompt" | "size" | "quality" | "background" | "format">,
): ImageToolParams {
  const params: ImageToolParams = {
    type: "image_generation",
    output_format: request.format ?? "png",
  };
  if (request.size) params.size = request.size;
  if (request.quality) params.quality = request.quality;
  if (request.background) params.background = request.background;
  return params;
}
