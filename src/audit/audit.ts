import { snapshotInput } from "../core/snapshot.js";
import type { AuditEvent, AuditHandler, AuditInputOption } from "../core/types.js";

/** Key names whose values are replaced by `"[REDACTED]"` when `auditInput: true`. */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|auth|cookie|session|credential|private[-_]?key|ssn|card|cvv|cvc|iban|account[-_]?number|pin$/i;

export const REDACTED = "[REDACTED]";

/**
 * Returns a deep copy of a (snapshotted) input with the values of
 * sensitive-looking keys replaced. Key-based redaction is a best-effort
 * safety net, not a guarantee: free-text fields can still contain secrets.
 */
export function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(redactInput));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: SENSITIVE_KEY.test(key)
          ? REDACTED
          : redactInput((value as Record<string, unknown>)[key]),
        enumerable: true,
      });
    }
    return Object.freeze(out);
  }
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
): AuditSink {
  return {
    async emit(event) {
      if (handler === undefined) return true;
      const frozen = Object.freeze(event);
      try {
        // The handler's return value is ignored and the event is frozen, so a
        // handler cannot change the decision it is reporting.
        await handler(frozen);
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
