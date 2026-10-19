<p align="center">
  <img src="assets/banner.svg" alt="agent-permission-kit: Give your AI agents permissions, not unlimited access" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-permission-kit"><img src="https://img.shields.io/npm/v/agent-permission-kit?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://github.com/Truta446/agent-permission-kit/actions/workflows/ci.yml"><img src="https://github.com/Truta446/agent-permission-kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <img src="https://img.shields.io/badge/types-TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/MCP-SDK%20v1%20%2B%20v2-8B7CFF" alt="MCP SDK v1 and v2">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://m8ven.ai/mcp/truta446-agent-permission-kit-boc9tf?s=readme"><img src="https://m8ven.ai/badge/mcp/truta446-agent-permission-kit-boc9tf?v=85ad6025e74cf8b5a48eb252b822f08f" alt="M8ven Score"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#conditional-rules">Conditional rules</a> ·
  <a href="#human-approval">Human approval</a> ·
  <a href="#mcp-integration">MCP</a> ·
  <a href="#security-model">Security model</a> ·
  <a href="#api">API</a>
</p>

---

Allow, deny, or require human approval for every tool call your agent makes, with a small typed API that runs in your process. Unknown tools are denied by default. There is no gateway, no cloud account and no policy language. It has zero runtime dependencies and includes an optional adapter for the official MCP TypeScript SDK.

```ts
import { createGuard } from "agent-permission-kit";

const guard = createGuard({
  rules: {
    "database.read": "allow",
    "database.delete": "deny",
    "payments.refund": "require_approval",
  },
});

const result = await guard.execute(
  { tool: "database.read", input: { id: 123 } },
  async (input) => db.findById(input.id), // runs only if authorized
);
```

## Why

Agents call tools that read databases, send email, move money and delete files, and the model chooses the arguments. Most stacks give an agent either every tool or none. In between you need three things:

- a **deterministic** decision for each call: allow, deny, or ask a human
- that fails **closed** when a policy throws, an approver is unreachable or a value is malformed
- that is **bound to the exact arguments** that run, so they can't change between check and execution

agent-permission-kit is that layer, and nothing more.

## How it works

<p align="center">
  <img src="assets/how-it-works.svg" alt="The input is validated and frozen, policy decides allow, require_approval or deny; only allowed or approved calls run the handler, once, with the authorized snapshot" width="100%">
</p>

## Features

- **Three decisions:** `allow`, `deny`, `require_approval`. Unknown tools are denied.
- **Conditional rules** as typed functions of the tool input and your app context, for example "allow refunds under $50".
- **Human approval** through a callback, with a timeout and abort signal. Only `{ approved: true }` counts.
- **`execute()` wrapper:** the handler runs at most once, only after authorization, with a frozen copy of the authorized input.
- **Audit events**, structured. Inputs are not logged by default; opt-in logging redacts sensitive keys.
- **Replay protection:** a tool-call id that has already been processed is refused.
- **Typed tool maps:** typos in tool names and input fields are compile errors.
- **MCP adapter:** guard every tool on an `McpServer` (SDK v1 or v2, including v1 task tools) with one call.
- **Framework adapters:** the same rules through the native hooks of the Vercel AI SDK, OpenAI Agents JS and Claude Agent SDK.
- **Policy tests:** pin a `[tool, input, decision]` table in CI with `expectDecisions()`.
- Zero dependencies, ESM + CJS, Node ≥ 22.

## Install

```sh
npm install agent-permission-kit
# or: pnpm add agent-permission-kit
```

## Quick start

```ts
import { createGuard } from "agent-permission-kit";

const guard = createGuard({
  rules: {
    "database.read": "allow",
    "database.delete": "deny",
    "payments.refund": "require_approval",
  },
});

// 1. Ask what policy says. This executes and approves nothing.
await guard.check({ tool: "payments.refund", input: { amount: 200 } });
// { decision: "require_approval", reason: "Human approval required",
//   ruleId: "payments.refund", code: "rule", tool: "payments.refund", requestId: "…" }

// 2. Authorize and run in one step.
const result = await guard.execute({ tool: "database.delete", input: { id: 1 } }, deleteRow);
if (!result.ok) {
  console.log(result.code, result.reason); // "policy_denied" "Denied by policy"
}
```

