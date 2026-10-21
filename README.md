# ParalonCloud Rentals — MCP server

Rent GPUs from inside your AI agent, and, if you provide GPUs, run your own nodes from it.
This is an [MCP](https://modelcontextprotocol.io) server for the
[ParalonCloud Rental API](https://paraloncloud.com/docs/rental-api) and
[Provider API](https://paraloncloud.com/docs/provider-api): it lets Claude Code, Claude
Desktop, Cursor, or any MCP client

- **rent**: browse GPUs, start a rental, get its connection URL, and stop it;
- **provide**: list your nodes with live GPU load and temperature, add a node and get its
  install command, take a node off the market and back, set its price, reclaim a spot
  node, and read your earnings,

using natural language.

> One key for everything: the same `prlc_` key powers ParalonCloud's
> [OpenAI-compatible inference API](https://paraloncloud.com/docs/inference-api). Build an
> agent that calls a model **and** rents the GPU to run the heavy job.

## Tools

### Renting (key needs the `rental` scope)

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_gpus` | List rentable GPUs with price, VRAM, compute capability, country | free |
| `get_balance` | Your credit balance | free |
| `create_rental` | Start a Jupyter rental (async → poll) | **spends credits** |
| `get_rental` | Status + connection URL once running | free |
| `list_rentals` | Your active rentals (`status: "all"` for history) | free |
| `destroy_rental` | Stop a rental and stop billing | — |

### Your nodes, for GPU providers (key needs the `nodes` scope)

| Tool | What it does |
| --- | --- |
| `list_my_nodes` | Your nodes: state (available, rented, paused, offline, …), GPUs, price and its allowed range, the current rental, live per-GPU load, temperature, power and memory |
| `get_my_node` | One node, same fields |
| `add_node` | Add a node; returns the docker command that installs the agent (it holds the node's token) |
| `get_node_install_command` | The install command of an existing node, again |
| `set_node_available` | Take a node off the market, or put it back; a running rental goes on to its end |
| `set_node_price` | Set the price in USD per hour for the node, or `null` for the default |
| `update_node` | Change name, spot, availability and price in one call |
| `reclaim_spot_node` | Take a spot node back for your own use; a spot rental on it stops in 2 minutes |
| `get_earnings` | Earnings by day (rentals per node, inference per account) and the withdrawable balance |

Payouts are not reachable from the API or this server. Deleting a node stays on the site.

## Setup

### 1. Get a key with the right scope

1. Create an API key in the [Console](https://paraloncloud.com/console).
2. To rent, turn on **GPU rentals** for that key (rentals are opt-in), and optionally set
   **Max rentals running at once** as a safety cap.
3. To manage your own nodes, turn on **My nodes**. One key can have both.

Use a **dedicated key** for the agent, not your production key.

### 2. Add it to your MCP client

The client passes your key via the `PARALON_API_KEY` env var — you never edit the server.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paraloncloud-rentals": {
      "command": "npx",
      "args": ["-y", "@paraloncloud/mcp-rentals"],
      "env": {
        "PARALON_API_KEY": "prlc_your_key_here"
      }
    }
  }
}
```

**Claude Code** — one command:

```bash
claude mcp add paraloncloud-rentals \
  --env PARALON_API_KEY=prlc_your_key_here \
  -- npx -y @paraloncloud/mcp-rentals
```

**Cursor** — `.cursor/mcp.json` (same shape as Claude Desktop above).

Optional env: `PARALON_BASE_URL` (defaults to `https://paraloncloud.com/api/v1`).

### 3. Try it

> "List the cheapest GPUs I can rent, then start a 2-hour Jupyter rental on one with at least 24GB of VRAM."

The agent calls `list_gpus`, picks a node, and calls `create_rental` with `hours: 2`. It then
polls `get_rental` for the Jupyter URL. Say "stop it" and it calls `destroy_rental`.

As a provider:

> "How are my nodes doing? Is any GPU running hot?"

> "Take rig-2 off the market for the afternoon, and set rig-1 to $0.60 an hour."

> "How much did I earn this week, and from which node?"

## Safety

- `create_rental` and `destroy_rental` change what you're billed — your MCP client will ask you
  to approve them (Claude Code/Desktop confirm tool calls by default). Keep that on.
- `create_rental` auto-generates an idempotency key, so a retried call never starts a second GPU.
- Pass `hours` so a rental auto-stops even if the agent forgets to.
- The key's `max_active_rentals` limit (set in the Console) caps concurrency regardless.
- The node tools that change something (`add_node`, `set_node_available`, `set_node_price`,
  `update_node`, `reclaim_spot_node`) tell the agent to confirm with you first;
  `reclaim_spot_node` stops a renter's spot rental two minutes later.
- `add_node` and `get_node_install_command` return a command with the node's secret token:
  keep it private.
- Give the agent a key with only the scopes it needs.

## Test

```bash
npm install
PARALON_API_KEY=prlc_your_key_here node smoke-test.mjs
```

It calls the read-only tools, and the node tools only on a node that does not exist, so it
changes nothing.

## Run locally (dev)

```bash
PARALON_API_KEY=prlc_your_key_here node server.js
```

## Links

- Rental API docs: https://paraloncloud.com/docs/rental-api
- Provider API docs: https://paraloncloud.com/docs/provider-api
- Console (create keys): https://paraloncloud.com/console
- Inference API: https://paraloncloud.com/docs/inference-api

MIT
