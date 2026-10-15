# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-15

### Added

- `createGuard()` with `allow` / `deny` / `require_approval` rules, `prefix.*`
  wildcards, deterministic precedence, and default deny.
- Typed conditional rules (sync or async) with an optional tool-input map and application context.
- `guard.check()` (policy only) and `guard.execute()`. `execute()` authorizes a
  frozen input snapshot and runs the handler at most once.
- Human approval callback with timeout, abort signal and strict response validation.
- Replay protection for caller-supplied request ids.
- Structured audit events, optional input logging with key redaction, and `requireAudit`.
- MCP adapter (`agent-permission-kit/mcp`): `guardMcpServer()` and
  `guardToolHandler()` for the official TypeScript SDK v1 and v2.
- `check(request, { audit: true })` emits `policy.evaluated` for check-only integrations.
- `agent-permission-kit/testing`: `expectDecisions()` pins a decision table in CI.
- `maxInputNodes` (default 100 000) and `auditTimeoutMs` (default 5 s) options.
- Docs: recipes (including preview-then-confirm for stateless servers), performance numbers, pre-release security review.

### Security

Hardening from the pre-release adversarial review (see `docs/security-review.md`):

- MCP: v1 `experimental.tasks.registerToolTask` is disabled and any registration path that skips the guard is refused. Pre-wrapped handlers are re-bound to their registered name.
- Inputs with a `__proto__` key or more than `maxInputNodes` values are rejected.
- `requestId` must be printable ASCII.
- `requireAudit` requires `onAudit`, and a hung audit handler times out.
- Wider redaction of credential-like keys and URL credentials.
- Hostile request objects resolve to `invalid_request` instead of throwing.