`require_approval` means a human **must** approve. It never means a human **has** approved. Approval happens only inside `execute()`, through your callback.

## Conditional rules

Declare your tools' input types to get typed conditions and compile-time checks on tool names:

```ts
type Tools = {
  "payments.refund": { amount: number; currency: string };
  "database.delete": { table: string; id: number };
};

const guard = createGuard<Tools, { role: "agent" | "admin" }>({
  rules: {
    "payments.refund": ({ input }) => {
      if (input.amount < 50) return "allow";
      if (input.amount <= 500) return { decision: "require_approval", reason: "Needs a manager" };
      return { decision: "deny", reason: "Refunds above $500 are not allowed" };
    },
    "database.delete": async ({ context }) =>
      context?.role === "admin" ? "require_approval" : "deny",
  },
});

await guard.check({ tool: "payments.refund", input: { amount: 20, currency: "USD" } }); // allow
// @ts-expect-error: typo in tool name
await guard.check({ tool: "payments.refnud", input: { amount: 20, currency: "USD" } });
```

Policy functions are **trusted application code**: they run in your process with full privileges. Never build one from text an agent or a user supplied.

### Wildcards and precedence

```ts
rules: {
  "db.*": "allow",               // any tool starting with "db."
  "db.admin.*": "require_approval",
  "db.admin.drop": "deny",
}
```

1. An exact name always wins.
2. Otherwise the longest matching `prefix.*` wins. The order you declare rules in doesn't matter.
3. Otherwise `defaultDecision` applies: `"deny"` (default) or `"require_approval"`. `"allow"` is not accepted as a default.

Names are case-sensitive, 1–128 characters long, and limited to `A–Z a–z 0–9 _ - . / :`. A bare `*` is rejected; use `defaultDecision` instead.

## Human approval

```ts
const guard = createGuard({
  rules: { "payments.refund": "require_approval" },
  approvalTimeoutMs: 120_000, // default: 5 minutes
  onApprovalRequired: async (request) => {
    // request: { tool, input, context, reason, ruleId, requestId, requestedAt, signal }
    const answer = await slackApproval(request, { signal: request.signal });
    return answer.ok
      ? { approved: true, approvedBy: answer.userId }
      : { approved: false, reason: answer.comment };
  },
});

const result = await guard.execute(
  { tool: "payments.refund", input: { amount: 200, orderId: "A-1" } },
  async (input, { approval }) => refunds.create(input), // approval?.approvedBy is available here
);
```

Approval lifecycle: **required → requested → granted**, or **not granted**. Not granted covers rejected, invalid, error, timeout and aborted. The handler runs only on **granted**. These all count as not granted:

| Situation | `result.code` |
|---|---|
| No `onApprovalRequired` configured | `approval_unavailable` |
| `{ approved: false }` | `approval_rejected` |
| Anything other than an object with an own `approved: true` (`"yes"`, `1`, `{status: "pending"}`, …) | `approval_invalid` |
| Callback throws or rejects | `approval_error` |
| No answer within `approvalTimeoutMs` (a late answer is ignored) | `approval_timeout` |
| Caller's `signal` aborted | `aborted` |

Approvals are single-use: every `execute()` call asks again. **Your application authenticates the approver.** This library records the `approvedBy` you report but can't verify it.

## The `execute()` wrapper

`guard.execute(request, handler)`:

1. Validates the request and copies `input` into a deeply **frozen snapshot**. Only JSON-shaped data is accepted, and each property is read exactly once.
2. Refuses a `requestId` this guard has already seen. Pass your LLM's tool-call id here to block replays.
3. Evaluates policy against the snapshot.
4. Obtains approval if required.
5. Calls `handler(snapshot, ctx)` **at most once**, after re-checking the abort signal.

Refusals resolve to `{ ok: false, code, reason, … }`. A refusal never throws, so you can feed `reason` back to the model. If the handler itself throws, the error is re-thrown unchanged.

