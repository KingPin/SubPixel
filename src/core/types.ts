export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageBackground = "transparent" | "opaque" | "auto";
export type ImageFormat = "png" | "jpeg" | "webp";
export type BackendName = "codex-http" | "codex-exec" | "api";

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
  /** Reference images for an edit. Empty for a pure generation. */
  referenceImages?: string[];
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
