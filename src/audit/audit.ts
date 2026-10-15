import { snapshotInput } from "../core/snapshot.js";
import { runWithDeadline } from "../core/timeout.js";
import type { AuditEvent, AuditHandler, AuditInputOption } from "../core/types.js";

/** Key names whose values are replaced by `"[REDACTED]"` when `auditInput: true`. */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|token|auth|bearer|jwt|cookie|session|credential|private[-_]?key|access[-_]?key|signing[-_]?key|api[-_]?key|[-_]key$|^key$|otp|mfa|2fa|mnemonic|seed|ssn|card|cvv|cvc|iban|account[-_]?number|pin(code)?$|^pin|database[-_]?url|dsn|conn(ection)?[-_]?string/i;

/** `scheme://user:password@host` — credentials embedded in URLs inside string values. */
// Bounded and anchored on a word boundary: an unbounded scheme (`[a-z][…]*://`)
// is retried from every position of a long word, which is quadratic.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi;

/**
 * Secret-shaped values inside strings, whatever the key is called. Each
 * pattern is anchored on a fixed prefix or structure, so matching stays linear.
 */
const SECRET_VALUES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
  /\b(sk|rk|pk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, // Stripe / OpenAI / Anthropic style
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

export const REDACTED = "[REDACTED]";

/**
 * Returns a deep copy of a (snapshotted) input with the values of
 * sensitive-looking keys replaced. Key-based redaction is a best-effort
 * safety net, not a guarantee: free-text fields can still contain secrets.
 */
export function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(redactInput));
  if (typeof value === "object" && value !== null) {
    // `{ name: "API_KEY", value: "…" }` / `{ key: "password", value: "…" }`:
    // the key name lives in a sibling field.
    const label = (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).key;
    const labelledSecret = typeof label === "string" && SENSITIVE_KEY.test(label);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value:
          SENSITIVE_KEY.test(key) || (labelledSecret && key === "value")
            ? REDACTED
            : redactInput((value as Record<string, unknown>)[key]),
        enumerable: true,
      });
    }
    return Object.freeze(out);
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

/** Builds the `input` field of an audit event, or `undefined` to omit it. */
export function auditedInput(option: AuditInputOption, input: unknown, tool: string): unknown {
  if (option === false) return undefined;
  if (option === true) return redactInput(input);
  try {
    // Custom redactors get a frozen input and their output is re-validated so
    // a redactor cannot smuggle live objects into the event stream.
    return snapshotInput(option(input, tool));
  } catch {
    return "[UNAVAILABLE]";
  }
}

export interface AuditSink {
  /** Resolves `true` if the event was recorded (or no handler is configured). Never throws. */
  emit(event: AuditEvent): Promise<boolean>;
}

export function createAuditSink(
  handler: AuditHandler | undefined,
  onError: (error: unknown, event: AuditEvent) => void,
  timeoutMs: number,
): AuditSink {
  return {
    async emit(event) {
      if (handler === undefined) return true;
      const frozen = Object.freeze(event);
      try {
        // The handler's return value is ignored and the event is frozen, so a
        // handler cannot change the decision it is reporting.
        // Bounded: a hung logger must not hang the tool call. A timeout counts
        // as "not recorded" (which blocks execution under `requireAudit`).
        await runWithDeadline(() => handler(frozen), timeoutMs);
        return true;
      } catch (error) {
        try {
          onError(error, frozen);
        } catch {
          // An error reporter that throws must not affect authorization either.
        }
        return false;
      }
    },
  };
}

export function defaultAuditErrorHandler(error: unknown, event: AuditEvent): void {
  console.error(
    `[agent-permission-kit] audit handler failed for ${event.type} (${event.requestId})`,
    error,
  );
}

function redactString(value: string): string {
  let out = value.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, REDACTED);
  return out;
}
