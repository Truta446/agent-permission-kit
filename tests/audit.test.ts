import { describe, expect, it, vi } from "vitest";
import { type AuditEvent, createGuard, REDACTED, redactInput } from "../src/index.js";

function collector() {
  const events: AuditEvent[] = [];
  return { events, onAudit: (e: AuditEvent) => void events.push(e) };
}

const rules = {
  "db.read": "allow",
  "db.delete": "deny",
  "payments.refund": "require_approval",
} as const;

describe("audit events", () => {
  it("allowed + succeeded", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "db.read", requestId: "r1" }, () => 1);
    expect(events.map((e) => e.type)).toEqual(["tool.allowed", "execution.succeeded"]);
    expect(events[0]).toEqual({
      type: "tool.allowed",
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      requestId: "r1",
      tool: "db.read",
      decision: "allow",
      reason: "Allowed by policy",
      ruleId: "db.read",
    });
    expect(events[1]?.durationMs).toEqual(expect.any(Number));
  });

  it("denied", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "db.delete" }, vi.fn());
    expect(events).toMatchObject([
      { type: "tool.denied", decision: "deny", code: "policy_denied", ruleId: "db.delete" },
    ]);
  });

  it("default deny for unknown tools", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "db.drop" }, vi.fn());
    expect(events).toMatchObject([{ type: "tool.denied", ruleId: null, code: "policy_denied" }]);
  });

  it("approval requested + granted + succeeded", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({
      rules,
      onAudit,
      onApprovalRequired: async () => ({ approved: true, approvedBy: "alice" }),
    });
    await guard.execute({ tool: "payments.refund" }, () => "ok");
    expect(events.map((e) => e.type)).toEqual([
      "approval.requested",
      "approval.granted",
      "execution.succeeded",
    ]);
    expect(events[1]).toMatchObject({ actor: "alice", decision: "require_approval" });
  });

  it("approval rejected", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({
      rules,
      onAudit,
      onApprovalRequired: async () => ({ approved: false, rejectedBy: "bob", reason: "no" }),
    });
    await guard.execute({ tool: "payments.refund" }, vi.fn());
    expect(events.map((e) => e.type)).toEqual(["approval.requested", "approval.rejected"]);
    expect(events[1]).toMatchObject({ code: "approval_rejected", actor: "bob", reason: "no" });
  });

  it("approval unavailable is recorded as a rejection", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "payments.refund" }, vi.fn());
    expect(events).toMatchObject([{ type: "approval.rejected", code: "approval_unavailable" }]);
  });

  it("execution failure records the error class but never the message", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await expect(
      guard.execute({ tool: "db.read" }, () => {
        throw new TypeError("password=hunter2");
      }),
    ).rejects.toThrow();
    expect(events.map((e) => e.type)).toEqual(["tool.allowed", "execution.failed"]);
    expect(events[1]).toMatchObject({ errorName: "TypeError" });
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("policy errors record the error class", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({
      onAudit,
      rules: {
        t: () => {
          throw new SyntaxError("x");
        },
      },
    });
    await guard.execute({ tool: "t" }, vi.fn());
    expect(events).toMatchObject([
      { type: "tool.denied", code: "policy_error", errorName: "SyntaxError" },
    ]);
  });

  it("invalid requests are audited", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "bad name" }, vi.fn());
    expect(events).toMatchObject([
      { type: "tool.denied", code: "invalid_request", tool: "<invalid>" },
    ]);
  });

  it("check() emits no audit events", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.check({ tool: "db.read" });
    await guard.check({ tool: "db.delete" });
    expect(events).toEqual([]);
  });
});

describe("sensitive data", () => {
  const input = {
    to: "a@b.c",
    password: "hunter2",
    nested: { apiKey: "sk-123", list: [{ token: "t" }] },
  };

  it("input is not logged by default", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit });
    await guard.execute({ tool: "db.read", input, context: { secret: "ctx" } }, () => 1);
    for (const e of events) expect(e).not.toHaveProperty("input");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("ctx");
  });

  it("auditInput: true logs input with sensitive keys redacted", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({ rules, onAudit, auditInput: true });
    await guard.execute({ tool: "db.read", input }, () => 1);
    expect(events[0]?.input).toEqual({
      to: "a@b.c",
      password: REDACTED,
      nested: { apiKey: REDACTED, list: [{ token: REDACTED }] },
    });
  });

  it("auditInput can be a custom redactor", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({
      rules,
      onAudit,
      auditInput: (value, tool) => ({ tool, keys: Object.keys(value as object) }),
    });
    await guard.execute({ tool: "db.read", input }, () => 1);
    expect(events[0]?.input).toEqual({ tool: "db.read", keys: ["to", "password", "nested"] });
  });

  it("a failing custom redactor never leaks the raw input", async () => {
    const { events, onAudit } = collector();
    const guard = createGuard({
      rules,
      onAudit,
      auditInput: () => {
        throw new Error("redactor bug");
      },
    });
    await guard.execute({ tool: "db.read", input }, () => 1);
    expect(events[0]?.input).toBe("[UNAVAILABLE]");
  });

  it("redactInput() handles arrays, primitives and __proto__ keys", () => {
    expect(redactInput([{ secret: 1 }, 2, "x", null])).toEqual([
      { secret: REDACTED },
      2,
      "x",
      null,
    ]);
    const out = redactInput(JSON.parse('{"__proto__": {"token": "x"}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
  });
});

