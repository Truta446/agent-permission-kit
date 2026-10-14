import { createGuard } from "agent-permission-kit";

// Declaring input types gives typed conditions and catches typos in rule names.
type Tools = {
  "payments.refund": { amount: number; currency: string };
  "database.read": { table: string };
  "database.delete": { table: string; id: number };
};

type Context = { role: "agent" | "admin" };

const guard = createGuard<Tools, Context>({
  rules: {
    "payments.refund": ({ input }) => {
      if (input.amount < 50) return "allow";
      if (input.amount <= 500) {
        return { decision: "require_approval", reason: "Refunds of $50–$500 need a manager" };
      }
      return { decision: "deny", reason: "Refunds above $500 are not allowed" };
    },
    "database.read": ({ input }) => (input.table === "credentials" ? "deny" : "allow"),
    // Policy functions may be async and may use application context.
    "database.delete": async ({ context }) =>
      context?.role === "admin" ? "require_approval" : "deny",
  },
});

for (const amount of [20, 200, 2000]) {
  const { decision, reason } = await guard.check({
    tool: "payments.refund",
    input: { amount, currency: "USD" },
  });
  console.log(`refund $${amount}: ${decision} — ${reason}`);
}

const asAgent = await guard.check({
  tool: "database.delete",
  input: { table: "users", id: 1 },
  context: { role: "agent" },
});
console.log(`delete as agent: ${asAgent.decision}`);
