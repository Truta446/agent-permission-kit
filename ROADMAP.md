# Roadmap

v0.1.0 deliberately ships a small core. Items below are candidates. Each must
keep the core small, dependency-free and fail-closed.

## Next

- **Durable approvals for stateless servers** (#6): an approval store so a
  pending approval survives across requests and processes.
- **Upstream tool-call hook** in the MCP TypeScript SDK (see
  `docs/proposals/mcp-tool-hooks.md`), so the MCP adapter no longer needs to
  wrap registration methods.
- Mastra `requireApproval` adapter.

## Later

- MCP elicitation-based approval helper. The approver is the MCP client's user,
  so the trade-offs need to be documented.
- Durable / asynchronous approval: persist a pending request, resume after a webhook.
  This needs a storage interface and is out of scope for 0.x core.
- Policy decision caching for expensive async conditions.

## Explicit non-goals

- A dashboard, hosted service, or policy language/DSL.
- Authentication or identity management.
- Sandboxing tool execution.
- A full MCP gateway or proxy.
