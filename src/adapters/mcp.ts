/**
 * MCP adapter. Works with the official TypeScript SDK's `McpServer` from both
 * `@modelcontextprotocol/sdk` (v1) and `@modelcontextprotocol/server` (v2)
 * without importing either: it relies only on the public `registerTool(name,
 * config, handler)` method and the handler shapes `(args, extra)` / `(extra)`.
 *
 * The SDK has no tool-call middleware, so authorization is applied by wrapping
 * each tool's handler. The guard runs after the SDK has validated arguments
 * against the tool's input schema and before your handler runs.
 */
import type { Guard, ToolMap } from "../core/types.js";

/** Minimal structural view of an MCP `CallToolResult`. */
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Fields of the SDK's handler context ("extra" in v1, "ctx" in v2) that the adapter reads. */
export interface McpHandlerExtra {
  /** v1 */
  signal?: AbortSignal;
  /** v1 */
  authInfo?: unknown;
  sessionId?: string;
  /** v2 */
  mcpReq?: { signal?: AbortSignal };
  /** v2 */
  http?: { authInfo?: unknown };
}

export interface McpGuardOptions<TContext = unknown> {
  /**
   * Builds the policy `context` from the SDK's handler context, e.g. to expose
   * `authInfo.scopes` to your rules. Defaults to `undefined`.
   */
  context?: (extra: McpHandlerExtra) => TContext;
  /**
   * Builds the tool result returned to the client when a call is refused.
   * Defaults to an `isError: true` text result containing the reason, so the
   * model can see why the call did not happen.
   */
  onDenied?: (denial: {
    tool: string;
    code: string;
    reason: string;
    requestId: string;
  }) => McpToolResult;
}

const GUARDED = Symbol.for("agent-permission-kit.mcp.guarded");

type AnyHandler = (...args: unknown[]) => unknown;

interface GuardedHandler extends AnyHandler {
  [GUARDED]?: Guard<ToolMap, unknown>;
}

function defaultDenied(denial: { tool: string; reason: string }): McpToolResult {
  return {
    content: [
      { type: "text", text: `Tool call "${denial.tool}" was not executed: ${denial.reason}` },
    ],
    isError: true,
  };
}

/** Reads the abort signal from a v1 `extra` or a v2 `ctx`. */
export function signalFrom(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const e = extra as McpHandlerExtra;
  const signal = e.signal ?? e.mcpReq?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Wraps one MCP tool handler so every call goes through `guard.execute()`.
 * `toolName` must be the name you register the tool under.
 *
 * @example
 * server.registerTool(
 *   "payments.refund",
 *   { inputSchema: { amount: z.number() } },
 *   guardToolHandler(guard, "payments.refund", async ({ amount }) => refund(amount)),
 * );
 */
export function guardToolHandler<H extends (...args: never[]) => unknown>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
  guard: Guard<any, any>,
  toolName: string,
  handler: H,
  options: McpGuardOptions = {},
): H {
  if (typeof handler !== "function") throw new TypeError("guardToolHandler() requires a handler");
  const raw = handler as unknown as GuardedHandler;
  if (raw[GUARDED] === guard) return handler; // already guarded by this guard: never prompt twice

  const onDenied = options.onDenied ?? defaultDenied;
  const toContext = options.context;

  const wrapped: GuardedHandler = async (...args: unknown[]) => {
    // The SDK calls `handler(args, extra)` for tools with an input schema and
    // `handler(extra)` for tools without one.
    const hasInput = args.length >= 2;
    const input = hasInput ? args[0] : undefined;
    const extra = hasInput ? args[1] : args[0];
    const signal = signalFrom(extra);
    const context = toContext ? toContext((extra ?? {}) as McpHandlerExtra) : undefined;

    const result = await guard.execute(
      {
        tool: toolName,
        input,
        ...(context !== undefined && { context }),
        ...(signal !== undefined && { signal }),
      },
      // Forward the frozen, authorized snapshot — not the original args object.
      (authorizedInput: unknown) => (hasInput ? raw(authorizedInput, extra) : raw(extra)),
    );
    if (result.ok) return result.value;
    return onDenied({
      tool: result.tool,
      code: result.code,
      reason: result.reason,
      requestId: result.requestId,
    });
  };
  wrapped[GUARDED] = guard;
  return wrapped as unknown as H;
}

