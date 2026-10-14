/** Thrown synchronously by `createGuard()` for invalid configuration. */
export class GuardConfigError extends Error {
  override name = "GuardConfigError";
}

/** Error class name for audit events. Messages are never recorded: they may echo sensitive input. */
export function errorName(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.name === "string") return error.name.slice(0, 100);
  } catch {
    // A hostile `name` getter must not break error handling.
  }
  return error === null ? "null" : typeof error;
}

/**
 * Reads an own property only. Used for every security-relevant field read from
 * caller-supplied objects, so a polluted `Object.prototype` (for example
 * `Object.prototype.approved = true`) cannot supply a value.
 */
export function own(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}
