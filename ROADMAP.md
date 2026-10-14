# Roadmap

v0.1.0 deliberately ships a small core. Items below are candidates. Each must
keep the core small, dependency-free and fail-closed.

## Next (0.2)

- **Framework-native adapters**, so one rule set is enforced through each framework's own approval hook:
  - Vercel AI SDK `toolApproval`
  - OpenAI Agents JS `needsApproval`
  - Claude Agent SDK `canUseTool` / `PreToolUse`
  - Mastra `requireApproval`

  These hooks ask "allow, deny, or ask?" without wrapping execution, so the
  adapters will build on `check()`, and the docs must state that they are
  check-only rather than snapshot-binding.
- **Audit for `check()`**: opt-in events for integrations that can't use `execute()`.
- **Rule testing helper**: snapshot a table of `(tool, input) → decision` for CI.

## Later

- MCP elicitation-based approval helper. The approver is the MCP client's user,
  so the trade-offs need to be documented.
- Pluggable replay store (Redis and similar) for multi-process deployments.
- Durable / asynchronous approval: persist a pending request, resume after a webhook.
  This needs a storage interface and is out of scope for 0.x core.
- Policy decision caching for expensive async conditions.

## Explicit non-goals

- A dashboard, hosted service, or policy language/DSL.
- Authentication or identity management.
- Sandboxing tool execution.
- A full MCP gateway or proxy.
