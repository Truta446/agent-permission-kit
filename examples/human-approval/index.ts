import { type AuditEvent, createGuard } from "agent-permission-kit";

/**
 * A stand-in for your real approval channel (Slack button, admin UI, ticket…).
 * Your application is responsible for authenticating the person who approves.
 */
async function askHuman(question: string, signal: AbortSignal): Promise<boolean> {
  console.log(`\n[approval needed] ${question}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 100); // pretend a human clicked "approve"
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
  return true;
}

const guard = createGuard<{ "payments.refund": { amount: number; orderId: string } }>({
  rules: {
    "payments.refund": ({ input }) => (input.amount < 50 ? "allow" : "require_approval"),
  },
  approvalTimeoutMs: 60_000,
  onApprovalRequired: async (request) => {
    const ok = await askHuman(
      `Refund $${request.input.amount} for order ${request.input.orderId}?`,
      request.signal, // aborted on timeout or when the caller gives up
    );
    return ok ? { approved: true, approvedBy: "manager@example.com" } : { approved: false };
  },
  // Structured audit trail. Inputs are not logged unless you opt in.
  onAudit: (event: AuditEvent) =>
    console.log(`[audit] ${event.type} ${event.tool} ${event.reason}`),
});

const result = await guard.execute(
  { tool: "payments.refund", input: { amount: 120, orderId: "A-1001" } },
  // Use `input` (the authorized snapshot), not variables captured from outside.
  async (input) => ({ refunded: input.amount }),
);

if (result.ok) {
  console.log("refunded:", result.value, "approved by:", result.approval?.approvedBy);
} else {
  console.log("not executed:", result.code, result.reason);
}
