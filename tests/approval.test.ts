import { describe, expect, it, vi } from "vitest";
import { type ApprovalResponse, createGuard } from "../src/index.js";

const rules = { "payments.refund": "require_approval" } as const;

describe("human approval", () => {
  it("runs the handler only after { approved: true }", async () => {
    const order: string[] = [];
    const guard = createGuard({
      rules,
      onApprovalRequired: async (req) => {
        order.push("approval");
        expect(req).toMatchObject({
          tool: "payments.refund",
          input: { amount: 200 },
          reason: "Human approval required",
          ruleId: "payments.refund",
        });
        expect(req.signal).toBeInstanceOf(AbortSignal);
        expect(req.requestedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        return { approved: true, approvedBy: "alice@example.com" };
      },
    });
    const result = await guard.execute(
      { tool: "payments.refund", input: { amount: 200 } },
      async (input, ctx) => {
        order.push("handler");
        expect(ctx.approval).toEqual({ approvedBy: "alice@example.com" });
        return input;
      },
    );
    expect(order).toEqual(["approval", "handler"]);
    expect(result).toMatchObject({
      ok: true,
      decision: "require_approval",
      approval: { approvedBy: "alice@example.com" },
      value: { amount: 200 },
    });
  });

  it("missing approval callback never grants access", async () => {
    const guard = createGuard({ rules });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "payments.refund" }, fn);
    expect(result).toMatchObject({
      ok: false,
      code: "approval_unavailable",
      decision: "require_approval",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("explicit rejection never executes", async () => {
    const guard = createGuard({
      rules,
      onApprovalRequired: async () => ({ approved: false, reason: "Too large", rejectedBy: "bob" }),
    });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "payments.refund" }, fn);
    expect(result).toMatchObject({ ok: false, code: "approval_rejected", reason: "Too large" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a throwing callback never grants access", async () => {
    const guard = createGuard({
      rules,
      onApprovalRequired: () => {
        throw new Error("approval service down");
      },
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "payments.refund" }, fn)).toMatchObject({
      ok: false,
      code: "approval_error",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a rejecting callback never grants access", async () => {
    const guard = createGuard({
      rules,
      onApprovalRequired: async () => Promise.reject(new Error("network")),
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "payments.refund" }, fn)).toMatchObject({
      ok: false,
      code: "approval_error",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("times out, aborts the approval signal, and ignores a late approval", async () => {
    let approvalSignal: AbortSignal | undefined;
    let lateApprove: ((r: ApprovalResponse) => void) | undefined;
    const guard = createGuard({
      rules,
      approvalTimeoutMs: 20,
      onApprovalRequired: (req) =>
        new Promise<ApprovalResponse>((resolve) => {
          approvalSignal = req.signal;
          lateApprove = resolve;
        }),
    });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "payments.refund" }, fn);
    expect(result).toMatchObject({ ok: false, code: "approval_timeout" });
    expect(approvalSignal?.aborted).toBe(true);
    lateApprove?.({ approved: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["'yes'", "yes"],
    ["{ approved: 'true' }", { approved: "true" }],
    ["{ approved: 1 }", { approved: 1 }],
    ["{ status: 'approved' }", { status: "approved" }],
    ["{ status: 'pending' }", { status: "pending" }],
    ["{ approved: undefined }", { approved: undefined }],
    ["inherited approved", Object.create({ approved: true })],
  ])("invalid response %s is not an approval", async (_label, response) => {
    const guard = createGuard({ rules, onApprovalRequired: async () => response as never });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "payments.refund" }, fn);
    expect(result).toMatchObject({ ok: false, code: "approval_invalid" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a response with a throwing getter is not an approval", async () => {
    const guard = createGuard({
      rules,
      onApprovalRequired: async () =>
        ({
          get approved(): never {
            throw new Error("x");
          },
        }) as never,
    });
    expect(await guard.execute({ tool: "payments.refund" }, vi.fn())).toMatchObject({
      ok: false,
      code: "approval_invalid",
    });
  });

  it("caller abort during approval cancels the request and the approval signal", async () => {
    const controller = new AbortController();
    let approvalSignal: AbortSignal | undefined;
    const guard = createGuard({
      rules,
      onApprovalRequired: (req) => {
        approvalSignal = req.signal;
        setTimeout(() => controller.abort(), 5);
        return new Promise<ApprovalResponse>(() => {});
      },
    });
    const fn = vi.fn();
    const result = await guard.execute({ tool: "payments.refund", signal: controller.signal }, fn);
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(approvalSignal?.aborted).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("an already-aborted signal never reaches the approver", async () => {
    const approver = vi.fn(async () => ({ approved: true as const }));
    const guard = createGuard({ rules, onApprovalRequired: approver });
    const result = await guard.execute(
      { tool: "payments.refund", signal: AbortSignal.abort() },
      vi.fn(),
    );
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(approver).not.toHaveBeenCalled();
  });

  it("approvals are single-use: every execute() asks again", async () => {
    const approver = vi.fn(async () => ({ approved: true as const }));
    const guard = createGuard({ rules, onApprovalRequired: approver });
    await guard.execute({ tool: "payments.refund", input: { amount: 1 } }, async () => 1);
    await guard.execute({ tool: "payments.refund", input: { amount: 1 } }, async () => 1);
    expect(approver).toHaveBeenCalledTimes(2);
  });

  it("check() never invokes the approval callback", async () => {
    const approver = vi.fn(async () => ({ approved: true as const }));
    const guard = createGuard({ rules, onApprovalRequired: approver });
    expect((await guard.check({ tool: "payments.refund" })).decision).toBe("require_approval");
    expect(approver).not.toHaveBeenCalled();
  });

  it("the approver receives the same frozen input the handler will get", async () => {
    let seen: unknown;
    const guard = createGuard({
      rules,
      onApprovalRequired: async (req) => {
        seen = req.input;
        expect(Object.isFrozen(req)).toBe(true);
        expect(() => {
          (req.input as { amount: number }).amount = 1;
        }).toThrow(TypeError);
        return { approved: true };
      },
    });
    const result = await guard.execute(
      { tool: "payments.refund", input: { amount: 200 } },
      (input) => input,
    );
    expect(result.ok && result.value).toBe(seen);
  });

  it("rejected approvals for one tool do not leak to others", async () => {
    const guard = createGuard<{ a: unknown; b: unknown }>({
      rules: { a: "require_approval", b: "require_approval" },
      onApprovalRequired: async (req) => ({ approved: req.tool === "b" }),
    });
    const [a, b] = await Promise.all([
      guard.execute({ tool: "a" }, async () => "a"),
      guard.execute({ tool: "b" }, async () => "b"),
    ]);
    expect(a.ok).toBe(false);
    expect(b).toMatchObject({ ok: true, value: "b" });
  });
});
