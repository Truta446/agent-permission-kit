# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

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
