/**
 * Smoke test: drive the built server over a real stdio transport.
 *
 * Existence checks on tool names are not enough — a server can advertise tools
 * and still fail the handshake. This performs the actual MCP sequence
 * (initialize -> tools/list -> tools/call) against the compiled entry point.
 *
 *   node scripts/probe-stdio.mjs [path/to/dist/index.js]
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2] ?? resolve(here, "../dist/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`  [server] ${chunk}`));

const client = new Client({ name: "probe-stdio", version: "0.0.0" });

try {
  await client.connect(transport);

  const info = client.getServerVersion();
  console.log(`  initialize   OK  ${info?.name} ${info?.version}`);

  const instructions = client.getInstructions();
  const firstLine = instructions?.split("\n")[0] ?? "(none)";
  console.log(`  instructions OK  ${firstLine}`);

  const { tools } = await client.listTools();
  console.log(`  tools/list   OK  ${tools.length} tool(s)`);
  for (const tool of tools) {
    const { readOnlyHint, idempotentHint } = tool.annotations ?? {};
    console.log(`      - ${tool.name}  readOnly=${readOnlyHint} idempotent=${idempotentHint}`);
  }

  const result = await client.callTool({ name: "ping", arguments: {} });
  console.log(`  tools/call   OK  ${JSON.stringify(result.structuredContent)}`);

  await client.close();
  console.log("\nPASS");
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  await client.close().catch(() => {});
  process.exit(1);
}
