# Pre-release security review (v0.1.0)

Before the first release, the library was reviewed adversarially: an attacker
controlling tool names and inputs (LLM output), MCP client requests, and
possibly a polluted `Object.prototype`. Each suspected issue got a runnable
proof of concept. Fixed issues now have regression tests that fail if the fix
is reverted, and every fix was checked by reverting it and watching a test fail.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | MCP SDK v1 `server.experimental.tasks.registerToolTask()` registered a tool without going through `registerTool`, so `guardMcpServer` never wrapped it | **Fixed.** Every registration reaching the SDK's internal `_createRegisteredTool` must carry a handler wrapped by this guard, so unknown paths fail closed. Since 0.2.0, task tools are guarded at `createTask` instead of disabled |
| 2 | Medium | A handler pre-wrapped with `guardToolHandler` kept its old policy name after `update({ name })` | **Fixed.** Wrappers remember the original handler; `guardMcpServer` always re-binds it to the registered name |
| 3 | Low | `guardMcpServer` trusted the name of a pre-wrapped handler (copy-paste mistake) | **Fixed** (same change as #2) |
| 4 | Low | SDK v2: assigning `registeredTool.executor` directly installs an unguarded handler | **Documented.** The SDK reassigns this field itself during `update()`, so it can't be blocked without breaking updates. App code must use `update({ callback })` |
| 5 | Low | `requireAudit: true` without `onAudit` recorded nothing yet executed | **Fixed.** Configuration error |
| 6 | Low | A hung `onAudit` hung `execute()` forever | **Fixed.** `auditTimeoutMs` (default 5 s); a timeout counts as "not recorded" |
| 7 | Low | With a polluted `Object.prototype`, a policy reading an *absent* input field sees the polluted value | **Documented**, with guidance to use `Object.hasOwn` for optional fields that grant access. Since 0.2.0, `nullPrototypeInput: true` removes the risk |
| 8 | Low | `requestId` is caller-asserted and can collide with generated ids in the audit trail | **Documented** |
| 9 | Low | Redaction missed `accessKey`, `otp`, `jwt`, `bearer`, `mnemonic`, `pinCode`, credentials inside URLs, and more | **Fixed.** Wider key list plus `scheme://user:pass@` redaction in string values; since 0.2.0 also secret-shaped values and `{ name, value }` pairs. Still best-effort |
| 10 | Info | `requestId` accepted newlines and escape codes (log-line forging) | **Fixed.** Printable ASCII only |
| 11 | Info | An own `__proto__` key in input could smuggle fields past a policy when a handler later used `Object.assign` | **Fixed.** Rejected as `invalid_request` |
| 12 | Info | A throwing getter on `request.tool` or a forged `AbortSignal` made `execute()` reject instead of resolving `ok: false` | **Fixed** |

Performance testing found a related denial-of-service risk: snapshot cost is
linear in input size and there was no cap. **Fixed** with `maxInputNodes`
(default 100 000 values); oversized inputs are rejected before allocation.

## What held up

- No way was found to run a denied or unapproved handler through `execute()`, to run it with arguments other than the authorized snapshot, or to run it twice.
- Getters and Proxies in inputs are read exactly once. Cycles, sparse arrays, symbol keys and non-plain objects are rejected.
- Only an own `approved: true` grants approval. Late answers after a timeout are ignored.
- Concurrent duplicate `requestId`s are refused before any `await`.
- Error messages and `context` never reach audit events. The redaction regex runs in linear time.

## Out of scope by design

Calling `server.server.setRequestHandler("tools/call", …)` or
`McpServer.prototype.registerTool.call(…)` bypasses the adapter. Both replace
or skip the guarded server on purpose. See the README's security model for the
full list of non-goals.
