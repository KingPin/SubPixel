/**
 * The failure taxonomy.
 *
 * `canFallback` is the single most important property in this codebase. It answers
 * one question: may the engine retry this request on a different backend?
 *
 * The answer is yes ONLY when the failure provably happened before the request
 * reached the model. Anything that might already have consumed subscription quota
 * must not be retried, because a retry would spend the quota a second time.
 *
 * Two rules keep that honest:
 *
 * 1. `submission` is stated explicitly on every class, and `canFallback` is DERIVED
 *    from it. No subclass hand-writes `canFallback`, so no subclass can claim to be
 *    retryable while admitting it might have been submitted.
 * 2. "uncertain" is the default for anything the transport cannot rule out. A socket
 *    that dies mid-POST, a gateway 504, a child process that exits nonzero — the
 *    request may already be generating on the server. Ambiguity costs one image;
 *    guessing wrong costs two.
 *
 * Every overridable property carries an explicit type annotation. Without one, a
 * `readonly` initialiser infers a literal type (`"BACKEND_UNAVAILABLE"`, `true`) and
 * any subclass that overrides it fails to compile with TS2416.
 */
export type Submission =
  /** The request provably never left this process, or was refused before the model saw it. */
  | "not-submitted"
  /** It may or may not have reached the model. Treat as spent. */
  | "uncertain"
  /** It definitely reached the model. Quota is gone. */
  | "submitted";

export abstract class SubpixelError extends Error {
  abstract readonly code: string;
  abstract readonly submission: Submission;

  /**
   * Set false by failures that are pre-submit but that no sibling backend can help
   * with: an account-wide throttle, or a local configuration mistake.
   */
  protected readonly fallbackUseful: boolean = true;

  /**
   * The process exit code for this failure, per the spec's taxonomy table.
   *
   * It lives on the error rather than in a switch in `bin.ts` because a switch has
   * to be kept in step with the class hierarchy by hand, and the one that is
   * forgotten is always the new subclass. A default of 1 means a new error class is
   * merely uninformative rather than wrong.
   */
  readonly exitCode: number = 1;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }

  get canFallback(): boolean {
    return this.submission === "not-submitted" && this.fallbackUseful;
  }
}

/**
 * The backend could not be reached at all: DNS failure, refused connection, TLS
 * failure, missing `codex` binary, or a pre-submit 404. Nothing was submitted.
 *
 * A 5xx is NOT this class. See `SubmissionUncertain`.
 */
export class BackendUnavailable extends SubpixelError {
  readonly code: string = "BACKEND_UNAVAILABLE";
  readonly submission: Submission = "not-submitted";
  override readonly exitCode: number = 5;
}

/**
 * The transport failed in a way that cannot prove whether the server accepted the
 * request. This is the safe default for every ambiguous failure.
 *
 * It never falls back, because the upstream may be generating the image right now.
 */
export class SubmissionUncertain extends SubpixelError {
  readonly code: string = "SUBMISSION_UNCERTAIN";
  readonly submission: Submission = "uncertain";
}

/** Credentials are missing, malformed, or rejected. Nothing was submitted. */
export class AuthExpired extends SubpixelError {
  readonly code: string = "AUTH_EXPIRED";
  readonly submission: Submission = "not-submitted";
  override readonly exitCode: number = 3;
}

/**
 * The subscription hit its rate limit.
 *
 * This extends BackendUnavailable because callers reasonably group "the backend
 * said no" together for reporting. Nothing was submitted, but `fallbackUseful` is
 * false: a 429 means the account is throttled, so every other subscription-backed
 * backend will also refuse, and the paid API backend must never be reached for free.
 */
export class RateLimited extends BackendUnavailable {
  override readonly code: string = "RATE_LIMITED";
  protected override readonly fallbackUseful: boolean = false;
  override readonly exitCode: number = 4;
  constructor(message: string, readonly resetsAt?: string, cause?: unknown) {
    super(message, cause);
  }
}

/** The model or its safety system refused the prompt. Quota was consumed. */
export class ContentBlocked extends SubpixelError {
  readonly code: string = "CONTENT_BLOCKED";
  readonly submission: Submission = "submitted";
}

/**
 * The backend rejected the request itself — malformed geometry, an unsupported
 * parameter, a payload the tool would not take.
 *
 * Submission is "uncertain" on purpose. A 400 usually predates generation, but the
 * body is not a contract and nothing in it proves the request never ran. Retrying it
 * on another backend, or on another driver model, is not permitted.
 */
