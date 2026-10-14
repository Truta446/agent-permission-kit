# Contributing

Thanks for helping! The goal is a **small, trustworthy** library, so we value
correctness and clarity over feature count.

## Setup

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Requires Node ≥ 22 and pnpm 10.

## Ground rules

- **Fail closed.** Any new branch that can't decide must deny. Every security
  property needs a test that fails if the property is broken. Before opening a
  PR, try reverting your guard clause and confirm a test goes red.
- **No runtime dependencies.** Dev dependencies are fine.
- **Public API changes** need an issue first. The API is meant to stay understandable in 30 seconds.
- **Framework adapters** live in `src/adapters/` and must not import the
  framework at runtime unless that is unavoidable. Prefer structural types,
  and add integration tests against the real package as a dev dependency.
- Keep the README, `CHANGELOG.md` and JSDoc in sync with behavior.
- Run `pnpm lint:fix` before committing. Biome handles both formatting and linting.

## Tests

- `tests/*.test.ts` hold behavior tests. Prefer asserting on observable behavior:
  results, handler calls and audit events.
- `tests/types.test.ts` holds type-level tests, enforced by `pnpm typecheck`.
- `tests/mcp.test.ts` holds real MCP SDK v1 and v2 integration tests over in-memory transports.

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
