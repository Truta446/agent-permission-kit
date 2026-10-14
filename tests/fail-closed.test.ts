import { describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";

const handler = () => vi.fn(async () => "executed");

describe("policy errors fail closed", () => {
  it("a throwing policy denies, and the handler never runs", async () => {
    const guard = createGuard({
      rules: {
        risky: () => {
          throw new Error("boom: secret=hunter2");
        },
      },
    });
    const fn = handler();
    const result = await guard.execute({ tool: "risky" }, fn);
    expect(result).toMatchObject({
      ok: false,
      code: "policy_error",
      decision: "deny",
      ruleId: "risky",
    });
    // The error message (which may echo sensitive data) is not surfaced.
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a rejecting async policy denies", async () => {
    const guard = createGuard({ rules: { risky: async () => Promise.reject(new Error("x")) } });
    expect(await guard.check({ tool: "risky" })).toMatchObject({
      decision: "deny",
      code: "policy_error",
    });
  });

  it("a policy that never settles times out and denies", async () => {
    const guard = createGuard({
      policyTimeoutMs: 20,
      rules: { slow: () => new Promise<"allow">(() => {}) },
    });
    const fn = handler();
    const result = await guard.execute({ tool: "slow" }, fn);
    expect(result).toMatchObject({ ok: false, code: "policy_error" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a slow policy that resolves 'allow' after the deadline still denies", async () => {
    const guard = createGuard({
      policyTimeoutMs: 10,
      rules: { slow: () => new Promise<"allow">((r) => setTimeout(() => r("allow"), 40)) },
    });
    expect((await guard.check({ tool: "slow" })).decision).toBe("deny");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["1", 1],
    ["'Allow' (wrong case)", "Allow"],
    ["'allow ' (trailing space)", "allow "],
    ["'approve'", "approve"],
    ["{}", {}],
    ["{ decision: 'yes' }", { decision: "yes" }],
    ["{ allowed: true }", { allowed: true }],
    ["['allow']", ["allow"]],
  ])("malformed policy result %s never grants access", async (_label, value) => {
    const guard = createGuard({ rules: { t: () => value as never } });
    const fn = handler();
    const result = await guard.execute({ tool: "t" }, fn);
    expect(result).toMatchObject({ ok: false, decision: "deny", code: "policy_error" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a result object with a throwing getter is denied", async () => {
    const guard = createGuard({
      rules: {
        t: () =>
          ({
            get decision(): never {
              throw new Error("getter");
            },
          }) as never,
      },
    });
    expect((await guard.check({ tool: "t" })).code).toBe("policy_error");
  });

  it("an inherited `decision` is ignored (only own properties count)", async () => {
    const guard = createGuard({ rules: { t: () => Object.create({ decision: "allow" }) } });
    expect((await guard.check({ tool: "t" })).decision).toBe("deny");
  });

  it("mutating the returned object after the fact does not change the decision", async () => {
    const out = { decision: "require_approval" as "allow" | "require_approval" };
    const guard = createGuard({
      rules: { t: () => out },
      onApprovalRequired: async () => {
        out.decision = "allow"; // too late to matter
        return { approved: false };
      },
    });
    const fn = handler();
    const result = await guard.execute({ tool: "t" }, fn);
    expect(result).toMatchObject({ ok: false, code: "approval_rejected" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("malformed requests are denied", () => {
  const guard = createGuard({ rules: { "a.b": "allow" }, defaultDecision: "require_approval" });

  it.each([
    ["missing tool", {}],
    ["numeric tool", { tool: 42 }],
    ["empty tool", { tool: "" }],
    ["whitespace tool", { tool: "a.b " }],
    ["newline tool", { tool: "a.b\n" }],
    ["null-byte tool", { tool: "a.b\u0000" }],
    ["unicode look-alike", { tool: "а.b" }], // Cyrillic "а"
    ["very long tool", { tool: "a".repeat(10_000) }],
  ])("%s", async (_label, request) => {
    const fn = handler();
    const result = await guard.execute(request as never, fn);
    expect(result).toMatchObject({ ok: false, code: "invalid_request", decision: "deny" });
    expect(fn).not.toHaveBeenCalled();
    expect(await guard.check(request as never)).toMatchObject({
      decision: "deny",
      code: "invalid_request",
    });
  });

  it.each([
    ["null", null],
    ["string", "a.b"],
    ["undefined", undefined],
  ])("non-object request (%s)", async (_label, request) => {
    expect(await guard.check(request as never)).toMatchObject({
      decision: "deny",
      code: "invalid_request",
    });
  });

  it.each([
    ["function", { f: () => 1 }],
    ["symbol", { s: Symbol("x") }],
    ["bigint", { n: 1n }],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["Date", { d: new Date() }],
    ["Map", { m: new Map() }],
    ["class instance", { c: new (class Foo {})() }],
    ["sparse array", { a: Object.assign(new Array(3), { 0: 1, 2: 3 }) }],
  ])("non-JSON input (%s) is denied, not coerced", async (_label, input) => {
    const fn = handler();
    const result = await guard.execute({ tool: "a.b", input }, fn);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("circular input is denied", async () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(await guard.check({ tool: "a.b", input })).toMatchObject({ code: "invalid_request" });
  });

  it("excessively deep input is denied", async () => {
    let input: unknown = 1;
    for (let i = 0; i < 100; i++) input = { n: input };
    expect(await guard.check({ tool: "a.b", input })).toMatchObject({ code: "invalid_request" });
  });

  it("invalid requestId or signal is denied", async () => {
    expect(await guard.check({ tool: "a.b", requestId: "" })).toMatchObject({
      code: "invalid_request",
    });
    expect(await guard.check({ tool: "a.b", requestId: 5 as never })).toMatchObject({
      code: "invalid_request",
    });
    expect(await guard.check({ tool: "a.b", signal: {} as never })).toMatchObject({
      code: "invalid_request",
    });
  });

  it("execute() without a handler function throws", async () => {
    await expect(guard.execute({ tool: "a.b" }, undefined as never)).rejects.toThrow(TypeError);
  });
});
