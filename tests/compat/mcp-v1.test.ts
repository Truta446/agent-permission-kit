/**
 * MCP SDK v1 only, with nothing newer than zod 3.25 can run. CI runs this file
 * a second time against the oldest supported pair:
 * @modelcontextprotocol/sdk 1.30 + zod 3.25 (`compat` job).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { guardMcpServer } from "../../src/adapters/mcp.js";
import { createGuard } from "../../src/index.js";

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function setup(rules: Parameters<typeof createGuard>[0]["rules"]) {
  const server = new McpServer({ name: "compat", version: "1" });
  guardMcpServer(server, createGuard({ rules }));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  return {
    server,
    call: async (name: string, args?: Record<string, unknown>) => {
      if (!client.transport) await Promise.all([server.connect(serverT), client.connect(clientT)]);
      return (await client.callTool({ name, ...(args && { arguments: args }) })) as CallResult;
    },
  };
}

describe("MCP SDK v1 compatibility", () => {
  it("allows, denies and applies conditional rules to zod-validated arguments", async () => {
    const { server, call } = await setup({
      "db.read": "allow",
      refund: ({ input }) => ((input as { amount: number }).amount < 50 ? "allow" : "deny"),
    });
    const read = vi.fn(async () => ({ content: [{ type: "text" as const, text: "row" }] }));
    const refund = vi.fn(async ({ amount }: { amount: number }) => ({
      content: [{ type: "text" as const, text: `refunded ${amount}` }],
    }));
    server.registerTool("db.read", {}, read);
    server.registerTool("refund", { inputSchema: { amount: z.number() } }, refund);
    server.registerTool("db.drop", {}, vi.fn());
    expect((await call("db.read")).isError).toBeFalsy();
    expect((await call("refund", { amount: 10 })).content[0]?.text).toBe("refunded 10");
    expect((await call("refund", { amount: 100 })).isError).toBe(true);
    expect((await call("db.drop")).isError).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("update({ callback, name }) and handler assignment stay guarded", async () => {
    const { server, call } = await setup({ "safe.read": "allow", "danger.wipe": "deny" });
    const leaked = vi.fn(async () => ({ content: [] }));
    const registered = server.registerTool(
      "safe.read",
      {},
      vi.fn(async () => ({ content: [] })),
    );
    registered.update({ name: "danger.wipe", callback: leaked });
    (registered as unknown as { handler: unknown }).handler = leaked;
    expect((await call("danger.wipe")).isError).toBe(true);
    expect(leaked).not.toHaveBeenCalled();
  });
});
