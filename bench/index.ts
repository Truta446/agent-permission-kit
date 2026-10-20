/**
 * Reproducible overhead benchmark. Run: `pnpm bench`.
 * Numbers depend on the machine; compare relative costs, not absolutes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGuard } from "agent-permission-kit";
import { guardMcpServer } from "agent-permission-kit/mcp";
import { Bench } from "tinybench";
import * as z from "zod";

const small = { id: 123, table: "users" };
const medium = {
  query: "x".repeat(2000),
  filters: Array.from({ length: 100 }, (_, i) => ({ field: `f${i}`, op: "eq", value: i })),
}; // ~10 KB as JSON
const large = {
  rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}`, tags: ["a", "b"] })),
}; // ~250 KB

const rulesStatic = Object.fromEntries(
  Array.from({ length: 200 }, (_, i) => [`ns${i}.tool`, i % 2 ? "allow" : "deny"] as const),
);
const guard = createGuard({
  rules: {
    ...rulesStatic,
    "db.read": "allow",
    "db.*": "deny",
    "db.admin.*": "deny",
    "payments.refund": ({ input }) =>
      (input as { amount: number }).amount < 50 ? "allow" : "deny",
  },
});
const audited = createGuard({ rules: { "db.read": "allow" }, onAudit: () => {}, auditInput: true });
const noop = () => 1;

const bench = new Bench({ time: 400 });
bench
  .add("baseline: await handler() without guard", async () => {
    await noop();
  })
  .add("check: exact static rule (200-rule table)", async () => {
    await guard.check({ tool: "db.read" });
  })
  .add("check: wildcard match", async () => {
    await guard.check({ tool: "db.admin.drop" });
  })
  .add("check: function rule", async () => {
    await guard.check({ tool: "payments.refund", input: { amount: 10 } });
  })
  .add("check: unknown tool (default deny)", async () => {
    await guard.check({ tool: "nope.never" });
  })
  .add("execute: small input", async () => {
    await guard.execute({ tool: "db.read", input: small }, noop);
  })
  .add("execute: ~10 KB input", async () => {
    await guard.execute({ tool: "db.read", input: medium }, noop);
  })
  .add("execute: ~250 KB input", async () => {
    await guard.execute({ tool: "db.read", input: large }, noop);
  })
  .add("execute: small input + audit + redaction", async () => {
    await audited.execute({ tool: "db.read", input: small }, noop);
  });

// MCP round trip over an in-memory transport, guarded vs. unguarded.
async function mcpClient(guarded: boolean) {
  const server = new McpServer({ name: "b", version: "1" });
  if (guarded) guardMcpServer(server, createGuard({ rules: { "db.read": "allow" } }));
  server.registerTool(
    "db.read",
    {
      description: "Read one row",
      inputSchema: { id: z.number() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => ({
      content: [{ type: "text", text: String(id) }],
    }),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const plainClient = await mcpClient(false);
const guardedClient = await mcpClient(true);
bench
  .add("MCP tools/call round trip (unguarded)", async () => {
    await plainClient.callTool({ name: "db.read", arguments: { id: 1 } });
  })
  .add("MCP tools/call round trip (guardMcpServer)", async () => {
    await guardedClient.callTool({ name: "db.read", arguments: { id: 1 } });
  });

await bench.run();
console.table(
  bench.tasks.map((t) => {
    const r = t.result as {
      latency?: { mean: number; p99: number };
      throughput?: { mean: number };
    };
    return {
      task: t.name,
      "mean (µs)": r.latency ? (r.latency.mean * 1000).toFixed(2) : "-",
      "p99 (µs)": r.latency ? (r.latency.p99 * 1000).toFixed(2) : "-",
      "ops/s": r.throughput ? Math.round(r.throughput.mean).toLocaleString("en-US") : "-",
    };
  }),
);
await plainClient.close();
await guardedClient.close();
