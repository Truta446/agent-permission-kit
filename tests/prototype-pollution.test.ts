import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";

describe("tool names cannot reach inherited properties", () => {
  const guard = createGuard({ rules: { "db.read": "allow" }, defaultDecision: "require_approval" });

  it.each([
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__proto__",
    "__defineGetter__",
  ])("%s falls through to the default decision", async (tool) => {
    const result = await guard.check({ tool });
    expect(result.ruleId).toBeNull();
    expect(result.decision).toBe("require_approval");
  });

  it("a rule literally named __proto__ (from JSON) is an ordinary rule", async () => {
    const rules = JSON.parse('{"__proto__": "allow", "x": "deny"}');
    const g = createGuard({ rules });
    expect((await g.check({ tool: "__proto__" })).decision).toBe("allow");
    expect((await g.check({ tool: "constructor" })).decision).toBe("deny");
  });
});

describe("a polluted Object.prototype cannot grant access", () => {
  const keys = [
    "approved",
    "decision",
    "onApprovalRequired",
    "defaultDecision",
    "rules",
    "tool",
    "input",
  ];

  afterEach(() => {
    for (const key of keys) delete (Object.prototype as Record<string, unknown>)[key];
  });

  function pollute(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
    }
  }

  it("inherited onApprovalRequired / defaultDecision are ignored", async () => {
    const guard = (() => {
      pollute({
        onApprovalRequired: async () => ({ approved: true }),
        defaultDecision: "require_approval",
      });
      return createGuard({ rules: { "payments.refund": "require_approval" } });
    })();
    const fn = vi.fn();
    expect(await guard.execute({ tool: "payments.refund" }, fn)).toMatchObject({
      ok: false,
      code: "approval_unavailable",
    });
    expect((await guard.check({ tool: "unknown" })).decision).toBe("deny");
    expect(fn).not.toHaveBeenCalled();
  });

  it("inherited `approved: true` does not approve an empty response", async () => {
    const guard = createGuard({
      rules: { t: "require_approval" },
      onApprovalRequired: async () => ({}) as never,
    });
    pollute({ approved: true });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "t" }, fn)).toMatchObject({
      ok: false,
      code: "approval_invalid",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("inherited `decision: allow` does not allow an empty policy result", async () => {
    const guard = createGuard({ rules: { t: () => ({}) as never } });
    pollute({ decision: "allow" });
    expect((await guard.check({ tool: "t" })).decision).toBe("deny");
  });

  it("inherited `tool` does not satisfy a request", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    pollute({ tool: "t" });
    const fn = vi.fn();
    expect((await guard.execute({} as never, fn)).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("input keys", () => {
  it("a __proto__ key in input is rejected (it could smuggle fields past a policy via Object.assign)", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    const fn = vi.fn();
    for (const input of [
      JSON.parse('{"__proto__": {"isAdmin": true}, "name": "x"}'),
      JSON.parse('{"nested": {"__proto__": {"amount": 1000000}}}'),
    ]) {
      const result = await guard.execute({ tool: "t", input }, fn);
      expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("null-prototype objects are accepted", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    const input = Object.assign(Object.create(null), { a: 1 });
    expect(await guard.execute({ tool: "t", input }, (i) => i)).toMatchObject({
      ok: true,
      value: { a: 1 },
    });
  });
});
