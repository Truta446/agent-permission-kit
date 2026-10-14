import { createGuard } from "agent-permission-kit";

const guard = createGuard({
  rules: {
    "database.read": "allow",
    "database.delete": "deny",
    "payments.refund": "require_approval",
  },
});

// Policy only: what would happen? (Nothing is executed or approved.)
console.log(
  await guard.check({ tool: "payments.refund", input: { amount: 200, currency: "USD" } }),
);
// → { decision: "require_approval", reason: "Human approval required", ruleId: "payments.refund", ... }

console.log(await guard.check({ tool: "email.send" }));
// → { decision: "deny", reason: "No rule matches this tool; denied by default", ruleId: null, ... }

// Authorize and run in one step. The handler only runs if the call is allowed.
// The handler receives `input`: a frozen copy of exactly what was authorized.
const read = await guard.execute({ tool: "database.read", input: { id: 123 } }, async (input) => {
  return { found: input }; // e.g. database.findById(input.id)
});
console.log(read); // → { ok: true, value: { ... }, decision: "allow", ... }

const del = await guard.execute({ tool: "database.delete", input: { id: 123 } }, async () => {
  throw new Error("never runs");
});
console.log(del); // → { ok: false, code: "policy_denied", reason: "Denied by policy", ... }
