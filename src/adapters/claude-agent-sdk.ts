/**
 * Claude Agent SDK adapter (`@anthropic-ai/claude-agent-sdk`).
 *
 * - `preToolUseHook(guard)`: a `PreToolUse` hook. Hooks run before permission
 *   rules and modes, so this is the place to enforce default deny: tools a
 *   permissive mode would auto-approve are still checked.
 * - `canUseTool(guard)`: the SDK's permission callback. It runs `guard.execute()`
 *   (approval callback, replay protection on `toolUseID`, audit) and returns
 *   the authorized snapshot as `updatedInput`, so the tool runs with exactly
 *   the arguments that were approved. The SDK only calls it for calls that
 *   reach the "ask" stage, so pair it with the hook.
 *
 * | Guard decision     | PreToolUse hook         | canUseTool                   |
 * |--------------------|-------------------------|------------------------------|
 * | `allow`            | `allow` (or `defer`)    | `allow` + snapshot           |
 * | `deny`             | `deny` + reason         | `deny` + reason              |
 * | `require_approval` | `ask`                   | your `onApprovalRequired`    |
 *
 * Tool names are the SDK's (`Bash`, `Read`, `mcp__server__tool`).
 */
import type { Guard } from "../core/types.js";
import { toRequestId } from "./shared.js";

// biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
type AnyGuard = Guard<any, any>;

/** The fields of the SDK's `PreToolUseHookInput` this adapter reads. */
export interface PreToolUseInputLike {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  session_id?: string;
  cwd?: string;
}

export interface PreToolUseHookOptions<TContext> {
  context?: (input: PreToolUseInputLike) => TContext;
  /**
   * What an allowed call returns. `"allow"` (default) skips the SDK's own
   * permission prompt; `"defer"` lets the SDK's permission flow continue.
   */
  onAllow?: "allow" | "defer";
  /** Emit `policy.evaluated` audit events. Default `true`. */
  audit?: boolean;
}

export interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason: string;
  };
}

export function preToolUseHook<TContext = unknown>(
  guard: AnyGuard,
  options: PreToolUseHookOptions<TContext> = {},
): (
  input: PreToolUseInputLike,
  toolUseID: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<PreToolUseHookOutput> {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const context = options.context?.(input);
    const result = await guard.check(
      {
        tool: input.tool_name as string,
        input: input.tool_input,
        ...(context !== undefined && { context }),
        ...toRequestId(toolUseID ?? input.tool_use_id),
      },
      { audit: options.audit !== false },
    );
    const permissionDecision =
      result.decision === "allow"
        ? (options.onAllow ?? "allow")
        : result.decision === "deny"
          ? "deny"
          : "ask";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: result.reason,
      },
    };
  };
}

export interface CanUseToolOptions<TContext> {
  /** Builds the policy `context` from the tool name and the SDK's options. */
  context?: (toolName: string, sdkOptions: { toolUseID?: string }) => TContext;
}

export type CanUseToolResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export function canUseTool<TContext = unknown>(
  guard: AnyGuard,
  options: CanUseToolOptions<TContext> = {},
): (
  toolName: string,
  input: Record<string, unknown>,
  sdkOptions: { signal: AbortSignal; toolUseID?: string },
) => Promise<CanUseToolResult> {
  return async (toolName, input, sdkOptions) => {
    const context = options.context?.(toolName, sdkOptions);
    const result = await guard.execute(
      {
        tool: toolName,
        input,
        signal: sdkOptions.signal,
        ...(context !== undefined && { context }),
        ...toRequestId(sdkOptions.toolUseID),
      },
      // The handler only hands back the authorized snapshot; the SDK runs the tool.
      (authorized) => authorized,
    );
    if (!result.ok) return { behavior: "deny", message: result.reason };
    // A plain, mutable copy of exactly what was authorized.
    return {
      behavior: "allow",
      updatedInput: structuredClone(result.value ?? {}) as Record<string, unknown>,
    };
  };
}
