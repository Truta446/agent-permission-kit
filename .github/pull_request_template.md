## What & why

<!-- Link the issue. Public API changes need an issue first. -->

## Checklist

- [ ] Tests cover the behavior. For security-relevant branches, a test fails when the guard clause is removed.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass locally
- [ ] README / CHANGELOG updated if behavior or API changed
- [ ] No new runtime dependencies
