# Architecture

## Scope

An in-process authorization layer for agent tool calls. One function,
`createGuard()`, returns two methods:

- `check(request)`: policy verdict only. It has no side effects: no approval, no audit, no execution.
- `execute(request, handler)`: the only path that can run a handler.

## Module layout

```
src/
  core/types.ts      public types
  core/guard.ts      createGuard: option parsing, request preparation, execute pipeline
  core/policies.ts   rule compilation (validated, copied into a Map) and evaluation
  core/decisions.ts  decision validation, default reasons
  core/snapshot.ts   JSON-only deep copy + freeze of tool input
  core/names.ts      tool-name and request-id validation
  core/timeout.ts    deadline/abort helper (first-settle-wins)
  core/errors.ts     GuardConfigError, own-property reads
  approval/          approval callback invocation and response parsing
  audit/             audit sink and redaction
  adapters/mcp.ts    MCP McpServer adapter (structural types; no SDK import)
```

## The `execute()` pipeline

```
request ─► validate + snapshot ─► replay check ─► evaluate policy ─┬─ deny ──────────────► { ok:false }
                                                                   ├─ allow ─► audit ───┐
                                                                   └─ require_approval  │
                                                                        └─► approval ───┤ (any failure ► { ok:false })
                                                                                        ▼
                                                                abort re-check ─► handler(snapshot) ─► audit ─► { ok:true }
```

Every arrow that can fail leads to `{ ok: false }`. The handler is called from
one place, once.

## Key decisions

| Decision | Why |
|---|---|
| `require_approval` instead of `approve` | Says that approval is needed, not that it happened. |
| `defaultDecision` can't be `allow` | Default deny should be impossible to turn off by accident. |
| Input snapshot (JSON-only, frozen, single read) | Binds authorization to the exact arguments. Defeats check-then-mutate, getter tricks and approval-time tampering. JSON-only matches what LLM tool calls actually carry. |
| Refusals resolve, handler errors throw | Agent loops want to send the reason back to the model. Re-throwing handler errors avoids masking real failures. |
| No "pending" approval state | A pending approval held in memory is a footgun. Durable approval is on the roadmap behind a storage interface. |
| Own-property reads everywhere | Prototype pollution in a dependency must not be able to grant access. |
| Audit is awaited, frozen, return value ignored | Keeps ordering deterministic, so audit can't change outcomes. `requireAudit` makes the pre-execution records mandatory. |
| Error messages never logged | They often echo input, for example `invalid password "…"`. |
| MCP adapter wraps `registerTool` | Neither SDK v1 nor v2 offers tool middleware. Wrapping the public method works for both without importing them. |
| Biome instead of ESLint + Prettier | typescript-eslint doesn't support TypeScript 7 yet. One tool covers formatting and linting. |

## Residual risks

Covered in the README's "Security model". In short: not a sandbox, no
protection for direct calls, approver identity is the application's job,
replay memory is per-process, and redaction is key-based.