> **Use the `input` argument, not variables from the surrounding scope.** The guard authorizes the snapshot it passes to you. If your handler ignores it and acts on something else, the guard can't protect you.

**Security boundary:** the wrapper protects calls that go through it. It does not stop code that calls your tools directly. Keep tool implementations reachable only through `execute()`, or through `guardMcpServer` on an MCP server.

## Audit events

```ts
createGuard({
  rules,
  onAudit: (event) => logger.info(event),
  auditInput: false,   // default; true = include input with sensitive keys redacted; or (input, tool) => custom
  requireAudit: false, // true = if `tool.allowed` / `approval.granted` cannot be recorded, do not execute
  auditTimeoutMs: 5_000, // a hung logger can't hang the tool call; a timeout counts as "not recorded"
});
```

| `type` | When |
|---|---|
| `policy.evaluated` | only from `check(request, { audit: true })`, for check-only integrations |
| `tool.allowed` | policy allowed the call |
| `tool.denied` | policy denied it, or the request was invalid, duplicate or aborted |
| `approval.requested` | the approval callback is about to be called |
| `approval.granted` / `approval.rejected` | approval outcome (`code` says why it was not granted) |
| `execution.succeeded` / `execution.failed` | handler finished or threw (`errorName` only, never the message) |

Every event carries `timestamp`, `requestId`, `tool`, `decision`, `reason` and `ruleId`. Events are frozen and the handler's return value is ignored, so audit code cannot change a decision. Audit failures and timeouts go to `onAuditError` (default `console.error`) and are never swallowed silently. `check()` emits no events unless you pass `{ audit: true }`.

## MCP integration

The official MCP TypeScript SDK has no tool-call middleware, so the adapter wraps tool handlers. It works with `McpServer` from both `@modelcontextprotocol/sdk` (v1) and `@modelcontextprotocol/server` (v2), and doesn't import either.

```ts
import { createGuard } from "agent-permission-kit";
import { guardMcpServer } from "agent-permission-kit/mcp";
import { McpServer } from "@modelcontextprotocol/server"; // or "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod";

const guard = createGuard({
  rules: { "notes.read": "allow", "notes.delete": "deny" },
});

const server = new McpServer({ name: "notes", version: "1.0.0" });
guardMcpServer(server, guard); // call before registering tools

server.registerTool("notes.read", { inputSchema: z.object({ id: z.string() }) }, async ({ id }) => ({
  content: [{ type: "text", text: await notes.get(id) }],
}));
// Every tool registered from now on is guarded under its own name.
// Tools without a rule are denied.
```

Once `guardMcpServer()` has run:

- Each `registerTool` handler runs through `guard.execute()`, after the SDK validates the arguments.
- A refused call returns `{ isError: true, content: [{ type: "text", text: "Tool call … was not executed: <reason>" }] }`, so the model sees why. You can customize this with `onDenied`.
- `registeredTool.update({ callback })` is wrapped too, and `update({ name })` re-binds the policy to the new name. On v1, direct assignment to `registeredTool.handler` is also wrapped.
- The deprecated v1 `server.tool()` is disabled, and non-function (task) handlers are refused.
- `context: (extra) => …` maps the SDK's request context (`authInfo`, `sessionId`) into your policy context.

To wrap tools one at a time instead, use `guardToolHandler(guard, "notes.read", handler)`. A runnable server and client are in [`examples/mcp-server`](examples/mcp-server).

## Framework adapters

One rule set, enforced through each framework's own approval hook. None of
them imports the framework at runtime.

**Vercel AI SDK** (`toolApproval`):

```ts
import { toolApproval } from "agent-permission-kit/ai-sdk";

await generateText({ model, tools, prompt, toolApproval: toolApproval(guard) });
// allow → approved, deny → denied, require_approval → user-approval
```

**OpenAI Agents JS** (`needsApproval` + `execute`):

