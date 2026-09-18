const MASK = "[REDACTED]";

/**
 * Patterns are ordered from most specific to least. Each one is applied to the
 * whole string, so overlapping matches are fine.
 *
 * ponytail: four shapes, chosen to cover what this tool actually handles — the
 * two JWTs in auth.json and the headers they travel in. This is a last line of
 * defence over text that should not have held a credential at all, not a secret
 * scanner: no vendor prefixes (ghp_, AKIA, xox...), so a third-party key pasted
 * into a prompt survives into the manifest as prompt text, and the JSON-field
 * pattern stops at the first `"` in a value so a token containing an escaped
 * quote is masked only up to it. Documented under Redaction in SECURITY.md.
 * Add prefixes if prompts ever start carrying other people's credentials.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // JWT: three base64url segments. Codex id_token and access_token are both JWTs.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, MASK],
  // OpenAI-style keys.
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, MASK],
  // Authorization headers, in any casing.
  [/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, `$1 ${MASK}`],
  // JSON fields that hold credentials, whatever their value shape.
  [
    /("(?:access_token|refresh_token|id_token|api_key|client_secret)"\s*:\s*")[^"]*(")/g,
    `$1${MASK}$2`,
  ],
];

/** Convert any value to a string and mask anything that looks like a credential. */
export function redact(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
