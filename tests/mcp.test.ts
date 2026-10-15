/**
 * Integration tests against the real official MCP TypeScript SDKs — v1
 * (`@modelcontextprotocol/sdk`) and v2 (`@modelcontextprotocol/server` +
 * `@modelcontextprotocol/client`) — connected over in-memory transports.
 */
import { Client as ClientV2, InMemoryTransport as InMemoryV2 } from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as InMemoryV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { guardMcpServer, guardToolHandler } from "../src/adapters/mcp.js";
import { type ApprovalResponse, type AuditEvent, createGuard } from "../src/index.js";

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: two different SDK server classes.
  server: any;
  connect(): Promise<{ call(name: string, args?: Record<string, unknown>): Promise<CallResult> }>;
}

const sdks: [string, () => Harness][] = [
  [
    "v1 (@modelcontextprotocol/sdk)",
    () => {
      const server = new McpServerV1({ name: "test", version: "1.0.0" });
      return {
        server,
        async connect() {
          const [clientT, serverT] = InMemoryV1.createLinkedPair();
          const client = new ClientV1({ name: "c", version: "1.0.0" });
          await Promise.all([server.connect(serverT), client.connect(clientT)]);
          return {
            call: async (name, args) =>
              (await client.callTool({ name, arguments: args })) as CallResult,
          };
        },
      };
    },
  ],
  [
    "v2 (@modelcontextprotocol/server)",
    () => {
      const server = new McpServerV2({ name: "test", version: "1.0.0" });
      return {
        server,
        async connect() {
          const [clientT, serverT] = InMemoryV2.createLinkedPair();
          const client = new ClientV2({ name: "c", version: "1.0.0" });
          await Promise.all([server.connect(serverT), client.connect(clientT)]);
          return {
            call: async (name, args) =>
              (await client.callTool({ name, arguments: args })) as CallResult,
          };
        },
      };
    },
  ],
];

const text = (r: CallResult) => r.content.map((c) => c.text).join("");

