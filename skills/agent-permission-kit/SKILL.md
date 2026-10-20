---
name: agent-permission-kit
description: Adds allow / deny / require-approval authorization to an AI agent's tool calls or an MCP server's tools, using the agent-permission-kit npm library (TypeScript, zero dependencies, fail-closed). Use when tools can write, delete, send messages or move money, when the user asks to restrict, gate, audit or require human approval for tool calls, or when new tools should be denied until someone decides who may use them.
---

# Agent Permission Kit

Puts one policy table in front of every tool call: each call is **allowed**,
**denied**, or **sent to a human for approval**, and unknown tools are denied by
default. The guard runs in-process (no gateway, no SaaS) and fails closed: a
policy that throws, times out or returns garbage denies.

Library: `agent-permission-kit` on npm (MIT). Node 22+, ESM and CommonJS.
API details: [references/api.md](references/api.md).

## Workflow

Follow these steps in order. Do not skip step 1: the policy is only as good as
the inventory.

### 1. Inventory the tools

Find every place a tool is defined (`registerTool(`, `tool(`, `tools: {`,
function-calling schemas). For each tool, record:

| Tool | Effect | Who may call it today | Existing check in code |
|---|---|---|---|

Classify the effect as `read`, `write`, `destructive`, `money` or `external-send`
(email, SMS, webhooks). Note any authorization already done **inside** handlers
(role checks, `if (!user.isAdmin)`, capability lists). These are the rules you
are about to centralize. Show this table to the user before writing rules.

### 2. Install

```sh
npm install agent-permission-kit
```

### 3. Write the policy table in one file

Create one module, for example `tool-policy.ts`, that exports the guard. Rules
are keyed by tool name. A rule is `"allow"`, `"deny"`, `"require_approval"` or a
function of `{ input, context }`:

```ts
import { createGuard } from "agent-permission-kit";

type Ctx = { role: "viewer" | "editor" | "admin" };

export const guard = createGuard<Record<string, unknown>, Ctx>({
  rules: {
    "reports.read": "allow",
    "records.update": ({ context }) => (context?.role === "viewer" ? "deny" : "allow"),
    "payments.refund": ({ input, context }) => {
      if (context?.role !== "admin") return { decision: "deny", reason: "Only admins refund" };
      return (input as { amount: number }).amount < 50 ? "allow" : "require_approval";
    },
  },
  // defaultDecision is "deny"; "allow" is not accepted as a default.
});
```

Rules:
- **Mirror existing behavior first.** If handlers already check roles, encode the
  same decisions (and ideally the same refusal text). Change policy in a separate,
  reviewed step.
- **Pass identity as `context`.** It must come from authenticated server state
  (session, token claims), never from tool arguments the model controls.
- **Wildcards are dot-prefix only** (`"db.*"`). For underscore names
  (`admin_*`), build the table with code (`Object.fromEntries(...)`).
- **Read optional input fields with `Object.hasOwn`** when they grant access, or
  set `nullPrototypeInput: true`.

### 4. Wire it where tools execute

Pick the integration that matches the project:

- **MCP server (official TypeScript SDK v1 or v2):** call `guardMcpServer(server, guard, { context })`
  right after `new McpServer(...)` and **before** any `registerTool`. Every tool
  registered afterwards is guarded, including `update()` and renames.
- **Plain code / custom agent loop:** `await guard.execute({ tool, input, context, requestId }, (input) => run(input))`.
  The handler must use the `input` argument (a frozen copy of what was authorized),
  not variables captured from outside.
- **Vercel AI SDK:** `toolApproval: toolApproval(guard)` from `agent-permission-kit/ai-sdk`.
- **OpenAI Agents JS:** spread `guardTool(guard, name, execute)` into `tool({...})`, from `agent-permission-kit/openai-agents`.
- **Claude Agent SDK:** `hooks.PreToolUse` with `preToolUseHook(guard)` plus `canUseTool: canUseTool(guard)`, from `agent-permission-kit/claude-agent-sdk`.

Snippets for each are in [references/api.md](references/api.md).

### 5. Decide how approvals happen

- **A human can answer within minutes** (Slack, an admin UI): implement
  `onApprovalRequired` and authenticate the approver yourself. Only
  `{ approved: true }` approves; errors, timeouts and anything else deny.
- **Stateless servers** (a new process or server per request): use preview, then
  confirm. Without `confirm` the tool only previews; with `confirm: true` the rule
  checks the role. The handler sees the same frozen input as the rule.

### 6. Audit

Pass `onAudit` and send events to the project's logger. Log authorized calls at
the level production actually keeps (often `info`, not `debug`), and refusals at
`warn`. Keep `auditInput` off, or pass a function that keeps only safe fields
(for example `confirm`). Never log raw arguments by default.

### 7. Test

Add two tests:

1. **Coverage:** list the registered tools and assert every one has a rule, and
   every rule names a real tool. A new tool without a rule must fail CI.
2. **Decision table:** pin decisions per role with
   `expectDecisions(guard, [[tool, input, decision, context], ...])` from
   `agent-permission-kit/testing`.

If you removed checks from handlers, also prove equivalence: run old and new code
across every tool × role and compare the outcomes.

## Pitfalls

- `guardMcpServer` must run before tools are registered; it throws otherwise.
- `check()` decides but executes nothing. Prefer `execute()` (or the MCP wrapper)
  so authorization is bound to the exact arguments that run.
- `requireAudit: true` needs `onAudit`, and blocks execution when an allowed call
  can't be recorded.
- Tool names are 1–128 characters of `A–Z a–z 0–9 _ - . / :`. Other names are denied as invalid.
- The guard is not a sandbox. It doesn't stop code that calls tools directly
  outside the wrapper.

## Done when

- Every tool has exactly one rule, and unknown tools are denied.
- The coverage and decision-table tests pass and run in CI.
- Refusals reach the model as readable errors.
- Allowed and denied calls appear in the production logs.
