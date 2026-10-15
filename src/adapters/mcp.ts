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
const RAW = Symbol.for("agent-permission-kit.mcp.raw");
const BOUND_NAME = Symbol.for("agent-permission-kit.mcp.bound-name");

type AnyHandler = (...args: unknown[]) => unknown;

interface GuardedHandler extends AnyHandler {
  [GUARDED]?: Guard<ToolMap, unknown>;
  [RAW]?: AnyHandler;
  [BOUND_NAME]?: string;
}

/** Strips this guard's wrappers, returning the handler the application wrote. */
function unwrap(handler: AnyHandler, guard: unknown): AnyHandler {
  let current = handler as GuardedHandler;
  while (current[GUARDED] === guard && typeof current[RAW] === "function") {
    current = current[RAW] as GuardedHandler;
  }
  return current;
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
  const existing = handler as unknown as GuardedHandler;
  // Already guarded by this guard under this name: wrapping again would prompt twice.
  if (existing[GUARDED] === guard && existing[BOUND_NAME] === toolName) return handler;
  // Guarded by this guard under another name: re-bind to `toolName` instead of
  // trusting the old binding (renames, copy-paste mistakes).
  const raw = unwrap(existing, guard);

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
  wrapped[RAW] = raw;
  wrapped[BOUND_NAME] = toolName;
  return wrapped as unknown as H;
}

/** v1 task-based tool handler (`server.experimental.tasks.registerToolTask`). */
export interface McpTaskHandlerLike {
  createTask: (...args: never[]) => unknown;
  getTask: (...args: never[]) => unknown;
  getTaskResult: (...args: never[]) => unknown;
}

interface GuardedTaskHandler extends McpTaskHandlerLike {
  [GUARDED]?: Guard<ToolMap, unknown>;
  [RAW]?: McpTaskHandlerLike;
  [BOUND_NAME]?: string;
}

function isTaskHandler(value: unknown): value is GuardedTaskHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as McpTaskHandlerLike).createTask === "function" &&
    typeof (value as McpTaskHandlerLike).getTask === "function" &&
    typeof (value as McpTaskHandlerLike).getTaskResult === "function"
  );
}

function unwrapTask(handler: GuardedTaskHandler, guard: unknown): McpTaskHandlerLike {
  let current = handler;
  while (current[GUARDED] === guard && isTaskHandler(current[RAW])) current = current[RAW];
  return current;
}

/**
 * Wraps a v1 task-based tool handler. Authorization happens in `createTask`,
 * where the work starts; `getTask` / `getTaskResult` only read a task that was
 * created, so authorized, earlier. A refused `createTask` throws, which the
 * SDK turns into an `isError` tool result carrying the reason (`onDenied`
 * does not apply: a task call can't return a plain result).
 */
export function guardTaskHandler<T extends McpTaskHandlerLike>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
  guard: Guard<any, any>,
  toolName: string,
  handler: T,
  options: Pick<McpGuardOptions, "context"> = {},
): T {
  if (!isTaskHandler(handler)) {
    throw new TypeError(
      "guardTaskHandler() requires { createTask, getTask, getTaskResult } functions",
    );
  }
  const existing = handler as GuardedTaskHandler;
  if (existing[GUARDED] === guard && existing[BOUND_NAME] === toolName) return handler;
  const raw = unwrapTask(existing, guard);
  const toContext = options.context;

  const wrapped: GuardedTaskHandler = {
    // Same arity convention as tool handlers: (args, extra) or (extra).
    createTask: (async (...args: unknown[]) => {
      const hasInput = args.length >= 2;
      const input = hasInput ? args[0] : undefined;
      const extra = hasInput ? args[1] : args[0];
      const signal = signalFrom(extra);
      const context = toContext ? toContext((extra ?? {}) as McpHandlerExtra) : undefined;
      const call = raw.createTask as (...a: unknown[]) => unknown;
      const result = await guard.execute(
        {
          tool: toolName,
          input,
          ...(context !== undefined && { context }),
          ...(signal !== undefined && { signal }),
        },
        (authorized: unknown) =>
          hasInput ? call.call(raw, authorized, extra) : call.call(raw, extra),
      );
      if (result.ok) return result.value;
      throw new Error(`Tool call "${toolName}" was not executed: ${result.reason}`);
    }) as McpTaskHandlerLike["createTask"],
    getTask: ((...args: unknown[]) =>
      (raw.getTask as (...a: unknown[]) => unknown).apply(
        raw,
        args,
      )) as McpTaskHandlerLike["getTask"],
    getTaskResult: ((...args: unknown[]) =>
      (raw.getTaskResult as (...a: unknown[]) => unknown).apply(
        raw,
        args,
      )) as McpTaskHandlerLike["getTaskResult"],
  };
  wrapped[GUARDED] = guard;
  wrapped[RAW] = raw;
  wrapped[BOUND_NAME] = toolName;
  return wrapped as T;
}

/** Structural view of `McpServer` used by `guardMcpServer`. */
export interface GuardableMcpServer {
  // biome-ignore lint/suspicious/noExplicitAny: must accept every SDK overload.
  registerTool: (...args: any[]) => any;
  // biome-ignore lint/suspicious/noExplicitAny: v1 only, deprecated.
  tool?: (...args: any[]) => any;
}

