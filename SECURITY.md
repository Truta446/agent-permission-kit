# Security Policy

agent-permission-kit is an authorization layer, so we treat any way to get a
handler executed without the configured authorization as a vulnerability.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through
[GitHub private vulnerability reporting](https://github.com/Truta446/agent-permission-kit/security/advisories/new).
If you can't use it, email juan.versolato@outlook.com with the subject
`[agent-permission-kit security]`.

Please include:

- affected version
- a minimal reproduction: the guard configuration and the request
- the impact you observed, for example "the handler ran although approval was rejected"

We aim to acknowledge reports within 3 business days and to publish a fix or
mitigation within 30 days, coordinating disclosure with you. We are glad to
credit you in the advisory unless you prefer otherwise.

## In scope

- Any path where `execute()`, `guardToolHandler()` or `guardMcpServer()` runs a
  handler for a request that policy denied, that was not approved, or with
  arguments other than the ones authorized.
- Approval being granted by anything other than an own `approved: true`.
- Audit events leaking raw input, context or error messages when `auditInput` is off.
- Prototype-pollution or tool-name tricks that change a decision.

## Out of scope (documented non-goals)

- Code that calls tool implementations directly without going through the guard.
- Behavior of trusted policy functions, approval callbacks or handlers you write.
- Misidentification of approvers. Authenticating humans is the application's job.
- The library is not a sandbox and does not limit what an allowed handler can do.

See the "Security model" section of the README for the full list of guarantees and limitations.