```ts
import { guardTool } from "agent-permission-kit/openai-agents";

const refund = tool({
  name: "payments_refund",
  description: "Refund a payment",
  parameters: z.object({ amount: z.number() }),
  ...guardTool(guard, "payments_refund", async ({ amount }) => refunds.create(amount)),
});
// require_approval → SDK interruption; deny → execute refuses with the reason
```

**Claude Agent SDK** (`PreToolUse` hook + `canUseTool`):

```ts
import { canUseTool, preToolUseHook } from "agent-permission-kit/claude-agent-sdk";

query({
  prompt,
  options: {
    hooks: { PreToolUse: [{ hooks: [preToolUseHook(guard)] }] }, // default deny, before permission modes
    canUseTool: canUseTool(guard), // approval + replay protection; returns the authorized input
  },
});
```

`toolApproval`, `needsApproval` and the `PreToolUse` hook only *decide*; the
framework executes the tool, so the frozen-snapshot binding of `execute()`
does not apply there. `canUseTool` does bind: it returns the authorized
snapshot as `updatedInput`. Decisions are audited as `policy.evaluated`.

## Security model

**Guaranteed, and covered by tests in [`tests/`](tests):**

1. Unknown tools are denied, and `"allow"` can't be set as the default.
2. A missing, throwing, timed-out, aborted or invalid approval never grants access.
3. A throwing, rejecting, timed-out or malformed policy result denies.
4. The handler gets the frozen snapshot that was evaluated and approved. Changes to the caller's object after the check have no effect, and each property is read exactly once (getters and Proxies can't show the policy one value and the handler another).
5. Tool names can't hit inherited properties (`constructor`, `__proto__`). Every security-relevant field the guard reads is an own property, so a polluted `Object.prototype` can't supply `approved: true`, a decision, an approval callback or a request field. Inputs containing a `__proto__` key are rejected.
6. Audit handlers can't change decisions, and a hung handler times out. With `requireAudit`, an unrecorded allow blocks execution.
7. Raw inputs, contexts and error messages are not logged by default.
8. Concurrent calls share no authorization state except the per-guard set of seen request ids.
9. The rule table is copied at creation; mutating it later has no effect.
10. Inputs are bounded (`maxInputNodes`, default 100 000 values; depth 64), so one call can't block the event loop for long.
11. Hostile request objects (throwing getters, forged `AbortSignal`s, control characters in `requestId`) resolve to `invalid_request` instead of throwing.
12. With `guardMcpServer`, every registration path is guarded or refused: `registerTool`, v1 task tools (`experimental.tasks.registerToolTask`, authorized at `createTask`), `update()`, v1 `handler` assignment; the deprecated `server.tool()` and unknown internal paths are refused. A pre-wrapped handler is always re-bound to the name it is registered under.
13. Replay protection can be shared across processes (`replayStore`); a failing store denies.

**Not guaranteed (non-goals):**

- **Not a sandbox.** Allowed handlers run with your process's full privileges.
- **No protection for direct calls** that bypass `execute()` or the MCP adapter.
- **No identity:** you authenticate users and approvers and pass them in `context`.
- **No prompt-injection detection.** Policies see arguments; they don't judge intent.
- **Replay protection is in-memory and per guard.** It covers the last 10 000 caller-supplied ids and resets on restart. `requestId` is asserted by the caller: don't treat it as proof of identity in your audit trail.
- **Policies must handle missing fields themselves.** If `Object.prototype` is polluted, reading an *absent* input field (`input.dryRun`) can return the polluted value. Use `Object.hasOwn(input, "dryRun")`, explicit comparisons, or `nullPrototypeInput: true` for optional fields that grant access.
- **MCP SDK v2 `registeredTool.executor`:** assigning to it directly (instead of `update({ callback })`) is not intercepted, because the SDK reassigns that field itself.
- **Key-based redaction is best-effort.** Secrets in free-text fields are not detected.
- **A running handler is never cancelled.** It only receives the caller's `signal`.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities, and [docs/architecture.md](docs/architecture.md) for the design rationale.

## API

