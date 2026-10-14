/** Spawns server.ts over stdio and calls each tool. */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", new URL("./server.ts", import.meta.url).pathname],
});
const client = new Client({ name: "demo-client", version: "1.0.0" });
await client.connect(transport);

const calls: [string, Record<string, unknown>?][] = [
  ["notes.read", { id: "42" }],
  ["notes.delete", { id: "42" }],
  ["payments.refund", { amount: 20 }],
  ["payments.refund", { amount: 900 }],
  ["shell.exec"],
];

for (const [name, args] of calls) {
  const result = await client.callTool({ name, ...(args && { arguments: args }) });
  const text = (result.content as { type: string; text?: string }[]).map((c) => c.text).join("");
  console.log(`${result.isError ? "✗" : "✓"} ${name} ${JSON.stringify(args ?? {})} → ${text}`);
}

await client.close();
