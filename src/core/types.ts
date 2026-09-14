export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageBackground = "transparent" | "opaque" | "auto";
export type ImageFormat = "png" | "jpeg" | "webp";
export type BackendName = "codex-http" | "codex-exec" | "api";

/**
 * One named style.
 *
 * The descriptive field names are taken from OpenAI's own imagegen skill —
 * subject, scene, style, composition, lighting, palette, materials, text,
 * constraints, negative — because that is the structure the backend was tuned on.
 * The four generation fields at the end are defaults the style implies; a CLI flag
 * still beats them.
 */
export interface StyleDefinition {
  subject?: string;
  scene?: string;
  style?: string;
  composition?: string;
  lighting?: string;
  palette?: string;
  materials?: string;
  text?: string;
  constraints?: string;
  negative?: string;
  modifiers?: string;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  format?: ImageFormat;
}

export const STYLE_TEXT_FIELDS = [
  "subject",
  "scene",
  "style",
  "composition",
  "lighting",
  "palette",
  "materials",
  "text",
  "constraints",
  "modifiers",
  "negative",
] as const;

/**
 * A reference image after it has been read off disk.
 *
 * The type lives in core rather than in `engine/references.ts` so that a request
 * can name it without core importing the engine. The loader owns the behaviour.
 */
export interface LoadedReference {
  /** The path the user gave. Kept for messages only; never sent to the backend. */
  path: string;
  format: ImageFormat;
  bytes: number;
  /** sha256 of the FILE CONTENTS. This is what the cache key is built from. */
  sha256: string;
  /** `data:<media type>;base64,<payload>` — what actually goes on the wire. */
  dataUrl: string;
}

export interface GenerateRequest {
  prompt: string;
  /** Requested generation size, e.g. "1024x1536". Advisory to the server. */
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  /** Number of images. Values above 1 issue one request per image. */
  n?: number;
  /** Pin a driver model. Skips detection entirely. */
  model?: string;
  /** Post-process to exactly this size with sharp, e.g. "800x600". */
  exactSize?: string;
  /** Explicit output file path. When absent, the engine derives one. */
  outputPath?: string;
  format?: ImageFormat;
  /** Reference images for an edit, as paths the user typed. Empty for a pure generation. */
  referenceImages?: string[];
  /**
   * The same references, read and encoded. The engine fills this in; callers never
   * set it. Providers read this and MUST NOT read `referenceImages` — a bare
   * filesystem path in a request body is a path the backend cannot open.
   */
  resolvedReferences?: LoadedReference[];
  /**
   * A resolved style. The engine never looks a style up by name — the CLI does that
   * against the project config and hands the definition down. That is what keeps
   * every engine test free of a config file.
   */
  style?: StyleDefinition;
}

export interface ImageArtifact {
  path: string;
  bytes: number;
  /** The format sniffed from the magic number. Never the requested format. */
  format: ImageFormat;
  width?: number;
  height?: number;
  sha256: string;
  /**
   * Set when the bytes did not match the requested format. The spec forbids
   * lying about bytes, so the file is named from `format` and this records the
   * disagreement for `--json` consumers.
   */
  requestedFormat?: ImageFormat;
  /**
   * Set when the intended path was already taken and a `-v2` sibling was written
   * instead. Callers print it so the user is never silently redirected.
   */
  siblingOf?: string;
}

/** One image in a batch that did not make it. */
export interface BatchFailure {
  /** Which requested image failed, zero-based. */
  index: number;
  /** The error class name, e.g. "ContentBlocked". Stable enough to switch on. */
  kind: string;
  message: string;
}

export interface GenerateResult {
  images: ImageArtifact[];
  backend: BackendName;
  model: string;
  cached: boolean;
  /** The prompt actually sent, after augmentation. Recorded in the manifest. */
  effectivePrompt: string;
  elapsedMs: number;
  /**
   * How many images the request asked for. When this exceeds `images.length` the
   * batch was partial and `failures` says why.
   *
   * Declared here, not in Task 17 where the JSON contract consumes it, because
   * Task 16 already sets it at both exits of `runGeneration` and the task-boundary
   * `tsc --noEmit` has to pass.
   *
   * Optional until Task 18: before batching there is only the single-image shape
   * and `images.length` says everything. Task 18 makes it required.
   */
  requested: number;
  /**
   * Set when at least one image succeeded and at least one failed. A run in which
   * everything failed throws instead, so the caller sees the real cause.
   */
  failures?: BatchFailure[];
}

/** Parameters for the server-side image_generation tool. */
export interface ImageToolParams {
  type: "image_generation";
  size?: string;
  quality?: string;
  background?: string;
  output_format: ImageFormat;
}
