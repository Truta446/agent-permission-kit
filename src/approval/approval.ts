import { safeString } from "../core/decisions.js";
import { errorName, own } from "../core/errors.js";
import { AbortedError, runWithDeadline, TimeoutError } from "../core/timeout.js";
import type { ApprovalGrant, ApprovalRequest, DenialCode } from "../core/types.js";

/**
 * Outcome of one approval attempt. The lifecycle is:
 *
 *   required ─► requested ─► granted
 *                        └─► not granted: rejected | invalid | error | timeout | aborted
 *
 * There is no "pending" state that survives the call: the callback either
 * settles with a valid response before the deadline, or the request is not
 * approved. Approvals are single-use and bound to one `execute()` call.
 */
export type ApprovalOutcome =
  | { readonly granted: true; readonly grant: ApprovalGrant }
  | {
      readonly granted: false;
      readonly code: Extract<
        DenialCode,
        | "approval_unavailable"
        | "approval_rejected"
        | "approval_invalid"
        | "approval_error"
        | "approval_timeout"
        | "aborted"
      >;
      readonly reason: string;
      readonly actor?: string;
      readonly errorName?: string;
    };

type Callback = (request: ApprovalRequest) => unknown;

export async function requestApproval(
  callback: Callback | undefined,
  request: Omit<ApprovalRequest, "signal">,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  if (callback === undefined) {
    return {
      granted: false,
      code: "approval_unavailable",
      reason: "Human approval required but no approval handler is configured; denied",
    };
  }

  let raw: unknown;
  try {
    raw = await runWithDeadline(
      (approvalSignal) => callback(Object.freeze({ ...request, signal: approvalSignal })),
      timeoutMs,
      signal,
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { granted: false, code: "approval_timeout", reason: "Approval timed out; denied" };
    }
    if (error instanceof AbortedError) {
      return {
        granted: false,
        code: "aborted",
        reason: "Request was aborted while awaiting approval",
      };
    }
    return {
      granted: false,
      code: "approval_error",
      reason: "Approval handler failed; denied",
      errorName: errorName(error),
    };
  }

  return parseApprovalResponse(raw);
}

/** Only an object whose own `approved` field is the boolean `true` grants approval. */
export function parseApprovalResponse(raw: unknown): ApprovalOutcome {
  try {
    if (typeof raw !== "object" || raw === null) {
      return {
        granted: false,
        code: "approval_invalid",
        reason: "Invalid approval response; denied",
      };
    }
    const approved = own(raw, "approved");
    const reason = safeString(own(raw, "reason"));
    if (approved === true) {
      const approvedBy = safeString(own(raw, "approvedBy"));
      const grant: ApprovalGrant = {
        ...(approvedBy !== undefined && { approvedBy }),
        ...(reason !== undefined && { reason }),
      };
      return { granted: true, grant: Object.freeze(grant) };
    }
    if (approved === false) {
      const actor = safeString(own(raw, "rejectedBy"));
      return {
        granted: false,
        code: "approval_rejected",
        reason: reason ?? "Approval rejected",
        ...(actor !== undefined && { actor }),
      };
    }
    return {
      granted: false,
      code: "approval_invalid",
      reason: "Invalid approval response; denied",
    };
  } catch {
    // A throwing getter on the response object.
    return {
      granted: false,
      code: "approval_invalid",
      reason: "Invalid approval response; denied",
    };
  }
}
