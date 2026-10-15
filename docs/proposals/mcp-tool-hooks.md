# Tool-call hooks in the MCP TypeScript SDK: requirements from a guard implementation

Upstream discussion: [typescript-sdk#1928](https://github.com/modelcontextprotocol/typescript-sdk/issues/1928)
(tool lifecycle hooks) and [#1238](https://github.com/modelcontextprotocol/typescript-sdk/issues/1238)
(middleware for `McpServer`), both labeled *needs decision*. Posted as
[a comment on #1238](https://github.com/modelcontextprotocol/typescript-sdk/issues/1238#issuecomment-6199952489),
answering the maintainer's question about where handler composition falls
short. It is based on building `guardMcpServer`, which has to wrap
`registerTool` because no hook exists.

## What we had to wrap, and why that is fragile

To authorize every tool call we wrap, in SDK v1 and v2:

1. `registerTool` (the normal path)
2. `registeredTool.update({ callback, name })`, because a new callback or a rename must stay guarded
3. v1 `registeredTool.handler` assignment, since v1 reads it on every call
4. v1 `experimental.tasks.registerToolTask` (task tools register an object handler)
5. the internal `_createRegisteredTool`, as a fail-closed backstop for paths we don't know

Two of these were real bypasses found in review: a task tool registered
without the guard, and a renamed tool keeping the old name's policy. A v2
`registeredTool.executor` assignment still can't be intercepted, because the
SDK reassigns that field itself. One supported hook would remove all of this.

## Requirements for a hook that authorization can rely on

1. **Runs after input validation, before any handler**, including task
   `createTask`. Policies should see validated arguments.
2. **Can short-circuit** with a `CallToolResult` (`isError: true`) without
   calling the handler. Throwing is not enough if the server wants a specific
   refusal text for the model.
3. **Can't be bypassed by registration path:** `registerTool`, `update()`,
   task tools, and tools added after the hook is installed.
4. **Receives the tool name the client called** (after renames), the
   arguments, and the request context (`authInfo`, `sessionId`, `signal`,
   request id).
5. **Can replace the arguments passed to the handler.** Authorization binds to
   a frozen snapshot of the arguments; the handler must get that snapshot, not
   the original object.
6. **`afterToolCall` sees success and failure**, for audit, without being able
   to change an already-sent decision.
7. **Ordered and composable:** several hooks (auth, audit, rate limit) run in
   registration order, and each can stop the chain.

A minimal shape that satisfies all of this:

```ts
new McpServer(info, {
  toolCallHooks: [
    async ({ name, arguments: args, ctx }, next) => {
      const verdict = await guard.check({ tool: name, input: args });
      if (verdict.decision !== "allow") {
        return { isError: true, content: [{ type: "text", text: verdict.reason }] };
      }
      return next(Object.freeze(structuredClone(args)));
    },
  ],
});
```
