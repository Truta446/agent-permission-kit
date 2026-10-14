import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    mcp: "src/adapters/mcp.ts",
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
