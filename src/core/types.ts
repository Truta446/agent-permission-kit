/**
 * A policy decision. It describes what policy *requires*, never what has
 * already happened: `"require_approval"` means a human must approve the call,
 * not that a human has approved it.
 */
export type Decision = "allow" | "deny" | "require_approval";

/** Decisions accepted as `defaultDecision`. `"allow"` is deliberately excluded. */
export type DefaultDecision = "deny" | "require_approval";

/**
 * Map of tool name to input type. Supplying it to `createGuard<Tools>()` gives
 * typed rule conditions and autocomplete for tool names. Without it, any tool
 * name is accepted and inputs are `unknown`.
 */
export type ToolMap = Record<string, unknown>;

/** Recursively readonly view of a value. Inputs are frozen at runtime too. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Tool names usable for a given tool map. */
export type ToolName<TTools extends ToolMap> = keyof TTools & string;

/** `prefix.*` — matches every tool whose name starts with `prefix.`. */
export type WildcardPattern = `${string}.*`;

/** What a policy function sees. Everything here is read-only. */
export interface PolicyContext<TInput = unknown, TContext = unknown> {
  readonly tool: string;
  /** Frozen snapshot of the input. The handler receives this exact object. */
  readonly input: DeepReadonly<TInput>;
  /** Application context passed with the request (not copied; treat as trusted). */
  readonly context: TContext | undefined;
  readonly requestId: string;
}

/** A policy function may return a bare decision or a decision with a reason. */
export type RuleResult = Decision | { readonly decision: Decision; readonly reason?: string };

/**
 * A policy function. This is trusted application code: it runs in-process with
 * full privileges. Never build one from an untrusted document.
 */
export type PolicyFunction<TInput = unknown, TContext = unknown> = (
  ctx: PolicyContext<TInput, TContext>,
) => RuleResult | Promise<RuleResult>;

/** A rule is either a fixed decision or a policy function. */
export type Rule<TInput = unknown, TContext = unknown> =
  | Decision
  | PolicyFunction<TInput, TContext>;

/** Rule table: exact tool names plus optional `prefix.*` wildcards. */
export type Rules<TTools extends ToolMap, TContext> = {
  [K in ToolName<TTools>]?: Rule<TTools[K], TContext>;
} & {
  [K in WildcardPattern]?: Rule<unknown, TContext>;
};

/** A tool call to authorize. */
export interface ToolRequest<TName extends string = string, TInput = unknown, TContext = unknown> {
  readonly tool: TName;
  readonly input?: TInput;
  /** Application data for policies (user, tenant, scopes…). Not logged. */
  readonly context?: TContext;
  /**
   * Caller-supplied identifier, e.g. the LLM's tool-call id. When present,
   * `execute()` refuses to run the same id twice on this guard.
   */
  readonly requestId?: string;
  /** Aborts approval waiting and is forwarded to the handler. */
  readonly signal?: AbortSignal;
}

/** Typed request: tool name narrows the input type. */
export type GuardRequest<TTools extends ToolMap, TContext> = {
  [K in ToolName<TTools>]: ToolRequest<K, TTools[K], TContext>;
}[ToolName<TTools>];

/** How a policy result was reached. */
export type PolicyCode =
  /** A rule matched and produced the decision. */
  | "rule"
  /** No rule matched; `defaultDecision` applied. */
  | "default"
  /** The request was malformed (bad tool name, non-serializable input…). Always deny. */
  | "invalid_request"
  /** A policy function threw, timed out, or returned an invalid value. Always deny. */
  | "policy_error";

/** Result of `guard.check()` — the policy verdict only. Nothing has been executed or approved. */
export interface PolicyResult {
  readonly decision: Decision;
  readonly reason: string;
  /** The rule key that matched (`"payments.refund"`, `"database.*"`), or `null`. */
  readonly ruleId: string | null;
  readonly code: PolicyCode;
  readonly tool: string;
  readonly requestId: string;
}

/** Why `execute()` refused to run the handler. */
export type DenialCode =
  | "policy_denied"
  | "invalid_request"
  | "policy_error"
  | "duplicate_request"
  | "approval_unavailable"
  | "approval_rejected"
  | "approval_invalid"
  | "approval_error"
  | "approval_timeout"
  | "aborted"
  | "audit_failed";

/** Record of a granted approval, as reported by the approval callback. */
export interface ApprovalGrant {
  /** Identifier of the approver as reported by your callback. Not verified by this library. */
  readonly approvedBy?: string;
  readonly reason?: string;
}

export type ExecuteResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly decision: "allow" | "require_approval";
      readonly ruleId: string | null;
      readonly tool: string;
      readonly requestId: string;
      /** Present when the call went through human approval. */
      readonly approval?: ApprovalGrant;
    }
  | {
      readonly ok: false;
      readonly code: DenialCode;
      readonly reason: string;
      readonly decision: Decision;
      readonly ruleId: string | null;
      readonly tool: string;
      readonly requestId: string;
    };

/** Second argument passed to the protected handler. */
export interface HandlerContext {
  readonly tool: string;
  readonly requestId: string;
  /** The caller's signal, if any. The guard never cancels a running handler by itself. */
  readonly signal: AbortSignal | undefined;
  readonly approval: ApprovalGrant | undefined;
}

