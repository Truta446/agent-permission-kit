# Recipes

Short patterns for common setups. The code for recipes 1–4 and 7 is executed in
[`tests/recipes.test.ts`](../tests/recipes.test.ts).

## 1. Rules by role or tenant

Pass who is acting as `context`. It is never logged, and your application is
responsible for authenticating it.

```ts
type Context = { role: "read_only" | "operational" | "admin"; tenantId: string };

const guard = createGuard<Record<string, unknown>, Context>({
  rules: {
    "reports.*": "allow",
    "clients.update": ({ context }) => (context?.role === "read_only" ? "deny" : "allow"),
    "credits.grant": ({ context }) => (context?.role === "admin" ? "allow" : "deny"),
  },
});

await guard.execute({ tool: "credits.grant", input, context: { role, tenantId } }, grantCredits);
```

## 2. Read-only mode for an agent

Wildcards match prefixes only (`db.*`). To allow "every read tool", build the
table from your tool list. Everything else stays denied by default.

```ts
const tools = ["db.read", "db.write", "files.read", "files.delete"];

const readOnly = createGuard({
  rules: Object.fromEntries(tools.filter((t) => t.endsWith(".read")).map((t) => [t, "allow"])),
});
```

## 3. Spend caps with an external counter

Policy functions may be async. Keep the counter outside the guard (Redis, a
database). A counter error is a thrown policy error, which **denies**.

```ts
const guard = createGuard<{ "ads.buy": { amountCents: number } }, { userId: string }>({
  rules: {
    "ads.buy": async ({ input, context }) => {
      const spent = await spend.todayFor(context?.userId ?? "");
      return spent + input.amountCents <= 10_000
        ? "allow"
        : { decision: "deny", reason: "Daily budget of $100 exceeded" };
    },
  },
});
```

The check and the later increment are not atomic. If you need a hard limit
under concurrency, reserve the amount atomically inside the rule (for example
Redis `INCRBY` plus a rollback on denial) or enforce it again inside the handler.

## 4. Preview, then confirm (stateless servers)

`onApprovalRequired` waits in memory, which doesn't fit stateless servers
(each request is a fresh process or `McpServer`) or approvals that take hours.
A common alternative: without `confirm` the tool only **previews**; the
model shows the preview to the user and calls again with `confirm: true` after
the user agrees. The guard makes sure only allowed roles can reach the
confirmed path:

```ts
type Tools = { "billing.change_plan": { plan: string; confirm?: boolean } };

const guard = createGuard<Tools, { role: "member" | "owner" }>({
  rules: {
    "billing.change_plan": ({ input, context }) => {
      if (input.confirm !== true) return "allow"; // preview: no side effects
      return context?.role === "owner"
        ? "allow"
        : { decision: "deny", reason: "Only owners can change the plan" };
    },
  },
});

await guard.execute({ tool: "billing.change_plan", input, context }, async (input) =>
  input.confirm === true ? billing.changePlan(input.plan) : billing.previewChange(input.plan),
);
```

Because the handler receives the **same frozen snapshot** the rule evaluated,
it can't run the confirmed branch for a request the rule treated as a preview.

> The "human" here is whoever confirms in the chat, and the model relays that
> answer. If the model can't be trusted to relay it, or you need a named
> approver, use `require_approval` with an out-of-band channel instead. Durable
> approvals for stateless servers are tracked in issue #6.

## 5. Approval through Slack (or any channel)

```ts
const guard = createGuard({
  rules: { "payments.refund": "require_approval" },
  approvalTimeoutMs: 10 * 60_000,
  onApprovalRequired: async (request) => {
    const answer = await slack.askForApproval({
      text: `Refund ${request.input.amount} (${request.requestId})?`,
      signal: request.signal, // fires on timeout: stop waiting, update the message
    });
    // Authenticate the person who clicked. This library only records what you return.
    if (!answer.clicked || !(await isAuthorizedApprover(answer.userId))) {
      return { approved: false, reason: "Not approved by an authorized approver" };
    }
    return { approved: true, approvedBy: answer.userId };
  },
});
```

## 6. Feed refusals back to the model

Refusals resolve instead of throwing, so the model can read why and adapt:

```ts
async function runTool(call: { id: string; name: string; args: unknown }) {
  const result = await guard.execute(
    { tool: call.name, input: call.args, requestId: call.id }, // call.id blocks replays
    (input) => toolImplementations[call.name](input),
  );
  return result.ok ? result.value : { error: `Not executed: ${result.reason}` };
}
```

## 7. Pin your policy in CI

```ts
import { expectDecisions } from "agent-permission-kit/testing";

test("policy table", async () => {
  await expectDecisions(guard, [
    ["billing.change_plan", { plan: "pro" }, "allow"],
    ["billing.change_plan", { plan: "pro", confirm: true }, "deny", { role: "member" }],
    ["billing.change_plan", { plan: "pro", confirm: true }, "allow", { role: "owner" }],
    ["shell.exec", undefined, "deny"],
  ]);
});
```
