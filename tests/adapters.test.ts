/**
 * Framework adapters, tested against the real SDK packages: a real
 * `generateText` loop (AI SDK, mock model), real `tool()` objects (OpenAI
 * Agents), and the Claude Agent SDK's own callback types.
 */
import type { CanUseTool, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { tool as openaiTool, RunContext } from "@openai/agents";
import { tool as aiTool, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import * as z from "zod";
import { toolApproval } from "../src/adapters/ai-sdk.js";
import { canUseTool, preToolUseHook } from "../src/adapters/claude-agent-sdk.js";
import { guardTool, needsApproval } from "../src/adapters/openai-agents.js";
import { type AuditEvent, createGuard } from "../src/index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

function modelCalling(toolName: string, input: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

describe("AI SDK toolApproval (#2)", () => {
  const guard = createGuard({
    rules: {
      "db.read": "allow",
      "db.drop": "deny",
      refund: ({ input }) =>
        (input as { amount: number }).amount < 50 ? "allow" : "require_approval",
    },
  });

  async function run(toolName: string, input: unknown) {
    const execute = vi.fn(async () => "ran");
    const tools = {
      [toolName]: aiTool({ inputSchema: z.object({}).passthrough(), execute }),
    };
    const result = await generateText({
      model: modelCalling(toolName, input),
      tools,
      prompt: "go",
      toolApproval: toolApproval(guard),
    });
    return {
      execute,
      types: result.content.map((p) => p.type),
      parts: result.content as unknown[],
    };
  }

  it("allow → approved: the SDK executes the tool", async () => {
    const { execute } = await run("db.read", {});
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("deny → denied: the SDK does not execute it", async () => {
    const { execute, parts } = await run("db.drop", {});
    expect(execute).not.toHaveBeenCalled();
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-approval-response",
        approved: false,
        reason: "Denied by policy",
      }),
    );
  });

  it("conditional require_approval → the SDK asks the user instead of executing", async () => {
    const small = await run("refund", { amount: 10 });
    expect(small.execute).toHaveBeenCalledTimes(1);
    const large = await run("refund", { amount: 500 });
    expect(large.execute).not.toHaveBeenCalled();
    expect(large.types).toContain("tool-approval-request");
  });

  it("unknown tools are denied and decisions are audited", async () => {
    const events: AuditEvent[] = [];
    const audited = createGuard({ rules: {}, onAudit: (e) => void events.push(e) });
    const approval = toolApproval(audited);
    expect(
      await approval({ toolCall: { toolName: "anything", toolCallId: "call_9", input: {} } }),
    ).toEqual({
      type: "denied",
      reason: "No rule matches this tool; denied by default",
    });
    expect(events).toMatchObject([
      { type: "policy.evaluated", requestId: "call_9", decision: "deny" },
    ]);
  });
});

describe("OpenAI Agents needsApproval / guardTool (#4)", () => {
  type Ctx = { role: "agent" | "admin" };
  const guard = createGuard<Record<string, unknown>, Ctx>({
    rules: {
      lookup: "allow",
      wipe: "deny",
      refund: ({ context }) => (context?.role === "admin" ? "allow" : "require_approval"),
    },
  });
  const ctx = (role: Ctx["role"]) => new RunContext<Ctx>({ role });
  const options = { context: (rc: { context?: unknown } | undefined) => rc?.context as Ctx };

  function sdkTool(name: string, fn = vi.fn(async () => "done")) {
    const t = openaiTool({
      name,
      description: name,
      parameters: z.object({ amount: z.number() }),
      ...guardTool(guard, name, fn, options),
    });
    return { t, fn };
  }

  it("allowed tools run without approval", async () => {
    const { t, fn } = sdkTool("lookup");
    expect(await t.needsApproval(ctx("agent"), { amount: 1 }, "c1")).toBe(false);
    expect(await t.invoke(ctx("agent"), JSON.stringify({ amount: 1 }))).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("require_approval → needsApproval true (SDK interruption); depends on context", async () => {
    const { t } = sdkTool("refund");
    expect(await t.needsApproval(ctx("agent"), { amount: 1 }, "c1")).toBe(true);
    expect(await t.needsApproval(ctx("admin"), { amount: 1 }, "c1")).toBe(false);
  });

  it("deny → execute refuses even if the SDK calls it", async () => {
    const { t, fn } = sdkTool("wipe");
    expect(await t.needsApproval(ctx("admin"), { amount: 1 }, "c1")).toBe(false);
    const output = await t.invoke(ctx("admin"), JSON.stringify({ amount: 1 }));
    expect(output).toBe('Tool call "wipe" was not executed: Denied by policy');
    expect(fn).not.toHaveBeenCalled();
  });

  it("standalone needsApproval sends denied calls to a human rather than allowing them", async () => {
    const approval = needsApproval(guard, "wipe", options);
    expect(await approval(ctx("admin"), { amount: 1 })).toBe(true);
  });
});

describe("Claude Agent SDK hook / canUseTool (#3)", () => {
  const guard = createGuard({
    rules: {
      Read: "allow",
      Bash: ({ input }) =>
        String((input as { command?: string }).command).startsWith("git status")
          ? "allow"
          : "require_approval",
      mcp__billing__refund: "deny",
    },
    onApprovalRequired: async (req) => ({
      approved: (req.input as { command: string }).command === "ls",
    }),
  });
  const signal = new AbortController().signal;
  const hookInput = (tool_name: string, tool_input: unknown) => ({
    hook_event_name: "PreToolUse" as const,
    tool_name,
    tool_input,
    tool_use_id: "toolu_1",
    session_id: "s",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
  });

  it("types are assignable to the SDK's HookCallback and CanUseTool", () => {
    const hook: HookCallback = preToolUseHook(guard);
    const permission: CanUseTool = canUseTool(guard);
    expectTypeOf(permission).toEqualTypeOf<CanUseTool>();
    expect(typeof hook).toBe("function");
  });

  it("PreToolUse maps decisions, including default deny for tools a permissive mode would allow", async () => {
    const hook = preToolUseHook(guard);
    const decision = async (tool: string, input: unknown) =>
      (await hook(hookInput(tool, input), "toolu_1", { signal })).hookSpecificOutput
        ?.permissionDecision;
    expect(await decision("Read", { file_path: "/a" })).toBe("allow");
    expect(await decision("Bash", { command: "git status" })).toBe("allow");
    expect(await decision("Bash", { command: "rm -rf /" })).toBe("ask");
    expect(await decision("mcp__billing__refund", {})).toBe("deny");
    expect(await decision("WebFetch", { url: "https://x" })).toBe("deny");
    expect(
      await preToolUseHook(guard, { onAllow: "defer" })(hookInput("Read", {}), "t", { signal }),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "defer" },
    });
    expect(await hook({ hook_event_name: "PostToolUse" }, undefined, { signal })).toEqual({});
  });

  it("canUseTool runs approval and returns exactly the authorized input", async () => {
    const permission = canUseTool(guard);
    const original = { command: "ls" };
    const allowed = await permission("Bash", original, { signal, toolUseID: "toolu_2" });
    expect(allowed).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    if (allowed.behavior === "allow") expect(allowed.updatedInput).not.toBe(original);
    expect(
      await permission("Bash", { command: "rm -rf /" }, { signal, toolUseID: "toolu_3" }),
    ).toEqual({
      behavior: "deny",
      message: "Approval rejected",
    });
    expect(
      await permission("mcp__billing__refund", {}, { signal, toolUseID: "toolu_4" }),
    ).toMatchObject({
      behavior: "deny",
    });
  });

  it("canUseTool refuses a replayed toolUseID", async () => {
    const permission = canUseTool(guard);
    expect(
      (await permission("Read", { file_path: "/a" }, { signal, toolUseID: "toolu_same" })).behavior,
    ).toBe("allow");
    expect(
      await permission("Read", { file_path: "/a" }, { signal, toolUseID: "toolu_same" }),
    ).toMatchObject({
      behavior: "deny",
    });
  });
});
