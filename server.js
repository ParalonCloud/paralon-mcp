#!/usr/bin/env node
// MCP server for the ParalonCloud Rental API.
//
// Exposes the rental REST API (https://paraloncloud.com/api/v1) as MCP tools so
// an AI agent can browse GPUs, rent one, poll it for a connection URL, and stop
// it — from inside Claude Code / Claude Desktop / Cursor / any MCP client.
//
// Config lives in the MCP client, not here. The server reads two env vars:
//   PARALON_API_KEY   (required)  a prlc_ key WITH the 'rental' scope enabled
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
          "Set PARALON_API_KEY in your MCP client config — a prlc_ key with the 'rental' scope enabled (create one at https://paraloncloud.com/console).",
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
  const payload = note ? { note, ...result.data } : result.data;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: !result.ok,
  };
}

const server = new Server(
  { name: "paraloncloud-rentals", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "list_gpus",
    description:
      "List GPU nodes available to rent right now, with price per hour, GPU model, VRAM, CUDA compute capability, and country. Rent by the returned node_id. Read-only, no cost. For modern LLM work prefer compute_cap >= 8.9 (FP8).",
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
          enum: ["jupyter"],
          description: "Environment to start. Only 'jupyter' is supported.",
        },
        hours: {
          type: "integer",
          minimum: 1,
          maximum: 720,
          description: "Optional auto-stop cap: the rental stops itself after this many whole hours. Omit (the default) for an open-ended rental that runs until stopped with destroy_rental.",
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
      "Get one rental's status and connection details (Jupyter URL + token). After create_rental, call this to get the URL. It WAITS internally (up to ~24s) for the rental to finish coming up and returns as soon as it's ready — so you usually only need ONE call, at most two. Do NOT call it repeatedly in a tight loop. Provisioning plus the secure tunnel take ~20-40 seconds total; the URL is ready when connection_pending is false. Read-only.",
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "list_gpus":
      return reply(await api("GET", "/gpus"));

    case "get_balance":
      return reply(await api("GET", "/balance"));

    case "create_rental": {
      if (!args.node_id) {
        return reply({ ok: false, data: { error: "invalid_request", message: "node_id is required (see list_gpus)." } });
      }
      const body = { node_id: args.node_id, type: args.type || "jupyter" };
      if (args.hours != null) body.hours = args.hours;
      if (args.name) body.name = args.name;
      const result = await api("POST", "/rentals", {
        body,
        headers: { "Idempotency-Key": randomUUID() },
      });
      return reply(
        result,
        result.ok
          ? "Rental is provisioning. Call get_rental with this rental_id until status is 'running' to get the connection URL."
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
      let result = await api("GET", path);
      let waited = 0;
      while (result.ok && result.data && result.data.connection_pending === true && waited < 24000) {
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

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Log to stderr only — stdout is the MCP protocol channel.
console.error(
  `paraloncloud-rentals MCP server running (base: ${BASE_URL}, key: ${API_KEY ? "set" : "MISSING — set PARALON_API_KEY"})`
);