export type ToolHandler<TInput, TResult> = (
  input: DeepReadonly<TInput>,
  ctx: HandlerContext,
) => TResult | Promise<TResult>;

// ---------------------------------------------------------------- approval

export interface ApprovalRequest<
  TName extends string = string,
  TInput = unknown,
  TContext = unknown,
> {
  readonly requestId: string;
  readonly tool: TName;
  /** The exact frozen input that will be passed to the handler if approved. */
  readonly input: DeepReadonly<TInput>;
  readonly context: TContext | undefined;
  /** Why approval is required (from the rule). */
  readonly reason: string;
  readonly ruleId: string | null;
  /** ISO-8601 time the approval was requested. */
  readonly requestedAt: string;
  /** Aborted on timeout or when the caller aborts. Stop waiting for a human when it fires. */
  readonly signal: AbortSignal;
}

export type GuardApprovalRequest<TTools extends ToolMap, TContext> = {
  [K in ToolName<TTools>]: ApprovalRequest<K, TTools[K], TContext>;
}[ToolName<TTools>];

/**
 * What the approval callback must resolve to. Only `{ approved: true }` (the
 * boolean `true`) grants approval. Anything else — `"yes"`, `1`, `undefined`,
 * a thrown error, a timeout — is treated as not approved.
 */
export type ApprovalResponse =
  | { readonly approved: true; readonly approvedBy?: string; readonly reason?: string }
  | { readonly approved: false; readonly rejectedBy?: string; readonly reason?: string };

export type ApprovalHandler<TTools extends ToolMap, TContext> = (
  request: GuardApprovalRequest<TTools, TContext>,
) => ApprovalResponse | Promise<ApprovalResponse>;

// ------------------------------------------------------------------- audit

export type AuditEventType =
  | "tool.allowed"
  | "tool.denied"
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "execution.succeeded"
  | "execution.failed";

export interface AuditEvent {
  readonly type: AuditEventType;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  readonly requestId: string;
  readonly tool: string;
  readonly decision: Decision;
  readonly reason: string;
  readonly ruleId: string | null;
  /** Set on denials and rejections. */
  readonly code?: DenialCode;
  /** Set on `approval.granted` / `approval.rejected` when your callback reported it. */
  readonly actor?: string;
  /** Handler duration, on `execution.*` events. */
  readonly durationMs?: number;
  /** Error class name on `execution.failed` and policy errors. Messages are never included. */
  readonly errorName?: string;
  /** Only present when `auditInput` is enabled; redacted by default. */
  readonly input?: unknown;
}

export type AuditHandler = (event: AuditEvent) => void | Promise<void>;

/** `true` = include input with built-in key redaction. A function = your own redaction. */
export type AuditInputOption = boolean | ((input: unknown, tool: string) => unknown);

// ----------------------------------------------------------------- options

export interface GuardOptions<TTools extends ToolMap = ToolMap, TContext = unknown> {
  /** Rule table. Exact names win over `prefix.*`; longer prefixes win over shorter ones. */
  readonly rules: Rules<TTools, TContext>;
  /** Applied when no rule matches. Defaults to `"deny"`. `"allow"` is not accepted. */
  readonly defaultDecision?: DefaultDecision;
  /** Called for `require_approval` decisions inside `execute()`. Without it, those calls are denied. */
  readonly onApprovalRequired?: ApprovalHandler<TTools, TContext>;
  /** Max time to wait for the approval callback. Default 300 000 ms (5 min). */
  readonly approvalTimeoutMs?: number;
  /** Max time for an async policy function. Default 5 000 ms. */
  readonly policyTimeoutMs?: number;
  /** Receives structured audit events from `execute()`. */
  readonly onAudit?: AuditHandler;
  /** Called when `onAudit` throws or rejects. Defaults to `console.error`. */
  readonly onAuditError?: (error: unknown, event: AuditEvent) => void;
  /**
   * When `true`, a failure to record `tool.allowed` / `approval.granted`
   * blocks execution (fail closed). Default `false`.
   */
  readonly requireAudit?: boolean;
  /** Include tool input in audit events. Default `false` (input is never logged). */
  readonly auditInput?: AuditInputOption;
  /** Request id generator. Defaults to `crypto.randomUUID()`. */
  readonly generateRequestId?: () => string;
}

export interface Guard<TTools extends ToolMap = ToolMap, TContext = unknown> {
  /**
   * Evaluates policy only. Never calls the approval callback, never emits
   * audit events, never executes anything. A `require_approval` result means
   * approval is *needed*, not granted.
   */
  check(request: GuardRequest<TTools, TContext>): Promise<PolicyResult>;

  /**
   * Evaluates policy, obtains approval if required, then calls `handler`
   * at most once with the frozen input snapshot that was authorized.
   * Refusals resolve to `{ ok: false }`; handler errors are re-thrown.
   */
  execute<K extends ToolName<TTools>, TInput extends TTools[K], TResult>(
    // The handler's input type is inferred from `request.input`; with a typed
    // tool map it must also satisfy that tool's declared input type.
    request: ToolRequest<K, TInput, TContext>,
    handler: ToolHandler<TInput, TResult>,
  ): Promise<ExecuteResult<Awaited<TResult>>>;
}
