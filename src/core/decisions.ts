import { own } from "./errors.js";
import type { Decision } from "./types.js";

const DECISIONS: ReadonlySet<string> = new Set<Decision>(["allow", "deny", "require_approval"]);

export function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && DECISIONS.has(value);
}

export const RULE_REASONS: Readonly<Record<Decision, string>> = Object.freeze({
  allow: "Allowed by policy",
  deny: "Denied by policy",
  require_approval: "Human approval required",
});

export const DEFAULT_REASONS: Readonly<Record<Decision, string>> = Object.freeze({
  allow: "Allowed by default",
  deny: "No rule matches this tool; denied by default",
  require_approval: "No rule matches this tool; human approval required by default",
});

const MAX_REASON_LENGTH = 1000;

export class InvalidPolicyResultError extends Error {
  override name = "InvalidPolicyResultError";
}

/**
 * Converts whatever a policy function returned into `{ decision, reason? }`,
 * copying the fields so later mutation of the returned object has no effect.
 * Throws on anything that is not exactly a known decision.
 */
export function normalizeRuleResult(raw: unknown): { decision: Decision; reason?: string } {
  if (isDecision(raw)) return { decision: raw };
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidPolicyResultError("Policy returned a non-decision value");
  }
  const decision = own(raw, "decision");
  if (!isDecision(decision)) {
    throw new InvalidPolicyResultError("Policy returned an unknown decision");
  }
  const reason = own(raw, "reason");
  if (typeof reason === "string" && reason.length > 0) {
    return { decision, reason: reason.slice(0, MAX_REASON_LENGTH) };
  }
  return { decision };
}

/** Trims an externally supplied reason or actor string. */
export function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_REASON_LENGTH)
    : undefined;
}
