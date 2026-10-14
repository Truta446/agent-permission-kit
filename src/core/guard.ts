import { requestApproval } from "../approval/approval.js";
import { auditedInput, createAuditSink, defaultAuditErrorHandler } from "../audit/audit.js";
import { errorName, GuardConfigError, own } from "./errors.js";
import { isValidRequestId, isValidToolName } from "./names.js";
import { compilePolicy, type Evaluation, evaluatePolicy } from "./policies.js";
import { snapshotInput } from "./snapshot.js";
import type {
  ApprovalGrant,
  ApprovalRequest,
  AuditEvent,
  AuditEventType,
  AuditInputOption,
  DefaultDecision,
  DenialCode,
  ExecuteResult,
  Guard,
  GuardOptions,
  HandlerContext,
  PolicyResult,
  ToolMap,
} from "./types.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
const DEFAULT_POLICY_TIMEOUT_MS = 5_000;
/** Caller-supplied request ids remembered per guard for replay protection. */
const RECENT_REQUEST_IDS = 10_000;

/**
 * Creates a guard. Configuration is validated and copied here; mutating the
 * options object afterwards has no effect.
 *
 * @example
 * const guard = createGuard({
 *   rules: {
 *     "database.read": "allow",
 *     "database.delete": "deny",
 *     "payments.refund": "require_approval",
 *   },
 * });
 */
