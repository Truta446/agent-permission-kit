# agent-permission-kit: API reference for the skill

## createGuard(options)

| Option | Default | Notes |
|---|---|---|
| `rules` | required | `{ [toolName]: "allow" \| "deny" \| "require_approval" \| ({ input, context, tool, requestId }) => decision \| { decision, reason } }` |
| `defaultDecision` | `"deny"` | `"deny"` or `"require_approval"` only |
| `onApprovalRequired` | none | `(request) => ({ approved: true, approvedBy? } \| { approved: false, reason? })`; without it, approval-required calls are refused |
| `approvalTimeoutMs` | 300 000 | |
| `policyTimeoutMs` | 5 000 | async rules that take longer deny |
| `onAudit` | none | receives frozen events |
| `onAuditError` | `console.error` | |
| `auditTimeoutMs` | 5 000 | |
| `requireAudit` | `false` | needs `onAudit` |
| `auditInput` | `false` | `true` = redacted input; a function = custom |
| `maxInputNodes` | 100 000 | larger inputs are denied |
| `nullPrototypeInput` | `false` | |
| `replayStore` | in memory | `{ claim(id): boolean \| Promise<boolean> }` shared across processes |

Typed tools: `createGuard<{ "payments.refund": { amount: number } }, Ctx>({ ... })`
types the `input` in rules and handlers and rejects unknown tool names at compile time.

## guard.execute(request, handler)

```ts
const result = await guard.execute(
  { tool: "payments.refund", input: { amount: 20 }, context: { role }, requestId: toolCallId },
  async (input) => refunds.create(input.amount),
);
if (!result.ok) return { error: `Not executed: ${result.reason}` }; // result.code says why
return result.value;
```

`requestId` (for example the LLM's tool-call id) refuses replays of the same call.

## guard.check(request, { audit? })

Policy only. Returns `{ decision, reason, ruleId, code, tool, requestId }`.

## Audit event types

`tool.allowed`, `tool.denied`, `approval.requested`, `approval.granted`,
`approval.rejected`, `execution.succeeded`, `execution.failed`, and
`policy.evaluated` (only from `check(..., { audit: true })`).

## MCP (`agent-permission-kit/mcp`)

```ts
import { guardMcpServer } from "agent-permission-kit/mcp";
import { McpServer } from "@modelcontextprotocol/server"; // or "@modelcontextprotocol/sdk/server/mcp.js"

const server = new McpServer({ name: "my-server", version: "1.0.0" });
guardMcpServer(server, guard, {
  context: (extra) => ({ role: roleFrom(extra) }), // extra.authInfo / ctx.http?.authInfo
  onDenied: (d) => ({ isError: true, content: [{ type: "text", text: `Denied: ${d.reason}` }] }),
});
server.registerTool("payments.refund", { inputSchema }, handler); // now guarded
```

`guardToolHandler(guard, name, handler)` guards a single handler.

## Vercel AI SDK (`agent-permission-kit/ai-sdk`)

```ts
import { toolApproval } from "agent-permission-kit/ai-sdk";
await generateText({ model, tools, prompt, toolApproval: toolApproval(guard) });
```

`allow` → approved, `deny` → denied, `require_approval` → user-approval.

## OpenAI Agents JS (`agent-permission-kit/openai-agents`)

```ts
import { guardTool } from "agent-permission-kit/openai-agents";
const refund = tool({
  name: "payments_refund",
  description: "Refund a payment",
  parameters: z.object({ amount: z.number() }),
  ...guardTool(guard, "payments_refund", async ({ amount }) => refunds.create(amount)),
});
```

## Claude Agent SDK (`agent-permission-kit/claude-agent-sdk`)

```ts
import { canUseTool, preToolUseHook } from "agent-permission-kit/claude-agent-sdk";
query({
  prompt,
  options: {
    hooks: { PreToolUse: [{ hooks: [preToolUseHook(guard)] }] },
    canUseTool: canUseTool(guard),
  },
});
```

Tool names are the SDK's: `Bash`, `Read`, `mcp__server__tool`.

## Testing (`agent-permission-kit/testing`)

```ts
import { expectDecisions } from "agent-permission-kit/testing";
await expectDecisions(guard, [
  ["payments.refund", { amount: 10 }, "allow", { role: "admin" }],
  ["payments.refund", { amount: 10 }, "deny", { role: "viewer" }],
  ["shell.exec", undefined, "deny"],
]);
```

It throws one error listing every mismatch.
