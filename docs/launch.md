# Launch kit

Internal notes for releasing and announcing v0.1.0. Nothing here has been published.

## GitHub repository settings

**Description:** Give your AI agents permissions, not unlimited access. Allow, deny, or require human approval for every tool call: typed, in-process, fail-closed. MCP adapter included.

**Topics:** `ai-agents`, `llm`, `tool-calling`, `authorization`, `permissions`, `policy`, `human-in-the-loop`, `mcp`, `model-context-protocol`, `typescript`, `security`, `audit-log`

Also: enable private vulnerability reporting (Settings → Security) and set the social preview image.

## Good first issues

1. **Example: Vercel AI SDK tool wrapped with `guard.execute()`.** Add `examples/ai-sdk/` showing a tool whose `execute` calls the guard.
2. **Example: OpenAI Agents JS tool wrapped with `guard.execute()`.**
3. **Docs: "Recipes" page** covering per-tenant rules via `context`, read-only mode for an agent, and spend caps with an external counter.
4. **`check()` audit opt-in** (see ROADMAP). Design an option and add tests.
5. **Rule-table test helper**: `expectDecisions(guard, [[tool, input, decision], …])`.
6. **Benchmark script** measuring `check()` overhead, published as a reproducible script rather than a marketing number.

## Release checklist (v0.1.0)

- [ ] `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:package && pnpm examples`
- [ ] `pnpm pack` and inspect the tarball: only `dist/`, README, LICENSE, CHANGELOG, SECURITY, package.json
- [ ] Install the tarball in a scratch project. Import from ESM and CJS, and typecheck a consumer file.
- [ ] CHANGELOG: set the release date for 0.1.0
- [ ] Create the GitHub repo, push `main`, wait for CI to pass
- [ ] Enable private vulnerability reporting
- [ ] `git tag v0.1.0 && git push --tags`
- [ ] `npm publish --access public` (2FA OTP), then verify with `npm view agent-permission-kit`
- [ ] Open the good-first-issues above
- [ ] Post announcements (below) after verifying that install instructions work from npm

## Hacker News (Show HN)

**Title:** Show HN: agent-permission-kit – allow/deny/require-approval for AI agent tool calls (TypeScript)

> I've been wiring LLM agents to tools that can delete rows and issue refunds, and kept rewriting the same guard code: a rule table, "ask a human above $X", deny anything unknown, log it all.
>
> agent-permission-kit is that code as a small TypeScript library. It runs in-process with zero dependencies. You give it a rule table (`allow` / `deny` / `require_approval`, or typed functions of the tool input), and `guard.execute(request, handler)` runs the handler only after authorization.
>
> The parts I cared most about:
>
> - **It fails closed.** Unknown tools, throwing policies, timeouts, a missing approval callback, or an approval response that isn't exactly `{ approved: true }` all deny. Each case has a test.
> - **The handler gets a frozen copy of the exact input that was checked and approved.** Mutating the arguments while a human is looking at the approval prompt changes nothing.
> - **Replayed tool-call ids are refused**, and a polluted `Object.prototype` can't grant approval.
> - **There's an MCP adapter** that guards every tool on an `McpServer` (official SDK v1 and v2) with one call.
>
> It's deliberately not a gateway, a sandbox or a policy language. Similar ideas exist. Frameworks now ship their own approval hooks (Vercel AI SDK `toolApproval`, OpenAI Agents `needsApproval`, Claude Agent SDK `canUseTool`), and there are MCP proxies. My goal is one typed rule set you can reuse across them; adapters for those hooks are next on the roadmap.
>
> Feedback on the security model is very welcome, especially "here's how I'd bypass it".

## Dev.to article (outline + intro)

**Title:** Your AI agent shouldn't have root: permissions for tool calls in TypeScript

**Intro:**
> Giving an LLM a `deleteUser` tool is a little like giving an intern production credentials. Usually fine, and occasionally a postmortem. Most agent stacks give an agent all of its tools or none of them. This post shows a middle ground: a small rule table that allows, denies, or asks a human for each tool call, and fails closed when anything goes wrong.

**Sections:**
1. The three decisions, and why "approve" is a dangerous name for a policy result
2. Quick start: a rule table in 10 lines
3. Conditional rules: refunds under $50 allowed, up to $500 need a manager, above that denied
4. Human approval: lifecycle, timeouts, and why `"yes"` is not an approval
5. Check-then-act bugs: binding authorization to a frozen input snapshot
6. Guarding an MCP server with one line
7. What this does **not** protect you from (sandboxing, direct calls, prompt injection)
8. Roadmap and how to contribute

## LinkedIn post

> I just open-sourced **agent-permission-kit**, a small TypeScript library that gives AI agents permissions instead of unlimited access.
>
> Every tool call gets one of three decisions: allow, deny, or require human approval. Unknown tools are denied by default. Errors, timeouts and malformed responses also deny. The handler only ever sees the exact arguments that were approved.
>
> It runs in your process with zero dependencies, and it includes an adapter for MCP servers.
>
> It's v0.1.0, MIT-licensed, and I'd value feedback, especially from anyone running agents against production systems. Link in comments.
>
> #AIagents #TypeScript #MCP #Security #OpenSource