export function createGuard<TTools extends ToolMap = ToolMap, TContext = unknown>(
  // NoInfer: tool types come only from the explicit type argument. Without one
  // the guard accepts any tool name (LLM-supplied names are plain strings).
  options: GuardOptions<NoInfer<TTools>, NoInfer<TContext>>,
): Guard<TTools, TContext> {
  if (typeof options !== "object" || options === null) {
    throw new GuardConfigError("createGuard() requires an options object");
  }
  // Every option is read as an own property: a polluted Object.prototype must
  // not be able to supply an approval callback or a default decision.
  const defaultDecision = readDefaultDecision(own(options, "defaultDecision"));
  const approvalTimeoutMs = readTimeout(
    own(options, "approvalTimeoutMs"),
    "approvalTimeoutMs",
    DEFAULT_APPROVAL_TIMEOUT_MS,
  );
  const policyTimeoutMs = readTimeout(
    own(options, "policyTimeoutMs"),
    "policyTimeoutMs",
    DEFAULT_POLICY_TIMEOUT_MS,
  );
  const onApprovalRequired = readFunction(own(options, "onApprovalRequired"), "onApprovalRequired");
  const onAudit = readFunction(own(options, "onAudit"), "onAudit");
  const onAuditError =
    readFunction(own(options, "onAuditError"), "onAuditError") ?? defaultAuditErrorHandler;
  const generateRequestId =
    readFunction(own(options, "generateRequestId"), "generateRequestId") ??
    (() => crypto.randomUUID());
  const requireAudit = own(options, "requireAudit") === true;
  const auditInputOption = readAuditInput(own(options, "auditInput"));
  const policy = compilePolicy(own(options, "rules"), defaultDecision, policyTimeoutMs);

  const audit = createAuditSink(
    onAudit as ((e: AuditEvent) => void | Promise<void>) | undefined,
    onAuditError as (error: unknown, event: AuditEvent) => void,
  );
  const approve = onApprovalRequired as ((r: ApprovalRequest) => unknown) | undefined;

  // The only state shared between calls: caller-supplied ids already used.
  const seenRequestIds = new Set<string>();
  const rememberRequestId = (id: string): boolean => {
    if (seenRequestIds.has(id)) return false;
    seenRequestIds.add(id);
    if (seenRequestIds.size > RECENT_REQUEST_IDS) {
      const oldest = seenRequestIds.values().next().value;
      if (oldest !== undefined) seenRequestIds.delete(oldest);
    }
    return true;
  };

  const newRequestId = (): string => {
    const id: unknown = (generateRequestId as () => unknown)();
    if (!isValidRequestId(id))
      throw new GuardConfigError("generateRequestId() returned an invalid id");
    return id;
  };

  interface Prepared {
    readonly tool: string;
    readonly requestId: string;
    readonly input: unknown;
    readonly context: unknown;
    readonly signal: AbortSignal | undefined;
    readonly callerSuppliedId: boolean;
  }

  /** Validates a request and snapshots its input. Returns a denial on malformed input. */
  const prepare = (request: unknown): Prepared | PolicyResult => {
    const fallbackId = newRequestId();
    if (typeof request !== "object" || request === null) {
      return invalid("<invalid>", fallbackId, "Request must be an object");
    }
    const rawTool = own(request, "tool");
    const tool = isValidToolName(rawTool) ? rawTool : "<invalid>";
    const rawId = own(request, "requestId");
    if (rawId !== undefined && !isValidRequestId(rawId)) {
      return invalid(
        tool,
        fallbackId,
        "requestId must be a non-empty string of at most 256 characters",
      );
    }
    const requestId = rawId ?? fallbackId;
    if (tool === "<invalid>") return invalid(tool, requestId, "Invalid tool name");
    const signal = own(request, "signal");
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return invalid(tool, requestId, "signal must be an AbortSignal");
    }
    let input: unknown;
    try {
      const rawInput = own(request, "input");
      input = rawInput === undefined ? undefined : snapshotInput(rawInput);
    } catch {
      return invalid(tool, requestId, "Input must be JSON-compatible data");
    }
    return {
      tool,
      requestId,
      input,
      context: own(request, "context"),
      signal,
      callerSuppliedId: rawId !== undefined,
    };
  };

  const evaluate = (p: Prepared): Promise<Evaluation> =>
    evaluatePolicy(policy, {
      tool: p.tool,
      input: p.input,
      context: p.context,
      requestId: p.requestId,
    });

  const event = (
    type: AuditEventType,
    base: {
      tool: string;
      requestId: string;
      decision: PolicyResult["decision"];
      ruleId: string | null;
    },
    reason: string,
    input: unknown,
    extra: Partial<Pick<AuditEvent, "code" | "actor" | "durationMs" | "errorName">> = {},
  ): AuditEvent => {
    const logged = auditedInput(auditInputOption, input, base.tool);
    return {
      type,
      timestamp: new Date().toISOString(),
      requestId: base.requestId,
      tool: base.tool,
      decision: base.decision,
      reason,
      ruleId: base.ruleId,
      ...extra,
      ...(logged !== undefined && { input: logged }),
    };
  };

  const check: Guard<TTools, TContext>["check"] = async (request) => {
    const prepared = prepare(request);
    if (!("callerSuppliedId" in prepared)) return prepared;
    const { errorName: _omit, ...result } = await evaluate(prepared);
    return Object.freeze(result);
  };

  const execute = async (
    request: unknown,
    handler: (input: never, ctx: HandlerContext) => unknown,
  ): Promise<ExecuteResult<unknown>> => {
    if (typeof handler !== "function") {
      throw new TypeError("guard.execute() requires a handler function");
    }
    const prepared = prepare(request);
    if (!("callerSuppliedId" in prepared)) {
      await audit.emit(
        event("tool.denied", prepared, prepared.reason, undefined, { code: "invalid_request" }),
      );
      return deny(prepared, "invalid_request", prepared.reason);
    }
    const { input, signal } = prepared;

    if (prepared.callerSuppliedId && !rememberRequestId(prepared.requestId)) {
      const base = { ...prepared, decision: "deny" as const, ruleId: null };
      const reason =
        "A request with this requestId was already processed; refusing to run it again";
      await audit.emit(event("tool.denied", base, reason, input, { code: "duplicate_request" }));
      return deny(base, "duplicate_request", reason);
    }

    const evaluation = await evaluate(prepared);
    const { errorName: policyErrorName, ...verdict } = evaluation;

    if (verdict.decision === "deny") {
      const code: DenialCode = verdict.code === "policy_error" ? "policy_error" : "policy_denied";
      await audit.emit(
        event("tool.denied", verdict, verdict.reason, input, {
          code,
          ...(policyErrorName !== undefined && { errorName: policyErrorName }),
        }),
      );
      return deny(verdict, code, verdict.reason);
    }

    let approval: ApprovalGrant | undefined;
    if (verdict.decision === "require_approval") {
      if (approve !== undefined) {
        await audit.emit(event("approval.requested", verdict, verdict.reason, input));
      }
      const outcome = await requestApproval(
        approve,
        {
          requestId: verdict.requestId,
          tool: verdict.tool,
          input,
          context: prepared.context,
          reason: verdict.reason,
          ruleId: verdict.ruleId,
          requestedAt: new Date().toISOString(),
        },
        approvalTimeoutMs,
        signal,
      );
      if (!outcome.granted) {
        await audit.emit(
          event("approval.rejected", verdict, outcome.reason, input, {
            code: outcome.code,
            ...(outcome.actor !== undefined && { actor: outcome.actor }),
            ...(outcome.errorName !== undefined && { errorName: outcome.errorName }),
          }),
        );
        return deny(verdict, outcome.code, outcome.reason);
      }
      approval = outcome.grant;
      const recorded = await audit.emit(
        event("approval.granted", verdict, approval.reason ?? verdict.reason, input, {
          ...(approval.approvedBy !== undefined && { actor: approval.approvedBy }),
        }),
      );
      if (!recorded && requireAudit) {
        return deny(verdict, "audit_failed", "Audit log unavailable; refusing to execute");
      }
    } else {
      const recorded = await audit.emit(event("tool.allowed", verdict, verdict.reason, input));
      if (!recorded && requireAudit) {
        return deny(verdict, "audit_failed", "Audit log unavailable; refusing to execute");
      }
    }

    // Last chance to stop: the caller may have aborted while we were waiting.
    if (signal?.aborted) {
      const reason = "Request was aborted before execution";
      await audit.emit(event("tool.denied", verdict, reason, input, { code: "aborted" }));
      return deny(verdict, "aborted", reason);
    }

    const ctx: HandlerContext = Object.freeze({
      tool: verdict.tool,
      requestId: verdict.requestId,
      signal,
      approval,
    });
    const started = performance.now();
    let value: unknown;
    try {
      // The handler receives the same frozen snapshot that was authorized.
      value = await handler(input as never, ctx);
    } catch (error) {
      await audit.emit(
        event("execution.failed", verdict, "Handler threw", input, {
          durationMs: Math.round(performance.now() - started),
          errorName: errorName(error),
        }),
      );
      throw error;
    }
    await audit.emit(
      event("execution.succeeded", verdict, verdict.reason, input, {
        durationMs: Math.round(performance.now() - started),
      }),
    );

    return Object.freeze({
      ok: true as const,
      value,
      decision: verdict.decision,
      ruleId: verdict.ruleId,
      tool: verdict.tool,
      requestId: verdict.requestId,
      ...(approval !== undefined && { approval }),
    });
  };

  return Object.freeze({
    check,
    execute: execute as Guard<TTools, TContext>["execute"],
  });
}

