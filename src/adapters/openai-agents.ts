/**
 * OpenAI Agents JS adapter (`@openai/agents`): `needsApproval` plus an
 * `execute` wrapper for `tool({ ... })`.
 *
 * The SDK's approval hook is a boolean, so it can't express "deny". Use
 * `guardTool()`, which provides both halves:
 *
 * | Guard decision     | `needsApproval` | `execute`                          |
 * |--------------------|-----------------|------------------------------------|
 * | `allow`            | `false`         | runs your function                 |
 * | `require_approval` | `true`          | runs after the SDK's human approval|
 * | `deny`             | `false`         | refuses; the model gets the reason |
 *
 * `execute` re-checks the policy, so a denial holds even if the SDK's approval
 * state was resumed or edited. If you use `needsApproval()` alone, a denied
 * call is sent to a human (`true`) rather than silently allowed.
 */
import type { Guard } from "../core/types.js";
import { toRequestId } from "./shared.js";

/** The parts of the SDK's `RunContext` this adapter reads. */
export interface OpenAiRunContextLike {
  context?: unknown;
}

export interface OpenAiAgentsAdapterOptions<TContext> {
  /** Builds the policy `context` from the SDK's run context (`runContext.context`). */
  context?: (runContext: OpenAiRunContextLike | undefined) => TContext;
  /** Emit `policy.evaluated` audit events. Default `true`. */
  audit?: boolean;
  /** Result returned to the model when `execute` refuses. */
  onDenied?: (denial: { tool: string; reason: string }) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
type AnyGuard = Guard<any, any>;

async function decide<TContext>(
  guard: AnyGuard,
  toolName: string,
  input: unknown,
  runContext: OpenAiRunContextLike | undefined,
  callId: unknown,
  options: OpenAiAgentsAdapterOptions<TContext>,
) {
  const context = options.context?.(runContext);
  return guard.check(
    {
      tool: toolName,
      input,
      ...(context !== undefined && { context }),
      ...toRequestId(callId),
    },
    { audit: options.audit !== false },
  );
}

/**
 * Standalone approval function. A denied call returns `true` (sent to a human)
 * because a boolean can't refuse; prefer `guardTool()`.
 */
export function needsApproval<TContext = unknown>(
  guard: AnyGuard,
  toolName: string,
  options: OpenAiAgentsAdapterOptions<TContext> = {},
): (runContext: OpenAiRunContextLike, input: unknown, callId?: string) => Promise<boolean> {
  return async (runContext, input, callId) =>
    (await decide(guard, toolName, input, runContext, callId, options)).decision !== "allow";
}

/**
 * @example
 * const refund = tool({
 *   name: "payments_refund",
 *   description: "Refund a payment",
 *   parameters: z.object({ amount: z.number() }),
 *   ...guardTool(guard, "payments_refund", async ({ amount }) => refunds.create(amount)),
 * });
 */
export function guardTool<TInput, TRunContext extends OpenAiRunContextLike | undefined, TResult>(
  guard: AnyGuard,
  toolName: string,
  execute: (
    input: TInput,
    runContext?: TRunContext,
    ...rest: unknown[]
  ) => TResult | Promise<TResult>,
  options: OpenAiAgentsAdapterOptions<unknown> = {},
): {
  needsApproval: (
    runContext: OpenAiRunContextLike,
    input: TInput,
    callId?: string,
  ) => Promise<boolean>;
  execute: (
    input: TInput,
    runContext?: TRunContext,
    ...rest: unknown[]
  ) => Promise<TResult | unknown>;
} {
  const onDenied =
    options.onDenied ??
    ((d: { tool: string; reason: string }) =>
      `Tool call "${d.tool}" was not executed: ${d.reason}`);
  return {
    needsApproval: async (runContext, input, callId) =>
      (await decide(guard, toolName, input, runContext, callId, options)).decision ===
      "require_approval",
    execute: async (input, runContext, ...rest) => {
      // Not audited again: needsApproval already recorded this call's decision.
      const result = await decide(guard, toolName, input, runContext, undefined, {
        ...options,
        audit: false,
      });
      if (result.decision === "deny") return onDenied({ tool: toolName, reason: result.reason });
      return execute(input, runContext, ...rest);
    },
  };
}
