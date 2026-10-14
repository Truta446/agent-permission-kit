import { describe, expect, it } from "vitest";
import { createGuard, GuardConfigError } from "../src/index.js";

describe("default decision", () => {
  it("denies tools without a rule", async () => {
    const guard = createGuard({ rules: { "database.read": "allow" } });
    const result = await guard.check({ tool: "database.drop" });
    expect(result).toMatchObject({ decision: "deny", ruleId: null, code: "default" });
  });

  it("denies everything when there are no rules", async () => {
    const guard = createGuard({ rules: {} });
    expect((await guard.check({ tool: "anything" })).decision).toBe("deny");
  });

  it("can default to require_approval", async () => {
    const guard = createGuard({ rules: {}, defaultDecision: "require_approval" });
    expect(await guard.check({ tool: "x" })).toMatchObject({
      decision: "require_approval",
      code: "default",
    });
  });

  it('refuses "allow" as a default decision', () => {
    // @ts-expect-error — "allow" is not a valid default
    expect(() => createGuard({ rules: {}, defaultDecision: "allow" })).toThrow(GuardConfigError);
  });
});

describe("static rules", () => {
  const guard = createGuard({
    rules: {
      "database.read": "allow",
      "database.delete": "deny",
      "payments.refund": "require_approval",
    },
  });

  it.each([
    ["database.read", "allow"],
    ["database.delete", "deny"],
    ["payments.refund", "require_approval"],
  ] as const)("%s → %s", async (tool, decision) => {
    const result = await guard.check({ tool });
    expect(result).toMatchObject({ decision, ruleId: tool, code: "rule", tool });
    expect(result.reason).toEqual(expect.any(String));
  });

  it("check() for require_approval reports the requirement, not a grant", async () => {
    const result = await guard.check({ tool: "payments.refund", input: { amount: 200 } });
    expect(result).toEqual({
      decision: "require_approval",
      reason: "Human approval required",
      ruleId: "payments.refund",
      code: "rule",
      tool: "payments.refund",
      requestId: expect.any(String),
    });
  });

  it("is case-sensitive", async () => {
    expect((await guard.check({ tool: "Database.Read" })).decision).toBe("deny");
  });
});

describe("wildcards and precedence", () => {
  const guard = createGuard({
    rules: {
      "db.*": "allow",
      "db.admin.*": "require_approval",
      "db.admin.drop": "deny",
    },
  });

  it("exact match beats any wildcard", async () => {
    expect(await guard.check({ tool: "db.admin.drop" })).toMatchObject({
      decision: "deny",
      ruleId: "db.admin.drop",
    });
  });

  it("the longest matching prefix wins", async () => {
    expect(await guard.check({ tool: "db.admin.create" })).toMatchObject({
      decision: "require_approval",
      ruleId: "db.admin.*",
    });
    expect(await guard.check({ tool: "db.users.read" })).toMatchObject({
      decision: "allow",
      ruleId: "db.*",
    });
  });

  it("is independent of rule declaration order", async () => {
    const reversed = createGuard({
      rules: { "db.admin.drop": "deny", "db.admin.*": "require_approval", "db.*": "allow" },
    });
    for (const tool of ["db.admin.drop", "db.admin.create", "db.users.read", "db"]) {
      const [a, b] = await Promise.all([guard.check({ tool }), reversed.check({ tool })]);
      expect(a.decision).toBe(b.decision);
      expect(a.ruleId).toBe(b.ruleId);
    }
  });

  it("a wildcard does not match its bare prefix or look-alike prefixes", async () => {
    expect((await guard.check({ tool: "db" })).decision).toBe("deny");
    expect((await guard.check({ tool: "db." })).decision).toBe("deny");
    expect((await guard.check({ tool: "dbx.read" })).decision).toBe("deny");
  });

  it("rejects ambiguous wildcard forms at configuration time", () => {
    for (const key of ["*", ".*", "db.*.read.*", "*.read"]) {
      expect(() => createGuard({ rules: { [key]: "allow" } }), key).toThrow(GuardConfigError);
    }
  });
});

describe("conditional rules", () => {
  type Tools = { "payments.refund": { amount: number; currency: string } };
  const guard = createGuard<Tools>({
    rules: {
      "payments.refund": ({ input }) => {
        if (input.amount < 50) return "allow";
        if (input.amount <= 500) {
          return {
            decision: "require_approval",
            reason: "Refunds from $50 to $500 need a manager",
          };
        }
        return { decision: "deny", reason: "Refunds above $500 are not allowed" };
      },
    },
  });

  it.each([
    [10, "allow"],
    [49.99, "allow"],
    [50, "require_approval"],
    [500, "require_approval"],
    [500.01, "deny"],
  ] as const)("refund of %d → %s", async (amount, decision) => {
    const result = await guard.check({
      tool: "payments.refund",
      input: { amount, currency: "USD" },
    });
    expect(result.decision).toBe(decision);
    expect(result.ruleId).toBe("payments.refund");
  });

  it("uses the reason returned by the rule", async () => {
    const result = await guard.check({
      tool: "payments.refund",
      input: { amount: 900, currency: "USD" },
    });
    expect(result.reason).toBe("Refunds above $500 are not allowed");
  });

  it("supports async conditions and application context", async () => {
    const g = createGuard<{ "db.delete": { id: number } }, { role: string }>({
      rules: {
        "db.delete": async ({ context }) => {
          await new Promise((r) => setTimeout(r, 5));
          return context?.role === "admin" ? "allow" : "deny";
        },
      },
    });
    expect(
      (await g.check({ tool: "db.delete", input: { id: 1 }, context: { role: "admin" } })).decision,
    ).toBe("allow");
    expect(
      (await g.check({ tool: "db.delete", input: { id: 1 }, context: { role: "user" } })).decision,
    ).toBe("deny");
    expect((await g.check({ tool: "db.delete", input: { id: 1 } })).decision).toBe("deny");
  });
});

describe("configuration is validated and copied", () => {
  it("rejects invalid rule values", () => {
    expect(() => createGuard({ rules: { a: "yes" as never } })).toThrow(GuardConfigError);
    expect(() => createGuard({ rules: { a: null as never } })).toThrow(GuardConfigError);
    expect(() => createGuard({ rules: null as never })).toThrow(GuardConfigError);
  });

  it("rejects invalid tool names in rules", () => {
    for (const key of ["", "has space", "tab\t", "ünicode", "a".repeat(129)]) {
      expect(() => createGuard({ rules: { [key]: "allow" } }), JSON.stringify(key)).toThrow(
        GuardConfigError,
      );
    }
  });

  it("rejects invalid timeouts", () => {
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(() => createGuard({ rules: {}, policyTimeoutMs: t as number })).toThrow(
        GuardConfigError,
      );
      expect(() => createGuard({ rules: {}, approvalTimeoutMs: t as number })).toThrow(
        GuardConfigError,
      );
    }
  });

  it("mutating the rules object after creation has no effect", async () => {
    const rules: Record<string, "allow" | "deny"> = { "files.read": "deny" };
    const guard = createGuard({ rules });
    rules["files.read"] = "allow";
    rules["files.write"] = "allow";
    expect((await guard.check({ tool: "files.read" })).decision).toBe("deny");
    expect((await guard.check({ tool: "files.write" })).decision).toBe("deny");
  });

  it("the guard object is frozen", () => {
    const guard = createGuard({ rules: {} });
    expect(Object.isFrozen(guard)).toBe(true);
  });
});
