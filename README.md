# ParalonCloud MCP server

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

> Formerly `@paraloncloud/mcp-rentals`. That package is deprecated: switch your config to `@paraloncloud/mcp`.

## Tools

### Renting (key needs the `rental` scope)

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_gpus` | List rentable GPUs with price, VRAM, compute capability, country | free |
| `get_balance` | Your credit balance | free |
| `list_templates` | Apps a rental can start with (ComfyUI), their version and minimums | free |
| `create_rental` | Start a rental with JupyterLab or SSH (`type: "ssh"`), optionally with an app installed (`template: "comfyui"`) (async → poll) | **spends credits** |
| `get_rental` | Status + the JupyterLab URL or the SSH command once running, and an app's link (`connection.app_url`) | free |
| `list_rentals` | Your active rentals (`status: "all"` for history) | free |
| `destroy_rental` | Stop a rental and stop billing | — |
| `list_ssh_keys` | The SSH public keys an SSH rental installs | free |
| `add_ssh_key` | Save an SSH public key (the `.pub` line, never the private key) | free |
| `delete_ssh_key` | Delete a saved key; new SSH rentals stop accepting it | free |

An SSH rental installs every saved key, so the agent can make its own key, add it, rent with
`type: "ssh"`, and run commands on the machine. Connecting needs
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
on the computer that holds the private key: `get_rental` returns the command.

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
| `get_node_access` | Who can rent a node: everyone, or only the people, domains and organizations listed |
| `set_node_access` | Keep a node private for chosen renters (email, domain, organization), or open it to everyone (`[]`) |
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
    "paraloncloud": {
      "command": "npx",
      "args": ["-y", "@paraloncloud/mcp"],
      "env": {
        "PARALON_API_KEY": "prlc_your_key_here"
      }
    }
  }
}
```

**Claude Code** — one command:

```bash
claude mcp add paraloncloud \
  --env PARALON_API_KEY=prlc_your_key_here \
  -- npx -y @paraloncloud/mcp
```

**Cursor** — `.cursor/mcp.json` (same shape as Claude Desktop above).

Optional env: `PARALON_BASE_URL` (defaults to `https://paraloncloud.com/api/v1`).

### 3. Try it

> "List the cheapest GPUs I can rent, then start a 2-hour Jupyter rental on one with at least 24GB of VRAM."

The agent calls `list_gpus`, picks a node, and calls `create_rental` with `hours: 2`. It then
polls `get_rental` for the Jupyter URL. Say "stop it" and it calls `destroy_rental`.

> "Rent a 4090 over SSH, run nvidia-smi on it, then stop it."

The agent makes a key with `ssh-keygen`, saves it with `add_ssh_key`, picks a node with
`ssh: true`, starts it with `type: "ssh"`, runs the command `get_rental` returns, and stops it.

> "Start ComfyUI on a GPU with 24 GB for an hour and give me the link."

The agent calls `list_templates`, picks a node whose `templates` has `comfyui`, starts it with
`template: "comfyui"` and `hours: 1`, and hands you `connection.app_url` from `get_rental` once the
app answers, a minute or two after the machine.

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
  `update_node`, `reclaim_spot_node`, `set_node_access`) tell the agent to confirm with you first;
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