describe("audit handlers cannot change decisions", () => {
  it("events are frozen; a mutating handler cannot flip a denial", async () => {
    const onAuditError = vi.fn();
    const guard = createGuard({
      rules,
      onAuditError,
      onAudit: (e) => {
        (e as { decision: string }).decision = "allow";
      },
    });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "db.delete" }, fn);
    expect(result).toMatchObject({ ok: false, decision: "deny" });
    expect(fn).not.toHaveBeenCalled();
    expect(onAuditError).toHaveBeenCalledWith(
      expect.any(TypeError),
      expect.objectContaining({ type: "tool.denied" }),
    );
  });

  it("a throwing audit handler does not turn a denial into an allow", async () => {
    const guard = createGuard({
      rules,
      onAuditError: () => {},
      onAudit: () => {
        throw new Error("log down");
      },
    });
    const fn = vi.fn();
    expect((await guard.execute({ tool: "db.delete" }, fn)).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("audit failures are reported, not swallowed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = createGuard({
      rules,
      onAudit: async () => Promise.reject(new Error("log down")),
    });
    await guard.execute({ tool: "db.read" }, () => 1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a throwing onAuditError does not break execution", async () => {
    const guard = createGuard({
      rules,
      onAudit: () => {
        throw new Error("a");
      },
      onAuditError: () => {
        throw new Error("b");
      },
    });
    expect(await guard.execute({ tool: "db.read" }, () => 1)).toMatchObject({ ok: true, value: 1 });
  });

  it("by default an audit failure does not block an allowed call", async () => {
    const guard = createGuard({
      rules,
      onAuditError: () => {},
      onAudit: () => {
        throw new Error("log down");
      },
    });
    expect(await guard.execute({ tool: "db.read" }, () => 1)).toMatchObject({ ok: true });
  });

  it("requireAudit: an unrecorded allow blocks execution (fail closed)", async () => {
    const guard = createGuard({
      rules,
      requireAudit: true,
      onAuditError: () => {},
      onAudit: () => {
        throw new Error("log down");
      },
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "db.read" }, fn)).toMatchObject({
      ok: false,
      code: "audit_failed",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("requireAudit: an unrecorded approval blocks execution", async () => {
    const guard = createGuard({
      rules,
      requireAudit: true,
      onAuditError: () => {},
      onApprovalRequired: async () => ({ approved: true }),
      onAudit: (e) => {
        if (e.type === "approval.granted") throw new Error("log down");
      },
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "payments.refund" }, fn)).toMatchObject({
      ok: false,
      code: "audit_failed",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("requireAudit: a failure after execution still returns the result (no retry → no double execution)", async () => {
    const guard = createGuard({
      rules,
      requireAudit: true,
      onAuditError: () => {},
      onAudit: (e) => {
        if (e.type === "execution.succeeded") throw new Error("log down");
      },
    });
    const fn = vi.fn(() => "done");
    expect(await guard.execute({ tool: "db.read" }, fn)).toMatchObject({ ok: true, value: "done" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("async audit handlers are awaited in order", async () => {
    const seen: string[] = [];
    const guard = createGuard({
      rules,
      onAudit: async (e) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(e.type);
      },
    });
    await guard.execute({ tool: "db.read" }, () => seen.push("handler"));
    expect(seen).toEqual(["tool.allowed", "handler", "execution.succeeded"]);
  });
});

describe("check() audit opt-in (#5)", () => {
  it("emits policy.evaluated only when asked, without input by default", async () => {
    const events: AuditEvent[] = [];
    const guard = createGuard({ rules, onAudit: (e) => void events.push(e) });
    await guard.check({ tool: "db.delete", input: { password: "x" } });
    expect(events).toEqual([]);
    const result = await guard.check(
      { tool: "db.delete", input: { password: "x" } },
      { audit: true },
    );
    expect(events).toEqual([
      {
        type: "policy.evaluated",
        timestamp: expect.any(String),
        requestId: result.requestId,
        tool: "db.delete",
        decision: "deny",
        reason: "Denied by policy",
        ruleId: "db.delete",
      },
    ]);
  });

  it("audits invalid requests and policy errors too", async () => {
    const events: AuditEvent[] = [];
    const guard = createGuard({
      onAudit: (e) => void events.push(e),
      rules: {
        boom: () => {
          throw new RangeError("x");
        },
      },
    });
    await guard.check({ tool: "bad name" }, { audit: true });
    await guard.check({ tool: "boom" }, { audit: true });
    expect(events).toMatchObject([
      { type: "policy.evaluated", tool: "<invalid>", decision: "deny" },
      { type: "policy.evaluated", tool: "boom", decision: "deny", errorName: "RangeError" },
    ]);
  });

  it("a throwing audit handler cannot change the check result", async () => {
    const guard = createGuard({
      rules,
      onAuditError: () => {},
      onAudit: (e) => {
        (e as { decision: string }).decision = "allow";
      },
    });
    expect((await guard.check({ tool: "db.delete" }, { audit: true })).decision).toBe("deny");
  });
});
