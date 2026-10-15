import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    mcp: "src/adapters/mcp.ts",
    testing: "src/testing.ts",
    "ai-sdk": "src/adapters/ai-sdk.ts",
    "openai-agents": "src/adapters/openai-agents.ts",
    "claude-agent-sdk": "src/adapters/claude-agent-sdk.ts",
  },
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  // Zero runtime dependencies: nothing may be left external except Node built-ins.
  deps: { neverBundle: [] },
});