const SERVER_GUARDED = Symbol.for("agent-permission-kit.mcp.server-guarded");

type RawHandler = AnyHandler | McpTaskHandlerLike;

/**
 * Makes every tool registered on `server` *after this call* go through `guard`,
 * under the name it is registered with. Tools without a rule fall back to the
 * guard's default decision (deny unless configured otherwise).
 *
 * Covers `registerTool`, v1 task tools (`experimental.tasks.registerToolTask`),
 * `registeredTool.update({ callback, name })` (the new handler is wrapped; a
 * rename re-binds the policy to the new name) and v1's `registeredTool.handler`
 * assignment. Disables the deprecated v1 `server.tool()`, and refuses any other
 * path that would register an unguarded handler.
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

  /** The application's own handler, with this guard's wrappers stripped. */
  const rawOf = (handler: unknown): RawHandler => {
    if (typeof handler === "function") return unwrap(handler as AnyHandler, guard);
    if (isTaskHandler(handler)) return unwrapTask(handler, guard);
    throw new TypeError("guardMcpServer(): a tool handler must be a function or a task handler");
  };
  const wrap = (name: string, raw: RawHandler): RawHandler =>
    typeof raw === "function"
      ? guardToolHandler(guard, name, raw, options)
      : guardTaskHandler(guard, name, raw, options);

  /** Keeps the guard bound through update() and (v1) handler assignment. */
  const protect = (registered: unknown, name: string, raw: RawHandler) => {
    const tool = registered as
      | { update?: (updates: Record<string, unknown>) => unknown; handler?: unknown }
      | undefined;
    if (!tool) return;
    let currentName = name;
    let currentRaw = raw;

    // v1 reads `registeredTool.handler` on every call, so assigning to it
    // directly would install an unguarded handler. Wrap on assignment.
    if (Object.hasOwn(tool, "handler")) {
      let current = tool.handler;
      Object.defineProperty(tool, "handler", {
        get: () => current,
        set: (next: unknown) => {
          currentRaw = rawOf(next);
          current = wrap(currentName, currentRaw);
        },
        enumerable: true,
        configurable: false,
      });
    }

    const originalUpdate = tool.update;
    if (typeof originalUpdate === "function") {
      tool.update = (updates: Record<string, unknown>) => {
        const next = { ...updates };
        const renamed = typeof next.name === "string" && next.name !== currentName;
        if (next.callback !== undefined) currentRaw = rawOf(next.callback);
        if (renamed) currentName = next.name as string;
        if (next.callback !== undefined || renamed) next.callback = wrap(currentName, currentRaw);
        return originalUpdate.call(tool, next);
      };
    }
  };

  const originalRegister = server.registerTool.bind(server);
  server.registerTool = (name: unknown, config: unknown, cb: unknown, ...rest: unknown[]) => {
    if (typeof name !== "string" || typeof cb !== "function") {
      // Fail closed rather than register something we cannot wrap.
      throw new TypeError(
        "guardMcpServer(): registerTool(name, config, handler) requires a string name and a handler function",
      );
    }
    const raw = rawOf(cb);
    const registered = originalRegister(name, config, wrap(name, raw), ...rest);
    protect(registered, name, raw);
    return registered;
  };

  const tasks = (server as unknown as { experimental?: { tasks?: { registerToolTask?: unknown } } })
    .experimental?.tasks;
  if (tasks && typeof tasks.registerToolTask === "function") {
    const originalRegisterTask = (tasks.registerToolTask as (...args: unknown[]) => unknown).bind(
      tasks,
    );
    tasks.registerToolTask = (name: unknown, config: unknown, handler: unknown) => {
      if (typeof name !== "string" || !isTaskHandler(handler)) {
        throw new TypeError(
          "guardMcpServer(): registerToolTask(name, config, handler) requires a string name and { createTask, getTask, getTaskResult }",
        );
      }
      const raw = rawOf(handler);
      const registered = originalRegisterTask(name, config, wrap(name, raw));
      protect(registered, name, raw);
      return registered;
    };
  }

  // Every registration path in SDK v1 and v2 ends in `_createRegisteredTool`
  // with the handler as its last argument. Refuse anything that reaches it
  // without having been wrapped above, so a path we don't know about fails
  // closed instead of registering an unguarded tool.
  const internal = server as unknown as { _createRegisteredTool?: (...args: unknown[]) => unknown };
  if (typeof internal._createRegisteredTool === "function") {
    const originalCreate = internal._createRegisteredTool.bind(server);
    internal._createRegisteredTool = (...args: unknown[]) => {
      const handler = args[args.length - 1] as { [GUARDED]?: unknown } | undefined;
      const guarded =
        (typeof handler === "function" || isTaskHandler(handler)) && handler?.[GUARDED] === guard;
      if (!guarded) {
        throw new TypeError(
          "guardMcpServer(): blocked a tool registration that bypasses the guard; use server.registerTool()",
        );
      }
      return originalCreate(...args);
    };
  }

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
