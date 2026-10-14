/**
 * Type-level tests. Enforced by `pnpm typecheck` (tsc), which covers tests/.
 * The runtime assertions only keep vitest happy.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { createGuard, type Decision, type ExecuteResult, type PolicyResult } from "../src/index.js";

type Tools = {
  "payments.refund": { amount: number; currency: "USD" | "EUR" };
  "database.read": { id: number };
};

describe("types", () => {
  it("infers input types in conditions and handlers", async () => {
    const guard = createGuard<Tools, { userId: string }>({
      rules: {
        "payments.refund": ({ input, context }) => {
          expectTypeOf(input.amount).toEqualTypeOf<number>();
          expectTypeOf(input.currency).toEqualTypeOf<"USD" | "EUR">();
          expectTypeOf(context).toEqualTypeOf<{ userId: string } | undefined>();
          // @ts-expect-error — input is read-only
          input.amount = 1;
          return input.amount < 50 ? "allow" : "require_approval";
        },
        "database.*": "allow",
      },
      onApprovalRequired: (req) => {
        if (req.tool === "payments.refund") expectTypeOf(req.input.amount).toEqualTypeOf<number>();
        return { approved: false };
      },
    });

    const result = await guard.execute(
      { tool: "database.read", input: { id: 1 } },
      async (input) => {
        expectTypeOf(input.id).toEqualTypeOf<number>();
        return { name: "x" };
      },
    );
    expectTypeOf(result).toEqualTypeOf<ExecuteResult<{ name: string }>>();
    if (result.ok) expectTypeOf(result.value.name).toEqualTypeOf<string>();

    expectTypeOf(
      await guard.check({ tool: "payments.refund", input: { amount: 1, currency: "USD" } }),
    ).toEqualTypeOf<PolicyResult>();
    expect(true).toBe(true);
  });

  it("rejects typos in rule names, decisions, and inputs", () => {
    // Never called: these configs are only here to be rejected by the compiler.
    const _compileOnly = () => [
      createGuard<Tools>({
        rules: {
          // @ts-expect-error — not a tool in the map
          "payments.refnud": "allow",
        },
      }),
      createGuard<Tools>({
        rules: {
          // @ts-expect-error — "approve" is not a decision
          "database.read": "approve",
        },
      }),
    ];
    void _compileOnly;
    const guard = createGuard<Tools>({ rules: {} });
    // @ts-expect-error — unknown tool
    void guard.check({ tool: "database.drop" });
    // @ts-expect-error — wrong input shape
    void guard.check({ tool: "database.read", input: { id: "1" } });
    expect(true).toBe(true);
  });

  it("untyped guards accept any tool name and infer the handler input from the request", () => {
    const guard = createGuard({ rules: { anything: "allow" } });
    void guard.check({ tool: "whatever", input: { x: 1 } });
    void guard.execute({ tool: "whatever", input: { id: 123 } }, (input) => {
      expectTypeOf(input.id).toEqualTypeOf<number>();
      // @ts-expect-error — the snapshot is read-only
      input.id = 2;
    });
    expectTypeOf<Decision>().toEqualTypeOf<"allow" | "deny" | "require_approval">();
    expect(true).toBe(true);
  });
});
