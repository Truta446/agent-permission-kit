/** Executes the recipes in docs/recipes.md so the docs cannot silently rot. */
import { describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { expectDecisions } from "../src/testing.js";

describe("recipes", () => {
  it("1. rules by role", async () => {
    type Context = { role: "read_only" | "operational" | "admin"; tenantId: string };
    const guard = createGuard<Record<string, unknown>, Context>({
      rules: {
        "reports.*": "allow",
        "clients.update": ({ context }) => (context?.role === "read_only" ? "deny" : "allow"),
        "credits.grant": ({ context }) => (context?.role === "admin" ? "allow" : "deny"),
      },
    });
    await expectDecisions(guard, [
      ["reports.monthly", undefined, "allow", { role: "read_only", tenantId: "t" }],
      ["clients.update", undefined, "deny", { role: "read_only", tenantId: "t" }],
      ["clients.update", undefined, "allow", { role: "operational", tenantId: "t" }],
      ["credits.grant", undefined, "deny", { role: "operational", tenantId: "t" }],
      ["credits.grant", undefined, "allow", { role: "admin", tenantId: "t" }],
    ]);
  });

  it("2. read-only mode", async () => {
    const tools = ["db.read", "db.write", "files.read", "files.delete"];
    const readOnly = createGuard({
      rules: Object.fromEntries(tools.filter((t) => t.endsWith(".read")).map((t) => [t, "allow"])),
    });
    await expectDecisions(readOnly, [
      ["db.read", undefined, "allow"],
      ["files.read", undefined, "allow"],
      ["db.write", undefined, "deny"],
      ["files.delete", undefined, "deny"],
    ]);
  });

  it("3. spend caps; a failing counter denies", async () => {
    const spent = new Map([["u1", 9_000]]);
    const spend = {
      todayFor: async (id: string) => {
        if (id === "broken") throw new Error("redis down");
        return spent.get(id) ?? 0;
      },
    };
    const guard = createGuard<{ "ads.buy": { amountCents: number } }, { userId: string }>({
      rules: {
        "ads.buy": async ({ input, context }) => {
          const total = await spend.todayFor(context?.userId ?? "");
          return total + input.amountCents <= 10_000
            ? "allow"
            : { decision: "deny", reason: "Daily budget of $100 exceeded" };
        },
      },
    });
    await expectDecisions(guard, [
      ["ads.buy", { amountCents: 1_000 }, "allow", { userId: "u1" }],
      ["ads.buy", { amountCents: 1_001 }, "deny", { userId: "u1" }],
      ["ads.buy", { amountCents: 1 }, "deny", { userId: "broken" }],
    ]);
  });

  it("4. preview then confirm: the handler sees the same confirm flag the rule saw", async () => {
    type Tools = { "billing.change_plan": { plan: string; confirm?: boolean } };
    const guard = createGuard<Tools, { role: "member" | "owner" }>({
      rules: {
        "billing.change_plan": ({ input, context }) => {
          if (input.confirm !== true) return "allow";
          return context?.role === "owner"
            ? "allow"
            : { decision: "deny", reason: "Only owners can change the plan" };
        },
      },
    });
    const billing = {
      changePlan: vi.fn(async () => "changed"),
      previewChange: vi.fn(async () => "preview"),
    };
    const run = (input: Tools["billing.change_plan"], role: "member" | "owner") =>
      guard.execute({ tool: "billing.change_plan", input, context: { role } }, async (i) =>
        i.confirm === true ? billing.changePlan() : billing.previewChange(),
      );

    expect(await run({ plan: "pro" }, "member")).toMatchObject({ ok: true, value: "preview" });
    expect(await run({ plan: "pro", confirm: true }, "member")).toMatchObject({
      ok: false,
      reason: "Only owners can change the plan",
    });
    expect(billing.changePlan).not.toHaveBeenCalled();

    // An input whose `confirm` getter answers differently on each read cannot
    // pass as a preview to the rule and as confirmed to the handler.
    let reads = 0;
    const sneaky = {
      plan: "pro",
      get confirm() {
        return reads++ > 0;
      },
    };
    expect(await run(sneaky as never, "member")).toMatchObject({ ok: true, value: "preview" });
    expect(billing.changePlan).not.toHaveBeenCalled();

    expect(await run({ plan: "pro", confirm: true }, "owner")).toMatchObject({
      ok: true,
      value: "changed",
    });
  });
});
