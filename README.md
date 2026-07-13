# ParalonCloud Rentals — MCP server

Rent GPUs from inside your AI agent. This is an [MCP](https://modelcontextprotocol.io)
server for the [ParalonCloud Rental API](https://paraloncloud.com/docs/rental-api): it lets
Claude Code, Claude Desktop, Cursor, or any MCP client browse GPUs, start a rental, get its
connection URL, and stop it — using natural language.

> One key for everything: the same `prlc_` key powers ParalonCloud's
> [OpenAI-compatible inference API](https://paraloncloud.com/docs/inference-api). Build an
> agent that calls a model **and** rents the GPU to run the heavy job.

## Tools

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_gpus` | List rentable GPUs with price, VRAM, compute capability, country | free |
| `get_balance` | Your credit balance | free |
| `create_rental` | Start a Jupyter rental (async → poll) | **spends credits** |
| `get_rental` | Status + connection URL once running | free |
| `list_rentals` | Your active rentals (`status: "all"` for history) | free |
| `destroy_rental` | Stop a rental and stop billing | — |

## Setup

### 1. Get a key with the rental scope

1. Create an API key in the [Console](https://paraloncloud.com/console).
2. Turn on the **GPU Rentals** scope for that key (rentals are opt-in).
3. Optionally set **Max rentals running at once** as a safety cap.

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

## Safety

- `create_rental` and `destroy_rental` change what you're billed — your MCP client will ask you
  to approve them (Claude Code/Desktop confirm tool calls by default). Keep that on.
- `create_rental` auto-generates an idempotency key, so a retried call never starts a second GPU.
- Pass `hours` so a rental auto-stops even if the agent forgets to.
- The key's `max_active_rentals` limit (set in the Console) caps concurrency regardless.

## Run locally (dev)

```bash
PARALON_API_KEY=prlc_your_key_here node server.js
```

## Links

- Rental API docs: https://paraloncloud.com/docs/rental-api
- Console (create keys): https://paraloncloud.com/console
- Inference API: https://paraloncloud.com/docs/inference-api

MIT