export class ModelRejected extends SubpixelError {
  readonly code: string = "MODEL_REJECTED";
  readonly submission: Submission = "uncertain";
  constructor(message: string, readonly model?: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * The named driver model does not exist, is not visible to this account, or is not
 * accepted by this endpoint. This is a routing failure that provably precedes
 * generation: the server could not have run a model it says it does not have.
 *
 * This is the ONLY error that permits driver-model recovery. See Task 16.
 */
export class ModelUnavailable extends SubpixelError {
  readonly code: string = "MODEL_UNAVAILABLE";
  readonly submission: Submission = "not-submitted";
  constructor(message: string, readonly model?: string, cause?: unknown) {
    super(message, cause);
  }
}

/** The stream started and then died. Quota may have been consumed. */
export class StreamAborted extends SubpixelError {
  readonly code: string = "STREAM_ABORTED";
  readonly submission: Submission = "submitted";
}

/** A configuration or usage error on the local side. No backend can fix it. */
export class ConfigError extends SubpixelError {
  readonly code: string = "CONFIG_ERROR";
  readonly submission: Submission = "not-submitted";
  protected override readonly fallbackUseful: boolean = false;
  override readonly exitCode: number = 2;
}

/**
 * `spx sync --check` found that the generated assets do not match `assets.yml`.
 *
 * This is not a failure of the tool. It is the tool's ANSWER, delivered as an exit
 * code so a CI job can gate on it, in the same way `git diff --exit-code` reports a
 * difference. Nothing was submitted and nothing was spent; `--check` never touches
 * the network.
 */
export class DriftDetected extends SubpixelError {
  readonly code: string = "DRIFT_DETECTED";
  readonly submission: Submission = "not-submitted";
  protected override readonly fallbackUseful: boolean = false;
  override readonly exitCode: number = 6;
}

/**
 * A local failure that happened AFTER a successful generation: post-processing,
 * writing, or sidecar authoring. The bytes exist and must not be regenerated.
 */
export class OutputError extends SubpixelError {
  readonly code: string = "OUTPUT_ERROR";
  readonly submission: Submission = "submitted";
  protected override readonly fallbackUseful: boolean = false;
}

/**
 * Signatures of "this model does not exist for you", as distinct from every other
 * kind of 400. Deliberately narrow: an unrecognised 400 must fall through to
 * `ModelRejected`, which never retries. A false positive here spends quota twice.
 *
 * **The word "support" is deliberately absent.** An earlier draft matched
 * `model … not supported` and `model … does not support`. Both match the very
 * common "This model does not support the requested image size", which is a
 * PARAMETER rejection: the model exists, the account has it, and the next
 * candidate will reject the same parameter for the same reason. Classifying that
 * as `ModelUnavailable` walks the whole candidate list spending quota on a request
 * that was malformed from the start. Existence and entitlement are the only two
 * things this list is allowed to recognise.
 */
/**
 * A run of at most 40 characters that stays inside one sentence.
 *
 * A dot only ends a sentence when whitespace or the end of the string follows it.
 * A plain `[^.]` run breaks on the dot inside a version number, so "The model
 * `gpt-image-2.5-flare` is not available" stopped being recognised as an
 * availability verdict at all and fell through to `ContentBlocked`.
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\bmodel_not_found\b/i,
  /\bunknown[_ ]model\b/i,
  /\binvalid[_ ]model\b/i,
  /\bmodel\b(?:[^.]|\.(?=\S)){0,40}\bnot (?:found|available|enabled)\b/i,
  /\bmodel\b(?:[^.]|\.(?=\S)){0,40}\bdoes not exist\b/i,
  /\bdo(?:es)? not have access to\b(?:[^.]|\.(?=\S)){0,40}\bmodel\b/i,
];

/**
 * Phrases that mean "your request was wrong", even when the word `model` appears.
 * Checked FIRST, so a message matching both is never treated as retryable.
 */
const PARAMETER_REJECTION_PATTERNS: readonly RegExp[] = [
  /\bdoes not support\b/i,
  /\bnot supported\b/i,
  /\bunsupported\b/i,
  /\binvalid (?:value|parameter|size|dimension|argument)\b/i,
];

export function looksLikeModelUnavailable(body: string): boolean {
  if (PARAMETER_REJECTION_PATTERNS.some((pattern) => pattern.test(body))) return false;
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Quoting, punctuation, and the filler words that sit between a verdict and the
 * slug it is about. Bounded, so "driver-a" and a verdict three clauses away in the
 * same sentence are not treated as related.
 */
const VERDICT_FILLER = String.raw`(?:\W|\b(?:the|a|model|engine|is|was|has|been|currently)\b){0,8}`;

/**
 * The two orders an availability verdict can name its subject in. `SLUG` is
 * substituted with the escaped, token-delimited slug we actually sent.
 */
const DRIVER_UNAVAILABLE_TEMPLATES: readonly string[] = [
  // "<slug> not found", "`<slug>` does not exist", "model <slug> is not enabled"
  String.raw`SLUG${VERDICT_FILLER}(?:not (?:found|available|enabled)|does not exist|unknown|invalid)\b`,
  // "unknown model: <slug>", "does not have access to the model <slug>"
  String.raw`\b(?:model_not_found|unknown[_ ]model|invalid[_ ]model|no such model|not (?:found|available|enabled)|does not exist|do(?:es)? not have access to)${VERDICT_FILLER}SLUG`,
];

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this rejection name the driver model we sent, as the subject of the verdict?
 *
 * `looksLikeModelUnavailable` recognises the SHAPE of an availability rejection,
 * never its subject, and two different models are in play on every request: the
 * driver model in the URL body, and the image model configured inside the
 * `image_generation` tool. Only the first is what driver-model recovery advances.
 * "The model `gpt-image-2.5-flare` is not available" is a tool-config failure:
 * every remaining driver candidate sends the same tool and is refused identically,
 * so advancing spends the whole candidate list to be told the same thing.
 *
 * Substring containment is not enough to establish the subject, in either
 * direction. With the driver `driver-a`, "Image model driver-a-image not available"
 * contains the slug but is about a different model, so the slug has to match as a
 * whole token. "Generation for driver-a failed: the image model gpt-image-2 is not
 * available" names the driver AND carries the shape, but the verdict belongs to the
 * other model, so the slug has to sit next to the verdict rather than anywhere in
 * the body. Anything this does not recognise stays non-retryable: a false positive
 * here spends quota twice.
 */
export function rejectsDriverModel(body: string, model: string | undefined): boolean {
  if (!model) return false;
  if (!looksLikeModelUnavailable(body)) return false;
  const slug = String.raw`(?<![\w.-])${escapeForRegExp(model)}(?![\w.-])`;
  return DRIVER_UNAVAILABLE_TEMPLATES.some((template) =>
    new RegExp(template.replace("SLUG", () => slug), "i").test(body),
  );
}

export interface ClassifyContext {
  /** The driver model slug that was sent, so recovery can advance past it. */
  model?: string;
}

export function classifyHttpStatus(
  status: number,
  body: string,
  cause?: unknown,
  context: ClassifyContext = {},
): SubpixelError {
  const detail = `HTTP ${status}: ${body}`;

  if (status === 401 || status === 403) return new AuthExpired(detail, cause);
  if (status === 429) return new RateLimited(detail, undefined, cause);

  // A 404 means the route is not there. The request never reached a model.
  if (status === 404) return new BackendUnavailable(detail, cause);

  // Every 5xx is ambiguous. A gateway can return 502/504 while the upstream keeps
  // generating, so this must never be fallback-eligible.
  if (status >= 500) return new SubmissionUncertain(detail, cause);

  // Shape AND subject: a 400 that never names the model we sent as the subject of
  // its verdict cannot prove it is about the driver model, so it is not recoverable.
  if (status === 400 && rejectsDriverModel(body, context.model)) {
    return new ModelUnavailable(detail, context.model, cause);
  }

  // Everything else in 4xx: the backend said no for a reason we cannot verify.
  return new ModelRejected(detail, context.model, cause);
}

/**
 * Error codes that prove the request body was never accepted by a server. Anything
 * outside this list is ambiguous: the socket may have died after the POST landed.
 */
const PRE_SUBMIT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EACCES",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

function errorCodesOf(err: unknown, depth = 0): string[] {
  if (depth > 4 || typeof err !== "object" || err === null) return [];
  const record = err as { code?: unknown; cause?: unknown };
  const own = typeof record.code === "string" ? [record.code] : [];
  return [...own, ...errorCodesOf(record.cause, depth + 1)];
}

export interface FetchErrorContext {
  /** A complete message. Overrides `url`. */
  detail?: string;
  /** The endpoint, used to build the message when `detail` is absent. */
  url?: string;
}

/**
 * Classify a rejected `fetch`.
 *
 * `fetch` wraps the real failure: the thrown value is usually `TypeError: fetch
 * failed` with the useful code on `.cause`, so the whole chain is inspected.
 *
 * The default is `SubmissionUncertain`, not `BackendUnavailable`. Only a code on
 * the allow-list proves the server never accepted a byte. Everything else —
 * `ECONNRESET`, `EPIPE`, an unrecognised code — may be a socket that died *after*
 * the POST landed, and the job may still be running and billing upstream.
 * Guessing "safe to retry" there is how a subscription gets charged twice for one
 * image, so the ambiguous case is never fallback-eligible.
 *
 * The second argument accepts a plain string for the common "I have a message"
 * case, or a context object when only the URL is known.
 */
export function classifyFetchError(
  err: unknown,
  context: string | FetchErrorContext = {},
): SubpixelError {
  const { detail, url } = typeof context === "string" ? { detail: context, url: undefined } : context;
  const raw = err instanceof Error ? err.message : String(err);
  const message = detail ?? (url ? `The request to ${url} failed: ${raw}` : raw);
  const codes = errorCodesOf(err);

  if (codes.some((code) => PRE_SUBMIT_CODES.has(code))) {
    return new BackendUnavailable(message, err);
  }
  return new SubmissionUncertain(message, err);
}
