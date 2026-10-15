import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { DecisionMismatchError, expectDecisions } from "../src/testing.js";

const guard = createGuard<
  { "payments.refund": { amount: number }; "db.drop": undefined },
  { role: string }
>({
  rules: {
    "payments.refund": ({ input, context }) =>
      context?.role === "admin" || input.amount < 50 ? "allow" : "require_approval",
    "db.drop": "deny",
  },
});

describe("expectDecisions (#10)", () => {
  it("passes when every case matches", async () => {
    await expect(
      expectDecisions(guard, [
        ["payments.refund", { amount: 10 }, "allow"],
        ["payments.refund", { amount: 100 }, "require_approval"],
        ["payments.refund", { amount: 100 }, "allow", { role: "admin" }],
        ["db.drop", undefined, "deny"],
        ["unknown.tool", undefined, "deny"],
      ]),
    ).resolves.toBeUndefined();
  });

  it("reports every mismatch at once", async () => {
    const error = await expectDecisions(guard, [
      ["payments.refund", { amount: 10 }, "deny"],
      ["db.drop", undefined, "allow"],
      ["payments.refund", { amount: 1 }, "allow"],
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionMismatchError);
    const mismatch = error as DecisionMismatchError;
    expect(mismatch.mismatches).toHaveLength(2);
    expect(mismatch.message).toContain('payments.refund {"amount":10}: expected deny, got allow');
    expect(mismatch.message).toContain("db.drop undefined: expected allow, got deny");
  });
});
