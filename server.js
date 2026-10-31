#!/usr/bin/env node
// MCP server for the ParalonCloud Rental API and Provider API.
//
// Exposes the REST API (https://paraloncloud.com/api/v1) as MCP tools so an AI
// agent can browse GPUs, rent one with JupyterLab or SSH, poll it for the
// connection, and stop it; register the SSH public keys an SSH rental logs in
// with;
// and, for a GPU provider, manage their own nodes: list them with live GPU
// load and temperature, add one and get its install command, take it off the
// market and back, set its price, reclaim a spot node, and read earnings.
//
// Config lives in the MCP client, not here. The server reads two env vars:
//   PARALON_API_KEY   (required)  a prlc_ key: the 'rental' scope for the
//                                 rental tools, the 'nodes' scope for the
//                                 provider tools (both can be on one key)
//   PARALON_BASE_URL  (optional)  defaults to https://paraloncloud.com/api/v1
//
// Safety notes baked into the tool descriptions: create_rental and
// destroy_rental move money (per-minute billing), so the client should confirm
// them with the user. Renting is asynchronous — create returns a pending
// rental_id; call get_rental until status is "running" for the connection URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const BASE_URL = (process.env.PARALON_BASE_URL || "https://paraloncloud.com/api/v1").replace(/\/$/, "");
const API_KEY = process.env.PARALON_API_KEY || "";

// One thin REST helper. Returns { ok, status, data } — never throws on HTTP
// errors, so a tool can surface the API's own error message to the agent.
async function api(method, path, { body, headers } = {}) {
  if (!API_KEY) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "missing_api_key",
        message:
          "Set PARALON_API_KEY in your MCP client config: a prlc_ key with the 'rental' scope for rentals, or the 'nodes' scope (My nodes) for your own nodes (create one at https://paraloncloud.com/console).",
      },
    };
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "network_error", message: String(e) } };
  }
}

// Wrap a result as an MCP text response. Non-OK responses are flagged isError
// so the agent knows the call failed, with the API's message included.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reply(result, note) {
  let data = result.data;
  // A key without the scope: say how to fix it, not just "forbidden".
  if (!result.ok && data && data.error === "insufficient_scope") {
    data = {
      ...data,
      how_to_fix:
        "In https://paraloncloud.com/console → API keys, open this key's settings and turn on the scope it names: 'GPU rentals' for the rental tools, 'My nodes' for the node and earnings tools.",
    };
  }
  const payload = note ? { note, ...data } : data;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: !result.ok,
  };
}

