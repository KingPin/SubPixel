// The version is read from package.json at runtime rather than duplicated here. A
// second copy is a copy that goes stale at the one moment it matters — a release.
export { packageVersion } from "./core/version.js";

export { generate } from "./engine/generate.js";
export { generateViaCodexHttp } from "./providers/codex-http.js";
export { resolveModel } from "./providers/models.js";
export * from "./core/errors.js";
export type {
  BackendName,
  GenerateRequest,
  GenerateResult,
  ImageArtifact,
  ImageBackground,
  ImageFormat,
  ImageQuality,
} from "./core/types.js";
