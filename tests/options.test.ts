import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard, GuardConfigError, type ReplayStore } from "../src/index.js";

describe("replayStore (#7)", () => {
  class MemoryStore implements ReplayStore {
    readonly ids = new Set<string>();
    async claim(id: string) {
      if (this.ids.has(id)) return false;
      this.ids.add(id);
      return true;
    }
  }

  it("shares replay protection between guards (e.g. two processes)", async () => {
    const store = new MemoryStore();
    const a = createGuard({ rules: { t: "allow" }, replayStore: store });
    const b = createGuard({ rules: { t: "allow" }, replayStore: store });
    const fn = vi.fn(() => 1);
    expect((await a.execute({ tool: "t", requestId: "call_1" }, fn)).ok).toBe(true);
    expect(await b.execute({ tool: "t", requestId: "call_1" }, fn)).toMatchObject({
      ok: false,
      code: "duplicate_request",
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("redis down");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("redis down"))],
    ["never settles", () => new Promise<boolean>(() => {})],
  ])("a store that %s denies with replay_check_failed", async (_label, claim) => {
    const guard = createGuard({
      rules: { t: "allow" },
      policyTimeoutMs: 20,
      replayStore: { claim: claim as ReplayStore["claim"] },
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "t", requestId: "x" }, fn)).toMatchObject({
      ok: false,
      code: "replay_check_failed",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["1", 1],
    ["'true'", "true"],
    ["undefined", undefined],
  ])("a store answering %s is not a first use", async (_label, answer) => {
    const guard = createGuard({
      rules: { t: "allow" },
      replayStore: { claim: () => answer as never },
    });
    expect((await guard.execute({ tool: "t", requestId: "x" }, vi.fn())).ok).toBe(false);
  });

  it("requests without a caller-supplied id never touch the store", async () => {
    const claim = vi.fn(() => true);
    const guard = createGuard({ rules: { t: "allow" }, replayStore: { claim } });
    await guard.execute({ tool: "t" }, () => 1);
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects an invalid store", () => {
    expect(() => createGuard({ rules: {}, replayStore: {} as never })).toThrow(GuardConfigError);
  });
});

describe("nullPrototypeInput (#15)", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).isAdmin;
  });

  it("a polluted Object.prototype cannot fill in absent fields", async () => {
    const rule = ({ input }: { input: unknown }) =>
      (input as { isAdmin?: boolean }).isAdmin === true ? ("allow" as const) : ("deny" as const);
    const plain = createGuard({ rules: { t: rule } });
    const hardened = createGuard({ rules: { t: rule }, nullPrototypeInput: true });
    Object.defineProperty(Object.prototype, "isAdmin", { value: true, configurable: true });
    expect((await plain.check({ tool: "t", input: { name: "x" } })).decision).toBe("allow"); // the documented risk
    expect((await hardened.check({ tool: "t", input: { name: "x" } })).decision).toBe("deny");
  });

  it("snapshots are deeply null-prototype and still frozen", async () => {
    const guard = createGuard({ rules: { t: "allow" }, nullPrototypeInput: true });
    const result = await guard.execute({ tool: "t", input: { a: { b: [{ c: 1 }] } } }, (i) => i);
    const value = result.ok ? (result.value as { a: { b: { c: number }[] } }) : undefined;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value?.a)).toBeNull();
    expect(Object.getPrototypeOf(value?.a.b[0])).toBeNull();
    expect(Object.isFrozen(value?.a.b[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual({ a: { b: [{ c: 1 }] } });
  });
});