/** Structural view of `McpServer` used by `guardMcpServer`. */
export interface GuardableMcpServer {
  // biome-ignore lint/suspicious/noExplicitAny: must accept every SDK overload.
  registerTool: (...args: any[]) => any;
  // biome-ignore lint/suspicious/noExplicitAny: v1 only, deprecated.
  tool?: (...args: any[]) => any;
}

const SERVER_GUARDED = Symbol.for("agent-permission-kit.mcp.server-guarded");

/**
 * Makes every tool registered on `server` *after this call* go through `guard`,
 * under the name it is registered with. Tools without a rule fall back to the
 * guard's default decision (deny unless configured otherwise).
 *
 * Also covers `registeredTool.update({ callback, name })` (the new handler is
 * wrapped; a rename re-binds the policy to the new name), and disables the
 * deprecated v1 `server.tool()` method, which would otherwise register an
 * unguarded handler.
 *
 * Call it right after constructing the server, before registering tools.
 */
export function guardMcpServer<S extends GuardableMcpServer>(
  server: S,
  // biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
  guard: Guard<any, any>,
  options: McpGuardOptions = {},
): S {
  const marked = server as S & { [SERVER_GUARDED]?: true; _registeredTools?: unknown };
  if (marked[SERVER_GUARDED])
    throw new Error("guardMcpServer() was already applied to this server");
  const existing = marked._registeredTools;
  if (typeof existing === "object" && existing !== null && Object.keys(existing).length > 0) {
    throw new Error(
      "guardMcpServer() must be called before any tool is registered; " +
        `already registered: ${Object.keys(existing).join(", ")}`,
    );
  }

  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name: unknown, config: unknown, cb: unknown, ...rest: unknown[]) => {
    if (typeof name !== "string" || typeof cb !== "function") {
      // Fail closed rather than register something we cannot wrap
      // (e.g. experimental task handlers, which are objects).
      throw new TypeError(
        "guardMcpServer(): registerTool(name, config, handler) requires a string name and a handler function",
      );
    }
    let currentName = name;
    let currentRaw = cb as AnyHandler;
    const registered = originalRegister(
      name,
      config,
      guardToolHandler(guard, name, currentRaw, options),
      ...rest,
    ) as { update?: (updates: Record<string, unknown>) => unknown; handler?: unknown } | undefined;

    // v1 reads `registeredTool.handler` on every call, so assigning to it
    // directly would install an unguarded handler. Wrap on assignment.
    if (registered && Object.hasOwn(registered, "handler")) {
      let current = registered.handler;
      Object.defineProperty(registered, "handler", {
        get: () => current,
        set: (next: unknown) => {
          if (typeof next !== "function") {
            throw new TypeError("guardMcpServer(): tool handler must be a function");
          }
          if ((next as GuardedHandler)[GUARDED] !== guard) currentRaw = next as AnyHandler;
          current = guardToolHandler(guard, currentName, next as AnyHandler, options);
        },
        enumerable: true,
        configurable: false,
      });
    }

    const originalUpdate = registered?.update;
    if (registered && typeof originalUpdate === "function") {
      registered.update = (updates: Record<string, unknown>) => {
        const next = { ...updates };
        const renamed = typeof next.name === "string" && next.name !== currentName;
        if (typeof next.callback === "function") currentRaw = next.callback as AnyHandler;
        if (renamed) currentName = next.name as string;
        if (typeof next.callback === "function" || renamed) {
          next.callback = guardToolHandler(guard, currentName, currentRaw, options);
        }
        return originalUpdate.call(registered, next);
      };
    }
    return registered;
  };

  if (typeof server.tool === "function") {
    server.tool = () => {
      throw new Error(
        "server.tool() is disabled by guardMcpServer() because it is deprecated; use server.registerTool()",
      );
    };
  }

  Object.defineProperty(marked, SERVER_GUARDED, { value: true });
  return server;
}