function invalid(tool: string, requestId: string, reason: string): PolicyResult {
  return Object.freeze({
    decision: "deny" as const,
    reason,
    ruleId: null,
    code: "invalid_request" as const,
    tool,
    requestId,
  });
}

function deny(
  base: {
    tool: string;
    requestId: string;
    decision: PolicyResult["decision"];
    ruleId: string | null;
  },
  code: DenialCode,
  reason: string,
): ExecuteResult<never> {
  return Object.freeze({
    ok: false as const,
    code,
    reason,
    decision: base.decision,
    ruleId: base.ruleId,
    tool: base.tool,
    requestId: base.requestId,
  });
}

function readDefaultDecision(value: unknown): DefaultDecision {
  if (value === undefined) return "deny";
  if (value === "deny" || value === "require_approval") return value;
  throw new GuardConfigError(
    `defaultDecision must be "deny" or "require_approval" (got ${JSON.stringify(value)}). ` +
      `"allow" is not supported as a default; allow tools explicitly.`,
  );
}

function readTimeout(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new GuardConfigError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

function readFunction(value: unknown, name: string): ((...args: never[]) => unknown) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new GuardConfigError(`${name} must be a function`);
  return value as (...args: never[]) => unknown;
}

function readAuditInput(value: unknown): AuditInputOption {
  if (value === undefined || value === false) return false;
  if (value === true || typeof value === "function") return value as AuditInputOption;
  throw new GuardConfigError("auditInput must be a boolean or a function");
}