const server = new Server(
  { name: "paraloncloud", version: "1.5.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "list_gpus",
    description:
      "List GPU nodes available to rent right now, with price per hour, GPU model, VRAM, CUDA compute capability, and country. Rent by the returned node_id. reserved_for_you: true marks a node its provider keeps for this key's person or organization: such nodes come first and nobody else sees them. Read-only, no cost. For modern LLM work prefer compute_cap >= 8.9 (FP8). spot: true marks a spot node: cheaper (list_price_per_hour is the on-demand price), but its provider can take it back with two minutes' notice, so avoid it for long unattended jobs. restricted_internet: true means the node's own network cannot reach the services in unreachable_services (e.g. GitHub, Hugging Face, PyPI, Docker Hub), so git clone, pip install and model or image downloads fail there; prefer a node where it is false when the job downloads anything (null means not checked yet). ssh: true means create_rental can start it with type 'ssh'. templates lists the apps create_rental can install on that node (e.g. [\"comfyui\"]); see list_templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_templates",
    description:
      "List the apps a rental can start with, installed and running and opened in the browser by its own link: today ComfyUI (node-based image and video generation: Flux, SDXL, Wan). Each has a slug for create_rental's template, the version a rental gets (tested and pinned), and what a machine needs (min_vram_gb per GPU, min_disk_gb). Pick a node whose templates in list_gpus contains the slug. Read-only, no cost. Use it when the user wants to generate images or video, or names one of these apps.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_balance",
    description:
      "Get the account's credit balance (rentals are billed per minute against it). Read-only, no cost.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_rental",
    description:
      "Start renting a GPU. SPENDS CREDITS (per-minute billing) — confirm with the user before calling. Asynchronous: returns a rental_id with status 'pending'. Provisioning + the secure tunnel take ~20-40 seconds. After creating, call get_rental ONCE to fetch the connection URL — it waits internally for startup and returns when ready, so do NOT poll it in a tight loop. DURATION: the rental is open-ended by default (runs until the user stops it with destroy_rental) — use open-ended as the default. When starting one, briefly tell the user it's open-ended and bills per minute until stopped, and that they can set an 'hours' auto-stop cap instead if they prefer; only pass 'hours' when the user asks for a time limit. An idempotency key is generated automatically so accidental repeats don't start a second GPU.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node UUID from list_gpus." },
        type: {
          type: "string",
          enum: ["jupyter", "ssh"],
          description: "How to reach the machine. 'jupyter' (default): JupyterLab in the browser, get_rental returns a URL with its token. 'ssh': a root shell over SSH, for running commands, scp/rsync and VS Code Remote-SSH; only on a node where list_gpus says ssh: true, and it needs an SSH public key saved first (list_ssh_keys / add_ssh_key), since every saved key is installed on the machine. Prefer 'ssh' when you will run commands on the machine yourself.",
        },
        hours: {
          type: "integer",
          minimum: 1,
          maximum: 720,
          description: "Optional auto-stop cap: the rental stops itself after this many whole hours. Omit (the default) for an open-ended rental that runs until stopped with destroy_rental.",
        },
        template: {
          type: "string",
          description: "Optional app to install and start on the machine, by slug from list_templates (e.g. 'comfyui'). Only on a node whose templates in list_gpus contains it. The rental is still JupyterLab or SSH as type says, at the same price; the app comes up a minute or two after the machine answers, and get_rental then returns connection.app_url (its own link with a token). It starts empty: the user downloads models from inside the app.",
        },
        name: { type: "string", description: "Optional label for the rental." },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_rental",
    description:
      "Get one rental's status and connection details: for a JupyterLab rental connection.access_url (URL with its token), for an SSH rental connection.ssh_command (run it from the computer holding the private key; it needs cloudflared installed, and -i <private key> when the key is not in ~/.ssh). A rental started with a template also has app (name, version, state installing / starting / ready / failed, step) and, once the app answers, connection.app_url: the link that opens it, with its token; treat it like a password. state failed means the app did not start while the machine runs and bills: say so and offer to stop it. After create_rental, call this to get the URL. It WAITS internally (up to ~24s) for the rental to finish coming up and returns as soon as it's ready — so you usually only need ONE call, at most two. Do NOT call it repeatedly in a tight loop. Provisioning plus the secure tunnel take ~20-40 seconds total; the URL is ready when connection_pending is false. Read-only.",
    inputSchema: {
      type: "object",
      properties: { rental_id: { type: "string" } },
      required: ["rental_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_rentals",
    description:
      "List the account's rentals. By default only active ones (what's running and billing). Pass status='all' for full history. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "all"], description: "Default: active." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "destroy_rental",
    description:
      "Stop a rental — stops the GPU and STOPS BILLING. This is the money brake; safe to call twice. Confirm with the user unless they clearly asked to stop it.",
    inputSchema: {
      type: "object",
      properties: { rental_id: { type: "string" } },
      required: ["rental_id"],
      additionalProperties: false,
    },
  },

  {
    name: "list_ssh_keys",
    description:
      "List the SSH public keys saved for this API key's person: every one of them is installed on each SSH rental they start. Read-only, no cost.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_ssh_key",
    description:
      "Save an SSH public key so SSH rentals accept it (the key also shows on the account's SSH keys page). Pass the PUBLIC key line, e.g. the contents of ~/.ssh/id_ed25519.pub; never a private key. To make one: ssh-keygen -t ed25519 -N '' -f ~/.ssh/paralon_ed25519, then add the .pub file's line and connect with -i ~/.ssh/paralon_ed25519. A key added after a rental started is not on that rental. No cost.",
    inputSchema: {
      type: "object",
      properties: {
        public_key: { type: "string", description: "One OpenSSH public key line: 'ssh-ed25519 AAAA… comment' (ed25519, ecdsa or rsa ≥2048)." },
        name: { type: "string", description: "Optional label, e.g. 'laptop' or 'claude-agent'. Defaults to the key's comment." },
      },
      required: ["public_key"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_ssh_key",
    description:
      "Delete a saved SSH public key by its id (from list_ssh_keys). New SSH rentals no longer accept it; a rental already running keeps it until it stops. Confirm with the user unless they asked for it.",
    inputSchema: {
      type: "object",
      properties: { key_id: { type: "string" } },
      required: ["key_id"],
      additionalProperties: false,
    },
  },

  // ---- Provider tools: the account's own nodes (key needs the 'nodes' scope)
  {
    name: "list_my_nodes",
    description:
      "PROVIDER: list the GPU nodes this account provides (needs a key with the 'nodes' scope). For each node: state (available, rented, paused, not_verified, not_ready, offline), GPUs and VRAM, price (default, allowed min/max, custom, what a renter pays), verification, reputation, the current rental (never the renter), and live metrics from the last minute: per-GPU load %, temperature °C, power W and VRAM, plus host CPU and memory. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_my_node",
    description: "PROVIDER: one of the account's nodes, same fields as list_my_nodes (state, price, rental, live GPU metrics). Read-only.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string", description: "Node UUID from list_my_nodes." } },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_node",
    description:
      "PROVIDER: add a new node to the account and get the docker command that installs the agent on the machine. Confirm the name and type with the user first. The returned command contains the node's secret token: show it only to the user, never paste it anywhere public. The node comes online once the command runs on the machine, then goes through the GPU check. At most 20 nodes an hour per key.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A label for the node, up to 100 characters." },
        type: { type: "string", enum: ["gpu", "cpu", "mac"], description: "Default gpu." },
        os: { type: "string", enum: ["linux", "windows"], description: "Operating system of the machine. Default linux." },
        available: { type: "boolean", description: "On the market as soon as it is ready. Default true." },
        spot: { type: "boolean", description: "A spot node: discounted and reclaimable (GPU only). Default false." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_node_install_command",
    description:
      "PROVIDER: the docker command that installs the agent for an existing node (to reinstall or move it). It contains the node's secret token: show it only to the user. Read-only.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_node_available",
    description:
      "PROVIDER: take a node off the market (available=false) or put it back (available=true). Off stops new rentals at once; a rental already running goes on to its end. Use it when the owner needs the machine or it is rented on another marketplace. Confirm with the user unless they asked for exactly this.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        available: { type: "boolean" },
      },
      required: ["node_id", "available"],
      additionalProperties: false,
    },
  },
  {
    name: "set_node_price",
    description:
      "PROVIDER: set a node's price in US dollars per hour for the whole node (what the renter pays; the provider gets it minus the platform fee), or null to go back to the platform default. Must be within the node's price.min and price.max (50% to 300% of the default; see get_my_node). A rental already running keeps its price. Not possible on a spot node. Confirm the new price with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        price_per_hour: { type: ["number", "null"], description: "USD per hour, or null for the default price." },
      },
      required: ["node_id", "price_per_hour"],
      additionalProperties: false,
    },
  },
  {
    name: "update_node",
    description:
      "PROVIDER: change several things on a node at once: name, spot (true/false; refused while the node is rented, and turning spot on clears a custom price), available, price_per_hour (USD per hour or null). Send only what changes. Confirm changes with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        name: { type: "string" },
        spot: { type: "boolean" },
        available: { type: "boolean" },
        price_per_hour: { type: ["number", "null"] },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "reclaim_spot_node",
    description:
      "PROVIDER: take a spot node back for the owner's own use (\"In use\"): rentals and inference go off, and a spot rental running on it STOPS TWO MINUTES LATER (the renter is told). Only for spot nodes. Always confirm with the user first. Put the node back afterwards with set_node_available(true).",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_node_access",
    description:
      "PROVIDER: who can rent a node. An empty list (private: false) means everyone; otherwise only the people (email), email domains and organizations listed see the node and can rent it. Read-only.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_node_access",
    description:
      "PROVIDER: set who can rent a node, replacing the whole list. Each entry is {kind: \"email\", value: \"ana@company.com\"}, {kind: \"domain\", value: \"company.com\"} or {kind: \"org\", value: \"<organization name or ID>\"}. A non-empty list makes the node PRIVATE: only those renters see it and can rent it, and ParalonCloud places no inference or other work on it, so it earns from their rentals only. [] opens it to everyone again. Call get_node_access first to keep existing entries. Always confirm with the user first. People and organizations added are told by email.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        entries: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["email", "domain", "org"] },
              value: { type: "string" },
            },
            required: ["kind", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["node_id", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: "get_earnings",
    description:
      "PROVIDER: the account's earnings in USD by UTC day for the last `days` days (default 30, max 366): rentals per node and inference for the account, after the platform fee; the total; the balance that can be withdrawn now; and what rentals still running have billed so far. Payouts themselves are not available through the API. Read-only.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 366 } },
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "list_gpus":
      return reply(await api("GET", "/gpus"));

    case "get_balance":
      return reply(await api("GET", "/balance"));

    case "list_templates":
      return reply(await api("GET", "/templates"));

    case "create_rental": {
      if (!args.node_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "node_id is required (see list_gpus)." } });
      }
      const body = { node_id: args.node_id, type: args.type || "jupyter" };
      if (args.hours != null) body.hours = args.hours;
      if (args.name) body.name = args.name;
      if (args.template) body.template = args.template;
      const result = await api("POST", "/rentals", {
        body,
        headers: { "Idempotency-Key": randomUUID() },
      });
      return reply(
        result,
        result.ok
          ? (body.template
              ? `Rental is provisioning with ${body.template}. Call get_rental with this rental_id: the machine answers first, the app a minute or two later; connection.app_url is its link.`
              : body.type === "ssh"
              ? "Rental is provisioning. Call get_rental with this rental_id until status is 'running' to get the SSH command."
              : "Rental is provisioning. Call get_rental with this rental_id until status is 'running' to get the connection URL.")
          : undefined
      );
    }

    case "get_rental": {
      if (!args.rental_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "rental_id is required." } });
      }
      const path = `/rentals/${encodeURIComponent(args.rental_id)}`;
      // Provisioning + the secure tunnel take ~20-40s. Instead of returning a
      // "pending" that makes the agent hammer this tool, wait here: poll every
      // 3s for up to ~24s and return as soon as the connection is ready (or the
      // budget runs out). One or two calls cover the whole startup.
      // A template's app comes up after the machine: wait for it the same way.
      const appPending = (d) => !!d?.app && d.status === "running" && (d.app.state === "installing" || d.app.state === "starting");
      let result = await api("GET", path);
      let waited = 0;
      while (result.ok && result.data && (result.data.connection_pending === true || appPending(result.data)) && waited < 24000) {
        await sleep(3000);
        waited += 3000;
        result = await api("GET", path);
      }
      return reply(result);
    }

    case "list_rentals": {
      const q = args.status === "all" ? "?status=all" : "";
      return reply(await api("GET", `/rentals${q}`));
    }

    case "destroy_rental": {
      if (!args.rental_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "rental_id is required." } });
      }
      return reply(await api("DELETE", `/rentals/${encodeURIComponent(args.rental_id)}`));
    }

    case "list_ssh_keys":
      return reply(await api("GET", "/ssh-keys"));

    case "add_ssh_key": {
      if (!args.public_key) {
        return reply({ ok: false, data: { error: "invalid_request", message: "public_key is required: the line of a .pub file." } });
      }
      if (/PRIVATE KEY/.test(args.public_key)) {
        return reply({ ok: false, data: { error: "invalid_request", message: "That is a private key. Never send it; pass the public key (the .pub file)." } });
      }
      const body = { public_key: args.public_key };
      if (args.name) body.name = args.name;
      return reply(await api("POST", "/ssh-keys", { body }));
    }

    case "delete_ssh_key": {
      if (!args.key_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "key_id is required (see list_ssh_keys)." } });
      }
      return reply(await api("DELETE", `/ssh-keys/${encodeURIComponent(args.key_id)}`));
    }

    // ---- Provider tools
    case "list_my_nodes":
      return reply(await api("GET", "/nodes"));

    case "get_my_node":
    case "get_node_install_command":
    case "reclaim_spot_node": {
      if (!args.node_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "node_id is required (see list_my_nodes)." } });
      }
      const id = encodeURIComponent(args.node_id);
      if (name === "get_my_node") return reply(await api("GET", `/nodes/${id}`));
      if (name === "get_node_install_command") return reply(await api("GET", `/nodes/${id}/command`));
      const result = await api("POST", `/nodes/${id}/reclaim`);
      return reply(
        result,
        result.ok ? "The node is in use: no new rentals or inference. Put it back with set_node_available(available=true)." : undefined
      );
    }

    case "add_node": {
      if (!args.name) {
        return reply({ ok: false, data: { error: "invalid_request", message: "name is required." } });
      }
      const body = { name: args.name };
      for (const k of ["type", "os", "available", "spot"]) if (args[k] !== undefined) body[k] = args[k];
      const result = await api("POST", "/nodes", { body });
      return reply(
        result,
        result.ok
          ? "Node added. Give the user docker_command to run on the machine (it holds the node's secret token). The node shows online once it runs, then goes through the GPU check."
          : undefined
      );
    }

    case "set_node_available":
    case "set_node_price":
    case "update_node": {
      if (!args.node_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "node_id is required (see list_my_nodes)." } });
      }
      const body = {};
      for (const k of ["name", "spot", "available", "price_per_hour"]) if (args[k] !== undefined) body[k] = args[k];
      if (name === "set_node_available" && typeof args.available !== "boolean") {
        return reply({ ok: false, data: { error: "invalid_request", message: "available must be true or false." } });
      }
      if (name === "set_node_price" && !("price_per_hour" in args)) {
        return reply({ ok: false, data: { error: "invalid_request", message: "price_per_hour is required (a number in USD, or null for the default)." } });
      }
      if (Object.keys(body).length === 0) {
        return reply({ ok: false, data: { error: "invalid_request", message: "Nothing to change: send name, spot, available or price_per_hour." } });
      }
      return reply(await api("PATCH", `/nodes/${encodeURIComponent(args.node_id)}`, { body }));
    }

    case "get_node_access":
    case "set_node_access": {
      if (!args.node_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "node_id is required (see list_my_nodes)." } });
      }
      const path = `/nodes/${encodeURIComponent(args.node_id)}/access`;
      if (name === "get_node_access") return reply(await api("GET", path));
      if (!Array.isArray(args.entries)) {
        return reply({ ok: false, data: { error: "invalid_request", message: "entries is required: the whole list, [] for everyone." } });
      }
      const result = await api("PUT", path, { body: { entries: args.entries } });
      return reply(
        result,
        result.ok
          ? result.data && result.data.private
            ? "The node is private: only the listed renters see and rent it, and no ParalonCloud workloads run on it."
            : "The node is open to everyone again."
          : undefined
      );
    }

    case "get_earnings": {
      const q = args.days ? `?days=${encodeURIComponent(args.days)}` : "";
      return reply(await api("GET", `/earnings${q}`));
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Log to stderr only — stdout is the MCP protocol channel.
console.error(
  `ParalonCloud MCP server running (base: ${BASE_URL}, key: ${API_KEY ? "set" : "MISSING — set PARALON_API_KEY"})`
);
