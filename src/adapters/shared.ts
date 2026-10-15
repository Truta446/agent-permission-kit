import { isValidRequestId } from "../core/names.js";

/**
 * Framework tool-call ids become the guard's `requestId` (audit correlation
 * and, in `execute()`, replay protection) only when they are valid ids. An
 * unusual id is dropped rather than turning every call into `invalid_request`.
 */
export function toRequestId(id: unknown): { requestId: string } | Record<string, never> {
  return isValidRequestId(id) ? { requestId: id } : {};
}
