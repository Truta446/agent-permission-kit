import {
  DEFAULT_REASONS,
  InvalidPolicyResultError,
  isDecision,
  normalizeRuleResult,
  RULE_REASONS,
} from "./decisions.js";
import { errorName, GuardConfigError } from "./errors.js";
import { isValidToolName, wildcardPrefix } from "./names.js";
import { runWithDeadline } from "./timeout.js";
import type { DefaultDecision, PolicyContext, PolicyResult, Rule } from "./types.js";

type AnyRule = Rule<unknown, unknown>;

export interface CompiledPolicy {
  readonly exact: ReadonlyMap<string, AnyRule>;
  /** Sorted by prefix length, longest first. */
  readonly wildcards: readonly {
    readonly prefix: string;
    readonly key: string;
    readonly rule: AnyRule;
  }[];
  readonly defaultDecision: DefaultDecision;
  readonly policyTimeoutMs: number;
}

/**
 * Validates and copies the rule table into lookup structures that are
 * independent of the caller's object: mutating `rules` after `createGuard()`
 * has no effect, and lookups never touch `Object.prototype`.
 */
export function compilePolicy(
  rules: unknown,
  defaultDecision: DefaultDecision,
  policyTimeoutMs: number,
): CompiledPolicy {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new GuardConfigError("`rules` must be an object");
  }
  const exact = new Map<string, AnyRule>();
  const wildcards: { prefix: string; key: string; rule: AnyRule }[] = [];

  for (const key of Object.keys(rules)) {
    const rule: unknown = (rules as Record<string, unknown>)[key];
    if (!isDecision(rule) && typeof rule !== "function") {
      throw new GuardConfigError(
        `Rule "${key}" must be "allow", "deny", "require_approval" or a function`,
      );
    }
    const prefix = wildcardPrefix(key);
    if (prefix === null) {
      if (!isValidToolName(key)) throw new GuardConfigError(`Invalid tool name in rules: "${key}"`);
      exact.set(key, rule as AnyRule);
    } else {
      if (!isValidToolName(prefix) || prefix.includes("*")) {
        throw new GuardConfigError(
          `Invalid wildcard rule "${key}". Use "prefix.*"; for a catch-all use defaultDecision.`,
        );
      }
      wildcards.push({ prefix, key, rule: rule as AnyRule });
    }
  }
  if (Object.getOwnPropertySymbols(rules).length > 0) {
    throw new GuardConfigError("Rule keys must be strings");
  }
  // Distinct prefixes of equal length can never both match one name, so
  // longest-first gives a single, deterministic winner.
  wildcards.sort((a, b) => b.prefix.length - a.prefix.length);

  return Object.freeze({
    exact,
    wildcards: Object.freeze(wildcards.map((w) => Object.freeze(w))),
    defaultDecision,
    policyTimeoutMs,
  });
}

/** Exact match first, then the longest matching `prefix.*`, else `null`. */
export function findRule(
  policy: CompiledPolicy,
  tool: string,
): { key: string; rule: AnyRule } | null {
  const rule = policy.exact.get(tool);
  if (rule !== undefined) return { key: tool, rule };
  for (const w of policy.wildcards) {
    if (tool.length > w.prefix.length + 1 && tool.startsWith(`${w.prefix}.`)) {
      return { key: w.key, rule: w.rule };
    }
  }
  return null;
}

export interface Evaluation extends PolicyResult {
  /** Error class name when `code === "policy_error"`. */
  readonly errorName?: string;
}

/** Evaluates the policy for an already-validated tool name and snapshotted input. */
export async function evaluatePolicy(
  policy: CompiledPolicy,
  ctx: PolicyContext<unknown, unknown>,
): Promise<Evaluation> {
  const { tool, requestId } = ctx;
  const match = findRule(policy, tool);
  if (match === null) {
    const decision = policy.defaultDecision;
    return {
      decision,
      reason: DEFAULT_REASONS[decision],
      ruleId: null,
      code: "default",
      tool,
      requestId,
    };
  }
  const { key, rule } = match;
  if (typeof rule === "string") {
    return {
      decision: rule,
      reason: RULE_REASONS[rule],
      ruleId: key,
      code: "rule",
      tool,
      requestId,
    };
  }
  try {
    const raw = await runWithDeadline(() => rule(ctx), policy.policyTimeoutMs);
    const result = normalizeRuleResult(raw);
    return {
      decision: result.decision,
      reason: result.reason ?? RULE_REASONS[result.decision],
      ruleId: key,
      code: "rule",
      tool,
      requestId,
    };
  } catch (error) {
    return {
      decision: "deny",
      reason:
        error instanceof InvalidPolicyResultError
          ? "Policy returned an invalid result; denied"
          : "Policy evaluation failed; denied",
      ruleId: key,
      code: "policy_error",
      tool,
      requestId,
      errorName: errorName(error),
    };
  }
}