describe.each(sdks)("MCP %s", (_label, make) => {
  it("guardMcpServer: allowed tools run, denied and unknown tools do not", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { "db.read": "allow", "db.delete": "deny" } });
    guardMcpServer(server, guard);

    const read = vi.fn(async ({ id }: { id: number }) => ({
      content: [{ type: "text" as const, text: `row ${id}` }],
    }));
    const del = vi.fn(async () => ({ content: [{ type: "text" as const, text: "deleted" }] }));
    const other = vi.fn(async () => ({ content: [{ type: "text" as const, text: "other" }] }));
    server.registerTool("db.read", { inputSchema: z.object({ id: z.number() }) }, read);
    server.registerTool("db.delete", { inputSchema: z.object({ id: z.number() }) }, del);
    server.registerTool("db.unlisted", {}, other);

    const client = await connect();
    expect(text(await client.call("db.read", { id: 7 }))).toBe("row 7");
    const denied = await client.call("db.delete", { id: 7 });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("was not executed");
    expect((await client.call("db.unlisted")).isError).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it("conditional rules see the schema-validated arguments", async () => {
    const { server, connect } = make();
    const guard = createGuard<{ "payments.refund": { amount: number } }>({
      rules: { "payments.refund": ({ input }) => (input.amount < 50 ? "allow" : "deny") },
    });
    guardMcpServer(server, guard);
    const refund = vi.fn(async ({ amount }: { amount: number }) => ({
      content: [{ type: "text" as const, text: `refunded ${amount}` }],
    }));
    server.registerTool(
      "payments.refund",
      { inputSchema: z.object({ amount: z.number() }) },
      refund,
    );

    const client = await connect();
    expect(text(await client.call("payments.refund", { amount: 10 }))).toBe("refunded 10");
    expect((await client.call("payments.refund", { amount: 100 })).isError).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("human approval gates execution", async () => {
    const { server, connect } = make();
    let answer: ApprovalResponse = { approved: false };
    const guard = createGuard({
      rules: { "email.send": "require_approval" },
      onApprovalRequired: async () => answer,
    });
    guardMcpServer(server, guard);
    const send = vi.fn(async () => ({ content: [{ type: "text" as const, text: "sent" }] }));
    server.registerTool("email.send", { inputSchema: z.object({ to: z.string() }) }, send);

    const client = await connect();
    const rejected = await client.call("email.send", { to: "x@y.z" });
    expect(rejected.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
    answer = { approved: true, approvedBy: "ops" };
    expect(text(await client.call("email.send", { to: "x@y.z" }))).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the handler receives the frozen authorized snapshot", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { echo: "allow" } });
    guardMcpServer(server, guard);
    let received: unknown;
    server.registerTool(
      "echo",
      { inputSchema: z.object({ v: z.string() }) },
      async (args: unknown) => {
        received = args;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );
    const client = await connect();
    await client.call("echo", { v: "hi" });
    expect(received).toEqual({ v: "hi" });
    expect(Object.isFrozen(received)).toBe(true);
  });

  it("handler errors are reported by the SDK, not swallowed", async () => {
    const { server, connect } = make();
    const events: AuditEvent[] = [];
    const guard = createGuard({ rules: { boom: "allow" }, onAudit: (e) => void events.push(e) });
    guardMcpServer(server, guard);
    server.registerTool("boom", {}, async () => {
      throw new Error("kaput");
    });
    const client = await connect();
    const result = await client.call("boom");
    expect(result.isError).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["tool.allowed", "execution.failed"]);
  });

  it("update({ callback }) cannot install an unguarded handler", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { secret: "deny" } });
    guardMcpServer(server, guard);
    const registered = server.registerTool("secret", {}, async () => ({ content: [] }));
    const replacement = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "leaked" }],
    }));
    registered.update({ callback: replacement });
    const client = await connect();
    expect((await client.call("secret")).isError).toBe(true);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("update({ name }) re-binds the policy to the new name", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { "safe.read": "allow", "danger.wipe": "deny" } });
    guardMcpServer(server, guard);
    const fn = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    const registered = server.registerTool("safe.read", {}, fn);
    registered.update({ name: "danger.wipe" });
    const client = await connect();
    expect((await client.call("danger.wipe")).isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes a policy context built from the request", async () => {
    const { server, connect } = make();
    const guard = createGuard<Record<string, unknown>, { session: string | undefined }>({
      rules: { whoami: ({ context }) => (context ? "allow" : "deny") },
    });
    guardMcpServer(server, guard, { context: (extra) => ({ session: extra.sessionId }) });
    server.registerTool("whoami", {}, async () => ({
      content: [{ type: "text" as const, text: "me" }],
    }));
    const client = await connect();
    expect(text(await client.call("whoami"))).toBe("me");
  });

  it("custom denial result", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: {} });
    guardMcpServer(server, guard, {
      onDenied: (d) => ({ content: [{ type: "text", text: `NOPE ${d.code}` }], isError: true }),
    });
    server.registerTool("x", {}, async () => ({ content: [] }));
    const client = await connect();
    expect(text(await client.call("x"))).toBe("NOPE policy_denied");
  });

  it("refuses to guard a server that already has tools, or to guard twice", () => {
    const { server } = make();
    const guard = createGuard({ rules: {} });
    server.registerTool("early", {}, async () => ({ content: [] }));
    if (server._registeredTools !== undefined) {
      expect(() => guardMcpServer(server, guard)).toThrow(/before any tool is registered/);
    }
    const fresh = make().server;
    guardMcpServer(fresh, guard);
    expect(() => guardMcpServer(fresh, guard)).toThrow(/already applied/);
  });

  it("guardToolHandler: explicit per-tool wrapping without patching the server", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { "a.ok": "allow", "a.no": "deny" } });
    const ok = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const no = vi.fn(async () => ({ content: [{ type: "text" as const, text: "no" }] }));
    server.registerTool("a.ok", {}, guardToolHandler(guard, "a.ok", ok));
    server.registerTool(
      "a.no",
      { inputSchema: z.object({ q: z.string() }) },
      guardToolHandler(guard, "a.no", no),
    );
    const client = await connect();
    expect(text(await client.call("a.ok"))).toBe("ok");
    expect((await client.call("a.no", { q: "x" })).isError).toBe(true);
    expect(no).not.toHaveBeenCalled();
  });

  it("does not double-prompt when a handler is wrapped explicitly and by guardMcpServer", async () => {
    const { server, connect } = make();
    const approver = vi.fn(async () => ({ approved: true as const }));
    const guard = createGuard({ rules: { t: "require_approval" }, onApprovalRequired: approver });
    guardMcpServer(server, guard);
    const fn = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    server.registerTool("t", {}, guardToolHandler(guard, "t", fn));
    const client = await connect();
    expect(text(await client.call("t"))).toBe("ran");
    expect(approver).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a pre-wrapped handler is re-bound to the registration name (copy-paste safety)", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { "db.read": "allow", "db.drop": "deny" } });
    guardMcpServer(server, guard);
    const drop = vi.fn(async () => ({ content: [{ type: "text" as const, text: "dropped" }] }));
    // Wrapped under the wrong name by mistake: the registration name must win.
    server.registerTool("db.drop", {}, guardToolHandler(guard, "db.read", drop));
    const client = await connect();
    expect((await client.call("db.drop")).isError).toBe(true);
    expect(drop).not.toHaveBeenCalled();
  });

  it("a pre-wrapped handler follows update({ name })", async () => {
    const { server, connect } = make();
    const guard = createGuard({ rules: { "notes.read": "allow", "notes.purge": "deny" } });
    guardMcpServer(server, guard);
    const purge = vi.fn(async () => ({ content: [{ type: "text" as const, text: "purged" }] }));
    const registered = server.registerTool(
      "notes.read",
      {},
      guardToolHandler(guard, "notes.read", purge),
    );
    registered.update({ name: "notes.purge" });
    const client = await connect();
    expect((await client.call("notes.purge")).isError).toBe(true);
    expect(purge).not.toHaveBeenCalled();
  });

  it("registration paths that bypass registerTool are blocked", () => {
    const { server } = make();
    guardMcpServer(server, createGuard({ rules: {} }));
    expect(() =>
      server._createRegisteredTool(
        "x",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => ({ content: [] }),
      ),
    ).toThrow(/bypasses the guard/);
  });
});