| Export | Description |
|---|---|
| `createGuard<Tools?, Context?>(options)` | Creates a frozen guard. Throws `GuardConfigError` on invalid config. |
| `guard.check(request, { audit? })` | Returns `Promise<PolicyResult>`. Evaluates policy only. |
| `guard.execute(request, handler)` | Returns `Promise<ExecuteResult<T>>`. Authorizes, then calls `handler(input, ctx)` at most once. |
| `redactInput(value)` / `REDACTED` | The built-in key redactor, for composing your own `auditInput` function. |
| `guardMcpServer(server, guard, opts?)` | From `agent-permission-kit/mcp`. Guards every tool registered afterwards. |
| `guardToolHandler(guard, name, handler, opts?)` | From `agent-permission-kit/mcp`. Guards one MCP handler. |
| `expectDecisions(guard, cases)` | From `agent-permission-kit/testing`. Pins a `[tool, input, decision, context?]` table in CI. |
| `guardTaskHandler(guard, name, handler)` | From `agent-permission-kit/mcp`. Guards one v1 task tool handler. |
| `toolApproval(guard, opts?)` | From `agent-permission-kit/ai-sdk`. |
| `guardTool(guard, name, execute, opts?)` / `needsApproval(...)` | From `agent-permission-kit/openai-agents`. |
| `preToolUseHook(guard, opts?)` / `canUseTool(guard, opts?)` | From `agent-permission-kit/claude-agent-sdk`. |

**Request:** `{ tool, input?, context?, requestId?, signal? }`

**Options:**

| Option | Default |
|---|---|
| `rules` | required |
| `defaultDecision` | `"deny"` |
| `onApprovalRequired` | none (approval-required calls are refused) |
| `approvalTimeoutMs` | 300 000 |
| `policyTimeoutMs` | 5 000 |
| `auditTimeoutMs` | 5 000 |
| `maxInputNodes` | 100 000 |
| `nullPrototypeInput` | `false` |
| `replayStore` | in memory, per guard |
| `onAudit` | none |
| `onAuditError` | `console.error` |
| `requireAudit` | `false` |
| `auditInput` | `false` |
| `generateRequestId` | `crypto.randomUUID` |

**`ExecuteResult<T>`:**

- `{ ok: true, value, decision, ruleId, tool, requestId, approval? }`
- `{ ok: false, code, reason, decision, ruleId, tool, requestId }`, where `code` is one of: `policy_denied`, `invalid_request`, `policy_error`, `duplicate_request`, `approval_unavailable`, `approval_rejected`, `approval_invalid`, `approval_error`, `approval_timeout`, `aborted`, `audit_failed`

## Performance

Measured with [`bench/index.ts`](bench/index.ts) (`pnpm bench`) on Node 24, Intel Core Ultra 9 275HX. These are orders of magnitude; run it on your own hardware.

| Operation | Mean |
|---|---|
| `check()`, static or wildcard rule | ~1–2 µs |
| `execute()`, small input | ~5 µs |
| `execute()`, ~10 KB input | ~35 µs |
| `execute()`, ~250 KB input | ~2.5 ms (linear in input size, about the same as `structuredClone`) |
| MCP `tools/call` round trip, added by `guardMcpServer` | ~+15–20 µs |

For typical tool calls the guard costs microseconds, next to milliseconds for the tool itself. Snapshot cost grows with input size, which is why inputs are capped by `maxInputNodes`.

## More

- [Recipes](docs/recipes.md): role-based rules, read-only mode, spend caps, preview-then-confirm for stateless servers, Slack approval, pinning policy in CI
- [Security review](docs/security-review.md): findings from the pre-release adversarial review and how each was handled
- [Architecture](docs/architecture.md)

## Development

```sh
pnpm install
pnpm test          # vitest, including real MCP SDK v1 + v2 integration tests
pnpm typecheck     # tsc (also enforces the type-level tests)
pnpm lint          # biome
pnpm build         # tsdown → dist/ (ESM + CJS + .d.ts)
pnpm examples      # runs every example against the built package
pnpm bench         # overhead benchmark
```

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Roadmap

Durable approvals for stateless servers (#6) and a supported tool-call hook upstream in the MCP SDK ([proposal](docs/proposals/mcp-tool-hooks.md)). See [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
