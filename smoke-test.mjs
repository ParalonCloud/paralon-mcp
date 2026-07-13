// Smoke test: spawn the MCP server over stdio, list tools, and call the two
// read-only tools (list_gpus, get_balance) end-to-end through the MCP protocol.
//   PARALON_API_KEY=prlc_... node smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.PARALON_API_KEY;
if (!key) {
  console.error("Set PARALON_API_KEY (a prlc_ key with the rental scope) to run this test.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./server.js", import.meta.url).pathname],
  env: { ...process.env, PARALON_API_KEY: key },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

const gpus = await client.callTool({ name: "list_gpus", arguments: {} });
const gpusData = JSON.parse(gpus.content[0].text);
console.log("list_gpus:", gpusData.total, "GPUs, isError:", gpus.isError === true);

const bal = await client.callTool({ name: "get_balance", arguments: {} });
const balData = JSON.parse(bal.content[0].text);
console.log("get_balance:", balData.balance, balData.currency, "isError:", bal.isError === true);

await client.close();
console.log("OK");