describe("MCP v1-specific bypass paths", () => {
  it("direct assignment to registeredTool.handler is wrapped", async () => {
    const server = new McpServerV1({ name: "t", version: "1" });
    guardMcpServer(server, createGuard({ rules: { t: "deny" } }));
    const registered = server.registerTool("t", {}, async () => ({ content: [] }));
    const leaked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "leaked" }] }));
    (registered as unknown as { handler: unknown }).handler = leaked;
    const [clientT, serverT] = InMemoryV1.createLinkedPair();
    const client = new ClientV1({ name: "c", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    expect(((await client.callTool({ name: "t" })) as CallResult).isError).toBe(true);
    expect(leaked).not.toHaveBeenCalled();
  });

  it("the deprecated server.tool() is disabled", () => {
    const server = new McpServerV1({ name: "t", version: "1" });
    guardMcpServer(server, createGuard({ rules: {} }));
    expect(() => server.tool("x", async () => ({ content: [] }))).toThrow(/disabled/);
  });

  it("experimental registerToolTask is disabled (it would register an unguarded task tool)", () => {
    const server = new McpServerV1({ name: "t", version: "1" });
    guardMcpServer(server, createGuard({ rules: { "db.drop": "deny" } }));
    expect(() =>
      server.experimental.tasks.registerToolTask(
        "db.drop",
        { execution: { taskSupport: "optional" } } as never,
        { createTask: async () => ({}) } as never,
      ),
    ).toThrow(/disabled by guardMcpServer/);
  });

  it("non-function handlers are refused instead of registered unguarded", () => {
    const server = new McpServerV1({ name: "t", version: "1" });
    guardMcpServer(server, createGuard({ rules: {} }));
    expect(() => server.registerTool("x", {}, { createTask: () => {} } as never)).toThrow(
      TypeError,
    );
  });
});

describe("guardToolHandler used on its own", () => {
  const extra = { signal: new AbortController().signal };
  /** Calls a wrapped handler the way the SDK does for a tool without an input schema. */
  const callNoArgs = (h: unknown) => (h as (extra: unknown) => Promise<unknown>)(extra);

  it("re-wrapping with another name re-binds the policy to that name", async () => {
    const guard = createGuard({ rules: { "db.read": "allow", "db.drop": "deny" } });
    const drop = vi.fn(async () => ({ content: [] }));
    const handler = guardToolHandler(guard, "db.drop", guardToolHandler(guard, "db.read", drop));
    const result = (await callNoArgs(handler)) as CallResult;
    expect(result.isError).toBe(true);
    expect(drop).not.toHaveBeenCalled();
  });

  it("the outermost name wins: the inner binding is replaced, not stacked", async () => {
    const guard = createGuard({ rules: { "a.ok": "allow", "a.no": "deny" } });
    const fn = vi.fn(async () => ({ content: [] }));
    await callNoArgs(guardToolHandler(guard, "a.ok", guardToolHandler(guard, "a.no", fn)));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-wrapping with the same name does not ask for approval twice", async () => {
    const approver = vi.fn(async () => ({ approved: true as const }));
    const guard = createGuard({ rules: { t: "require_approval" }, onApprovalRequired: approver });
    const fn = vi.fn(async () => ({ content: [] }));
    const handler = guardToolHandler(guard, "t", guardToolHandler(guard, "t", fn));
    await callNoArgs(handler);
    expect(approver).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
