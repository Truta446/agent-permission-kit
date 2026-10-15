/**
 * Regression tests for findings from the pre-release adversarial review.
 * Each test fails if the corresponding fix is reverted.
 */
import { describe, expect, it, vi } from "vitest";
import { type AuditEvent, createGuard, GuardConfigError, REDACTED } from "../src/index.js";

describe("input size limit", () => {
  it("denies inputs with more than maxInputNodes values", async () => {
    const guard = createGuard({ rules: { t: "allow" }, maxInputNodes: 10 });
    const fn = vi.fn();
    expect(
      await guard.execute({ tool: "t", input: { a: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }, fn),
    ).toMatchObject({
      ok: false,
      code: "invalid_request",
      reason: "Input exceeds 10 values",
    });
    expect(fn).not.toHaveBeenCalled();
    expect((await guard.execute({ tool: "t", input: { a: [1, 2] } }, () => 1)).ok).toBe(true);
  });

  it("the default limit (100 000) rejects huge inputs quickly", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    const started = performance.now();
    const result = await guard.check({ tool: "t", input: { rows: new Array(5_000_000).fill(0) } });
    expect(result.code).toBe("invalid_request");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("an array claiming a huge length is rejected before allocation", async () => {
    const guard = createGuard({ rules: { t: "allow" } });
    const fake = new Proxy([], { get: (t, k) => (k === "length" ? 2 ** 31 : Reflect.get(t, k)) });
    expect((await guard.check({ tool: "t", input: { fake } })).code).toBe("invalid_request");
  });

  it("rejects invalid maxInputNodes", () => {
    for (const v of [0, -1, 1.5, Number.NaN, "10"]) {
      expect(() => createGuard({ rules: {}, maxInputNodes: v as number })).toThrow(
        GuardConfigError,
      );
    }
  });
});

describe("audit hardening", () => {
  it("requireAudit without onAudit is a configuration error", () => {
    expect(() => createGuard({ rules: { t: "allow" }, requireAudit: true })).toThrow(
      GuardConfigError,
    );
  });

  it("a hung onAudit cannot hang execute()", async () => {
    const onAuditError = vi.fn();
    const guard = createGuard({
      rules: { t: "allow" },
      auditTimeoutMs: 20,
      onAuditError,
      onAudit: () => new Promise<void>(() => {}),
    });
    expect(await guard.execute({ tool: "t" }, () => 1)).toMatchObject({ ok: true, value: 1 });
    expect(onAuditError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "TimeoutError" }),
      expect.anything(),
    );
  });

  it("with requireAudit, an audit timeout blocks execution", async () => {
    const guard = createGuard({
      rules: { t: "allow" },
      requireAudit: true,
      auditTimeoutMs: 20,
      onAuditError: () => {},
      onAudit: () => new Promise<void>(() => {}),
    });
    const fn = vi.fn();
    expect(await guard.execute({ tool: "t" }, fn)).toMatchObject({
      ok: false,
      code: "audit_failed",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("redacts common credential key names and URL credentials", async () => {
    const events: AuditEvent[] = [];
    const guard = createGuard({
      rules: { t: "allow" },
      auditInput: true,
      onAudit: (e) => void events.push(e),
    });
    const input = {
      accessKey: "a",
      access_key_id: "b",
      otp: "123456",
      mfaCode: "1",
      bearer: "x",
      jwt: "y",
      mnemonic: "words",
      seedPhrase: "words",
      pinCode: "1234",
      signingKey: "k",
      api_key: "k",
      databaseUrl: "postgres://u:p@h/db",
      note: "connect to postgres://admin:hunter2@db.internal:5432/app please",
      title: "harmless",
    };
    await guard.execute({ tool: "t", input }, () => 1);
    const logged = events[0]?.input as Record<string, unknown>;
    for (const key of Object.keys(input).filter((k) => k !== "note" && k !== "title")) {
      expect(logged[key], key).toBe(REDACTED);
    }
    expect(logged.title).toBe("harmless");
    expect(logged.note).toBe(`connect to postgres://${REDACTED}@db.internal:5432/app please`);
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });
});

describe("hostile requests", () => {
  const guard = createGuard({ rules: { t: "allow" } });

  it("requestId must be printable ASCII (no log-line forging)", async () => {
    for (const requestId of ["a\nb", "a b", "x\u001b[31m", "é"]) {
      expect((await guard.check({ tool: "t", requestId })).code, JSON.stringify(requestId)).toBe(
        "invalid_request",
      );
    }
    expect((await guard.check({ tool: "t", requestId: "toolu_01AbC-9:x/y" })).code).toBe("rule");
  });

  it("a throwing getter on the request resolves to invalid_request instead of rejecting", async () => {
    const request = {
      get tool(): string {
        throw new Error("boom");
      },
    };
    const fn = vi.fn();
    await expect(guard.execute(request as never, fn)).resolves.toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a forged AbortSignal is rejected", async () => {
    const signal = Object.create(AbortSignal.prototype) as AbortSignal;
    const fn = vi.fn();
    expect(await guard.execute({ tool: "t", signal }, fn)).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("value-based redaction (#16)", () => {
  async function logged(input: unknown) {
    const events: AuditEvent[] = [];
    const guard = createGuard({
      rules: { t: "allow" },
      auditInput: true,
      onAudit: (e) => void events.push(e),
    });
    await guard.execute({ tool: "t", input }, () => 1);
    return JSON.stringify(events[0]?.input);
  }

  it.each([
    [
      "JWT",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here",
    ],
    ["Bearer header pair", [["Authorization", "Bearer abcdefghijklmnop1234"]]],
    ["OpenAI-style key", "use sk-proj-abcdefghijklmnopqrstuvwx please"],
    ["Stripe key", "sk_live_51HabcdefghijklmnopQRS"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["Slack token", "xoxb-1234567890-abcdefghij"],
    ["AWS key id", "AKIAABCDEFGHIJKLMNOP"],
    ["name/value pair", [{ name: "API_KEY", value: "plain-looking-secret" }]],
    ["key/value pair", [{ key: "password", value: "hunter2" }]],
  ])("redacts %s inside values", async (_label, input) => {
    const out = await logged({ note: input });
    expect(out).toContain(REDACTED);
    for (const secret of [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIi",
      "abcdefghijklmnop1234",
      "sk-proj-abc",
      "sk_live_51H",
      "ghp_abc",
      "xoxb-123",
      "AKIAABCD",
      "plain-looking-secret",
      "hunter2",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("leaves ordinary text alone", async () => {
    const text = "Refund order A-1001 for customer 42, skip weekends, basic plan";
    expect(await logged({ note: text })).toBe(JSON.stringify({ note: text }));
  });

  it("stays linear on long adversarial strings", async () => {
    const started = performance.now();
    await logged({ note: `Bearer ${"a".repeat(200_000)} eyJ${"x".repeat(200_000)}` });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
