/**
 * Test helpers. Pin your policy in CI so a rule change that flips a decision
 * fails a test instead of reaching production.
 *
 * @example
 * import { expectDecisions } from "agent-permission-kit/testing";
 *
 * await expectDecisions(guard, [
 *   ["payments.refund", { amount: 10 }, "allow"],
 *   ["payments.refund", { amount: 100 }, "require_approval"],
 *   ["db.drop", undefined, "deny"],
 * ]);
 */
import type { Decision, Guard } from "./core/types.js";

/** `[tool, input, expectedDecision, context?]` */
export type DecisionCase = readonly [
  tool: string,
  input: unknown,
  expected: Decision,
  context?: unknown,
];

export class DecisionMismatchError extends Error {
  override name = "DecisionMismatchError";
  constructor(
    readonly mismatches: readonly {
      readonly tool: string;
      readonly input: unknown;
      readonly expected: Decision;
      readonly actual: Decision;
      readonly reason: string;
    }[],
  ) {
    super(
      `${mismatches.length} policy decision(s) differ from the expected table:\n` +
        mismatches
          .map(
            (m) =>
              `  - ${m.tool} ${safeJson(m.input)}: expected ${m.expected}, got ${m.actual} (${m.reason})`,
          )
          .join("\n"),
    );
  }
}

/**
 * Runs `guard.check()` for every case and throws one `DecisionMismatchError`
 * listing every mismatch. Framework-agnostic: works with vitest, jest,
 * node:test or a plain script. Uses `check()`, so it never calls approval
 * callbacks or handlers.
 */
export async function expectDecisions(
  // biome-ignore lint/suspicious/noExplicitAny: accepts a guard of any tool map.
  guard: Guard<any, any>,
  cases: readonly DecisionCase[],
): Promise<void> {
  const mismatches: DecisionMismatchError["mismatches"][number][] = [];
  for (const [tool, input, expected, context] of cases) {
    const result = await guard.check({
      tool,
      ...(input !== undefined && { input }),
      ...(context !== undefined && { context }),
    });
    if (result.decision !== expected) {
      mismatches.push({ tool, input, expected, actual: result.decision, reason: result.reason });
    }
  }
  if (mismatches.length > 0) throw new DecisionMismatchError(mismatches);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
