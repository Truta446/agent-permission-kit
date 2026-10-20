/**
 * An MCP server (official TypeScript SDK v2) whose tools are all guarded.
 * Run the client next to it: `node examples/mcp-server/client.ts`.
 *
 * With SDK v1 the code is identical; import McpServer from
 * "@modelcontextprotocol/sdk/server/mcp.js" and StdioServerTransport from
 * "@modelcontextprotocol/sdk/server/stdio.js".
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createGuard } from "agent-permission-kit";
import { guardMcpServer } from "agent-permission-kit/mcp";
import * as z from "zod";

type Tools = {
  "notes.read": { id: string };
  "notes.delete": { id: string };
  "payments.refund": { amount: number };
  "shell.exec": undefined;
};

const guard = createGuard<Tools>({
  rules: {
    "notes.read": "allow",
    "notes.delete": "deny",
    "payments.refund": ({ input }) => (input.amount < 50 ? "allow" : "require_approval"),
  },
  // No onApprovalRequired configured: approval-required calls are refused.
  // stdout carries the MCP protocol, so audit to stderr.
  onAudit: (e) => console.error(`[audit] ${e.type} ${e.tool} (${e.reason})`),
});

const server = new McpServer({ name: "guarded-demo", version: "1.0.0" });
guardMcpServer(server, guard); // must come before registerTool

server.registerTool(
  "notes.read",
  {
    description: "Read a note",
    inputSchema: z.object({ id: z.string() }),
    // Hosts use these hints to warn users before risky calls; declare all four.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }) => ({ content: [{ type: "text", text: `Note ${id}: buy milk` }] }),
);

server.registerTool(
  "notes.delete",
  {
    description: "Delete a note",
    inputSchema: z.object({ id: z.string() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }) => ({ content: [{ type: "text", text: `Deleted ${id}` }] }),
);

server.registerTool(
  "payments.refund",
  {
    description: "Refund a payment",
    inputSchema: z.object({ amount: z.number() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ amount }) => ({ content: [{ type: "text", text: `Refunded $${amount}` }] }),
);

// No rule at all → denied by default.
server.registerTool(
  "shell.exec",
  {
    description: "Run a shell command",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => ({
    content: [{ type: "text", text: "this never runs" }],
  }),
);

await server.connect(new StdioServerTransport());
