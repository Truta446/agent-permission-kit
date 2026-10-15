/**
 * Vercel AI SDK adapter (`ai` v7+): plugs a guard into the SDK's native
 * `toolApproval` option of `generateText`, `streamText` and `ToolLoopAgent`.
 *
 * | Guard decision     | AI SDK status   |
 * |--------------------|-----------------|
 * | `allow`            | `approved`      |
 * | `deny`             | `denied`        |
 * | `require_approval` | `user-approval` |
 *
 * This is a check-only integration: the SDK executes the tool itself, so the
 * guard's frozen-snapshot binding does not apply. When you need it, also call
 * `guard.execute()` inside the tool's `execute`. Decisions are audited as
 * `policy.evaluated` events.
 */
import type { Guard } from "../core/types.js";
import { toRequestId } from "./shared.js";

/** The subset of the AI SDK's approval-function argument this adapter reads. */
export interface AiSdkToolApprovalOptions {
  toolCall: { toolName: string; toolCallId?: string; input: unknown };
  runtimeContext?: unknown;
  toolsContext?: unknown;
}

export type AiSdkApprovalStatus =
  | { type: "approved"; reason?: string }
  | { type: "denied"; reason?: string }
  | { type: "user-approval"; reason?: string };

export interface ToolApprovalAdapterOptions<TContext> {
  /** Builds the policy `context`, e.g. from `runtimeContext`. */
  context?: (options: AiSdkToolApprovalOptions) => TContext;
  /** Emit `policy.evaluated` audit events. Default `true`. */
  audit?: boolean;
}

const STATUS = {
  allow: "approved",
  deny: "denied",
  require_approval: "user-approval",
} as const;

/**
 * @example
 * const result = await generateText({
 *   model,
 *   tools,
 *   toolApproval: toolApproval(guard, { context: ({ runtimeContext }) => runtimeContext.user }),
 * });
 */
export function toolApproval<TContext = unknown>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
  guard: Guard<any, any>,
  options: ToolApprovalAdapterOptions<TContext> = {},
): (options: AiSdkToolApprovalOptions) => Promise<AiSdkApprovalStatus> {
  return async (call) => {
    const context = options.context?.(call);
    const result = await guard.check(
      {
        tool: call.toolCall.toolName,
        input: call.toolCall.input,
        ...(context !== undefined && { context }),
        ...toRequestId(call.toolCall.toolCallId),
      },
      { audit: options.audit !== false },
    );
    return { type: STATUS[result.decision], reason: result.reason };
  };
}
