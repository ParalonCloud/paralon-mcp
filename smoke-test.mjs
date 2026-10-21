// Smoke test: spawn the MCP server over stdio, list tools, and call the
// read-only tools end-to-end through the MCP protocol. With a 'rental' key it
// checks list_gpus and get_balance; with a 'nodes' key, list_my_nodes,
// get_my_node and get_earnings, plus the error paths of the change tools on a
// node that does not exist (nothing is changed).
//   PARALON_API_KEY=prlc_... node smoke-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.PARALON_API_KEY;
if (!key) {
  console.error("Set PARALON_API_KEY (a prlc_ key with the rental and/or nodes scope) to run this test.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./server.js", import.meta.url).pathname],
  env: { ...process.env, PARALON_API_KEY: key },
});

const client = new Client({ name: "smoke", version: "1.1.0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { data: JSON.parse(r.content[0].text), isError: r.isError === true };
};

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

const gpus = await call("list_gpus");
console.log("list_gpus:", gpus.data.total, "GPUs, isError:", gpus.isError);

const bal = await call("get_balance");
console.log("get_balance:", bal.data.balance, bal.data.currency, "isError:", bal.isError);

const nodes = await call("list_my_nodes");
if (nodes.isError) {
  console.log("list_my_nodes:", nodes.data.error, "(no 'nodes' scope on this key; provider tools skipped)");
} else {
  console.log("list_my_nodes:", nodes.data.nodes.length, "nodes:", nodes.data.nodes.map((n) => `${n.name}=${n.state}`).join(", "));
  if (nodes.data.nodes.length) {
    const one = await call("get_my_node", { node_id: nodes.data.nodes[0].id });
    const g = (one.data.metrics?.gpus || [])[0] || {};
    console.log("get_my_node:", one.data.name, one.data.state, `load ${g.utilization_pct ?? "-"}% temp ${g.temperature_c ?? "-"}C`, "isError:", one.isError);
  }
  const earn = await call("get_earnings", { days: 7 });
  console.log("get_earnings:", earn.data.days?.length, "days, total", earn.data.total, "balance", earn.data.earnings_balance, "isError:", earn.isError);

  // Error paths only: a node that does not exist, and bad input.
  const none = "00000000-0000-4000-8000-000000000000";
  for (const [tool, args, want] of [
    ["get_my_node", { node_id: none }, "node_not_found"],
    ["get_node_install_command", { node_id: none }, "node_not_found"],
    ["set_node_available", { node_id: none, available: false }, "node_not_found"],
    ["set_node_price", { node_id: none, price_per_hour: 1 }, "node_not_found"],
    ["update_node", { node_id: none }, "invalid_request"],
    ["reclaim_spot_node", { node_id: none }, "node_not_found"],
    ["add_node", { name: "x", type: "quantum" }, "invalid_request"],
  ]) {
    const r = await call(tool, args);
    const ok = r.isError && r.data.error === want;
    console.log(`${tool} (${want}):`, ok ? "ok" : `UNEXPECTED ${JSON.stringify(r.data)}`);
    if (!ok) process.exitCode = 1;
  }
}

await client.close();
console.log(process.exitCode ? "FAILED" : "OK");
