import { describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";

describe("execute()", () => {
  const guard = createGuard({
    rules: { "database.read": "allow", "database.delete": "deny" },
  });

  it("runs allowed handlers exactly once and returns their value", async () => {
    const fn = vi.fn(async (input: unknown) => ({ row: input }));
    const result = await guard.execute({ tool: "database.read", input: { id: 123 } }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: { row: { id: 123 } },
      decision: "allow",
      ruleId: "database.read",
      tool: "database.read",
      requestId: expect.any(String),
    });
  });

  it("never runs denied handlers", async () => {
    const fn = vi.fn();
    const result = await guard.execute({ tool: "database.delete", input: { id: 1 } }, fn);
    expect(result).toMatchObject({ ok: false, code: "policy_denied", decision: "deny" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("never runs handlers for unknown tools", async () => {
    const fn = vi.fn();
    expect((await guard.execute({ tool: "database.drop" }, fn)).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("re-throws handler errors unchanged (the handler did run)", async () => {
    const error = new RangeError("bad id");
    await expect(
      guard.execute({ tool: "database.read" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("supports synchronous handlers", async () => {
    const result = await guard.execute({ tool: "database.read" }, () => 42);
    expect(result).toMatchObject({ ok: true, value: 42 });
  });

  it("passes requestId, tool and signal to the handler", async () => {
    const controller = new AbortController();
    await guard.execute(
      { tool: "database.read", requestId: "call_1", signal: controller.signal },
      (_input, ctx) => {
        expect(ctx).toEqual({
          tool: "database.read",
          requestId: "call_1",
          signal: controller.signal,
          approval: undefined,
        });
      },
    );
  });

  it("does not run the handler if the caller aborted before execution", async () => {
    const fn = vi.fn();
    const result = await guard.execute({ tool: "database.read", signal: AbortSignal.abort() }, fn);
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not cancel a handler that is already running", async () => {
    const controller = new AbortController();
    const result = await guard.execute(
      { tool: "database.read", signal: controller.signal },
      async (_input, ctx) => {
        controller.abort();
        expect(ctx.signal?.aborted).toBe(true);
        return "finished";
      },
    );
    expect(result).toMatchObject({ ok: true, value: "finished" });
  });

  it("the result object is frozen", async () => {
    const result = await guard.execute({ tool: "database.read" }, () => 1);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("authorization is bound to the exact input", () => {
  it("the handler receives the frozen snapshot that was evaluated", async () => {
    let evaluated: unknown;
    const guard = createGuard({
      rules: {
        "files.write": ({ input }) => {
          evaluated = input;
          return "allow";
        },
      },
    });
    const original = { path: "/tmp/a", meta: { tags: ["x"] } };
    await guard.execute({ tool: "files.write", input: original }, (input) => {
      expect(input).toBe(evaluated);
      expect(input).not.toBe(original);
      expect(input).toEqual(original);
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen((input as typeof original).meta.tags)).toBe(true);
    });
  });

  it("mutating the caller's object while approval is pending does not change what runs", async () => {
    const input = { amount: 10 };
    const guard = createGuard({
      rules: {
        "payments.refund": ({ input }) =>
          (input as { amount: number }).amount < 50 ? "require_approval" : "deny",
      },
      onApprovalRequired: async () => {
        input.amount = 1_000_000; // the agent tampers with its arguments mid-flight
        return { approved: true };
      },
    });
    const result = await guard.execute(
      { tool: "payments.refund", input },
      (authorized) => authorized,
    );
    expect(result).toMatchObject({ ok: true, value: { amount: 10 } });
  });

  it("a getter is read exactly once, so it cannot show the policy one value and the handler another", async () => {
    let reads = 0;
    const input = {
      get path() {
        reads++;
        return reads === 1 ? "/tmp/safe" : "/etc/passwd";
      },
    };
    const guard = createGuard({
      rules: {
        "files.delete": ({ input }) =>
          (input as { path: string }).path.startsWith("/tmp/") ? "allow" : "deny",
      },
    });
    const result = await guard.execute(
      { tool: "files.delete", input },
      (i) => (i as { path: string }).path,
    );
    expect(result).toMatchObject({ ok: true, value: "/tmp/safe" });
    expect(reads).toBe(1);
  });

  it("policies cannot mutate the input seen by later stages", async () => {
    const guard = createGuard({
      rules: {
        t: ({ input }) => {
          try {
            (input as { a: number }).a = 2;
          } catch {
            // frozen
          }
          return "allow";
        },
      },
    });
    const result = await guard.execute({ tool: "t", input: { a: 1 } }, (i) => i);
    expect(result).toMatchObject({ ok: true, value: { a: 1 } });
  });
});

describe("replay protection", () => {
  it("refuses to execute the same caller-supplied requestId twice", async () => {
    const guard = createGuard({ rules: { "email.send": "allow" } });
    const fn = vi.fn(async () => "sent");
    const first = await guard.execute({ tool: "email.send", requestId: "toolu_01" }, fn);
    const second = await guard.execute({ tool: "email.send", requestId: "toolu_01" }, fn);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "duplicate_request" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("concurrent duplicates execute at most once", async () => {
    const guard = createGuard({ rules: { "email.send": "allow" } });
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "sent";
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => guard.execute({ tool: "email.send", requestId: "dup" }, fn)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a denied requestId cannot be retried to slip through later", async () => {
    let allow = false;
    const guard = createGuard({ rules: { t: () => (allow ? "allow" : "deny") } });
    const fn = vi.fn();
    expect((await guard.execute({ tool: "t", requestId: "r1" }, fn)).ok).toBe(false);
    allow = true;
    expect(await guard.execute({ tool: "t", requestId: "r1" }, fn)).toMatchObject({
      code: "duplicate_request",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("generated request ids are unique and do not trigger replay protection", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = await guard.execute({ tool: "t" }, () => null);
      expect(r.ok).toBe(true);
      ids.add(r.requestId);
    }
    expect(ids.size).toBe(50);
  });

  it("guards do not share replay state", async () => {
    const a = createGuard({ rules: { t: "allow" } });
    const b = createGuard({ rules: { t: "allow" } });
    expect((await a.execute({ tool: "t", requestId: "same" }, () => 1)).ok).toBe(true);
    expect((await b.execute({ tool: "t", requestId: "same" }, () => 1)).ok).toBe(true);
  });
});

describe("concurrency", () => {
  it("parallel calls with interleaved async policies and approvals keep their own inputs", async () => {
    const guard = createGuard<{ op: { n: number } }>({
      rules: {
        op: async ({ input }) => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return input.n % 3 === 0 ? "deny" : input.n % 3 === 1 ? "allow" : "require_approval";
        },
      },
      onApprovalRequired: async (req) => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return { approved: req.input.n % 2 === 0 };
      },
    });
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, n) =>
        guard.execute({ tool: "op", input: { n } }, async (input) => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return input.n;
        }),
      ),
    );
    results.forEach((result, n) => {
      const expected = n % 3 === 1 || (n % 3 === 2 && n % 2 === 0);
      expect(result.ok, `n=${n}`).toBe(expected);
      if (result.ok) expect(result.value).toBe(n);
    });
  });
});
