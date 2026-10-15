// MCP server — `korb mcp`. Speaks the Model Context Protocol over stdio:
// JSON-RPC 2.0, one message per line. Hand-rolled to keep the CLI's
// zero-runtime-deps rule — the surface we implement is initialize /
// tools/list / tools/call / ping, which is all an MCP client needs to
// drive us.
//
// ABSOLUTE RULE: nothing on this path may write to stdout except the
// JSON-RPC frames themselves — stdout IS the wire. Diagnostics go to
// stderr, tool output goes inside the response content.
//
// Tools: list_failed · get_payload · replay · send_test.
// Write tools (replay, send_test) are gated on token scope from day one:
// locally via the credentials file / a one-time /api/me probe (the server
// re-enforces on every mutation anyway).

import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { api, type ApiInit } from "./client.js";
import { authToken, loadCredentials } from "./config.js";
import { collectNewEvents, type ListedEvent } from "./forward.js";
import { resolveSource } from "./testevent.js";
import type { SourceRow } from "./objects.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const MCP_SERVER_NAME = "korb";
/** Negotiate: echo the client's version when we know it, else our latest. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]!;

const DEFAULT_HOURS = 24;
const MAX_HOURS = 720; // 30d — the events API caps windows at 31d
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_BODY_DISPLAY = 64 * 1024;

export type McpApiFn = <T>(path: string, init?: ApiInit) => Promise<T>;

export interface McpDeps {
  api: McpApiFn;
  canWrite: () => Promise<boolean>;
  now: () => number;
}

// --- token scope (write gate) ---

let probedScope: boolean | null = null;

/** The credentials file records the scope minted with its token; a
 *  KORB_TOKEN env override replaces the token, so the file's scope can
 *  lie — in that case (or with no file) ask the server once via /api/me.
 *  Probe errors propagate to the caller as tool errors. */
async function resolveCanWrite(): Promise<boolean> {
  if (!process.env.KORB_TOKEN) {
    const creds = loadCredentials();
    if (creds) return creds.can_write === true;
  }
  if (probedScope === null) {
    const me = await api<{ can_write?: boolean }>("/api/me");
    probedScope = me.can_write === true;
  }
  return probedScope;
}

// --- small arg validators (throw = tool error) ---

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${key}" must be a non-empty string`);
  return v.trim();
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${key}" must be a non-empty string`);
  return v.trim();
}

function optNumber(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  dflt: number,
): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be a number`);
  if (n < min || n > max) throw new Error(`"${key}" must be between ${min} and ${max}`);
  return Math.floor(n);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

// --- tool implementations ---

interface EventDetail {
  id: string;
  status: string;
  event_type: string | null;
  received_at: number;
  size: number;
  redacted: boolean;
  headers: Record<string, string> | null;
  body: string | null;
  content_type: string | null;
}

function toolListFailed(d: McpDeps) {
  return async (raw: Record<string, unknown>): Promise<string> => {
    const hours = optNumber(raw, "hours", 1, MAX_HOURS, DEFAULT_HOURS);
    const limit = optNumber(raw, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
    const sourceRef = optString(raw, "source");

    // a name is friendlier than an id for a human-driven agent — resolve it
    let sourceId: string | undefined;
    if (sourceRef) {
      const { sources } = await d.api<{ sources: SourceRow[] }>("/api/sources");
      sourceId = resolveSource(sources, sourceRef).id;
    }

    const since = d.now() - hours * 3_600_000;
    const events = await collectNewEvents(since, (q) => {
      const p = new URLSearchParams({ since: String(q.since) });
      if (q.until !== undefined) p.set("until", String(q.until));
      if (sourceId) p.set("source", sourceId);
      return d.api<{ events: ListedEvent[] }>(`/api/events?${p}`);
    });

    // the CLI is zero-dep by convention — these two strings are the
    // failure set on the wire contract
    const rows = events
      .filter((e) => e.status === "failed" || e.status === "partial")
      .sort((a, b) => b.received_at - a.received_at)
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        received_at: iso(e.received_at),
        type: e.event_type,
        status: e.status,
        delivered: e.delivered_count,
        failed: e.failed_count,
        size_bytes: e.size,
      }));

    if (rows.length === 0) return `no failed or partially failed events in the last ${hours}h`;
    return `${rows.length} event(s) with failed deliveries in the last ${hours}h (newest first; statuses: failed = all deliveries failed, partial = some succeeded):\n${JSON.stringify(rows, null, 2)}`;
  };
}

function toolGetPayload(d: McpDeps) {
  return async (raw: Record<string, unknown>): Promise<string> => {
    const id = reqString(raw, "event_id");
    const det = await d.api<EventDetail>(`/api/events/${encodeURIComponent(id)}`);
    const head =
      `id: ${det.id}\nreceived: ${iso(det.received_at)}\nstatus: ${det.status}\n` +
      `type: ${det.event_type ?? "-"}\nsize: ${det.size}B\n`;
    if (det.redacted || det.body === null) {
      return head + "payload: [redacted — turn OFF Settings → “Redact payloads” to inspect bodies]";
    }
    let body = det.body;
    if ((det.content_type ?? "").includes("json")) {
      try {
        body = JSON.stringify(JSON.parse(det.body));
      } catch {
        /* not actually json — raw is fine */
      }
    }
    if (body.length > MAX_BODY_DISPLAY) {
      body = body.slice(0, MAX_BODY_DISPLAY) + `\n[truncated — ${det.size}B total]`;
    }
    return `${head}headers:\n${JSON.stringify(det.headers ?? {}, null, 2)}\nbody:\n${body}`;
  };
}

function toolReplay(d: McpDeps) {
  return async (raw: Record<string, unknown>): Promise<string> => {
    const id = reqString(raw, "event_id");
    const out = await d.api<{ queued: number }>(`/api/events/${encodeURIComponent(id)}/replay`, {
      method: "POST",
      body: {},
    });
    return `replayed — ${out.queued} delivery(ies) queued (same event id; receivers see the korb-replay header)`;
  };
}

function toolSendTest(d: McpDeps) {
  return async (raw: Record<string, unknown>): Promise<string> => {
    const ref = reqString(raw, "source");
    const { sources } = await d.api<{ sources: SourceRow[] }>("/api/sources");
    const src = resolveSource(sources, ref);
    const out = await d.api<{ id: string; queued_to: number }>(
      `/api/sources/${src.id}/test`,
      { method: "POST", body: {} },
    );
    return (
      `sent — event ${out.id} through "${src.name}" (${src.preset})` +
      (out.queued_to > 0 ? ` -> ${out.queued_to} destination(s)` : " (no routes — inbox only)")
    );
  };
}

// --- tool registry ---

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** write tools are scope-gated (read-only tokens get a clear refusal) */
  write: boolean;
  run: (args: Record<string, unknown>) => Promise<string>;
}

function toolDefs(d: McpDeps): ToolDef[] {
  return [
    {
      name: "list_failed",
      description:
        "List webhook events whose deliveries failed or partially failed, newest first. " +
        "Use this first when a webhook consumer is misbehaving; follow up with get_payload " +
        "to inspect what was sent and replay to redeliver once fixed.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: `lookback window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
          source: { type: "string", description: "source id or name (default: all sources)" },
          limit: { type: "number", description: `max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
        },
        additionalProperties: false,
      },
      write: false,
      run: toolListFailed(d),
    },
    {
      name: "get_payload",
      description:
        "Fetch one stored webhook event: headers and full body exactly as received. " +
        "The id comes from list_failed (or the dashboard inbox).",
      inputSchema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "event id from list_failed / korb events" },
        },
        required: ["event_id"],
        additionalProperties: false,
      },
      write: false,
      run: toolGetPayload(d),
    },
    {
      name: "replay",
      description:
        "Redeliver one stored event to its routed destinations (same event id, korb-replay " +
        "header set, receivers' own dedupe applies). Requires a read+write token.",
      inputSchema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "event id to redeliver" },
        },
        required: ["event_id"],
        additionalProperties: false,
      },
      write: true,
      run: toolReplay(d),
    },
    {
      name: "send_test",
      description:
        "Fire a preset's test event through a source (e.g. a Stripe checkout.session.completed) — " +
        "a REAL event in the REAL lane, useful to verify a fix end-to-end. Requires a read+write token.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "source id or name (unique prefix works)" },
        },
        required: ["source"],
        additionalProperties: false,
      },
      write: true,
      run: toolSendTest(d),
    },
  ];
}

// --- JSON-RPC plumbing ---

type WireMsg = Record<string, unknown>;

/** A tools/call RESULT (tool ran; isError marks the tool-level failure —
 *  distinct from protocol errors, which are JSON-RPC error objects). */
interface CallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function reply(id: unknown, result: unknown): WireMsg {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): WireMsg {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultText(text: string): CallResult {
  return { content: [{ type: "text", text }] };
}

function resultError(text: string): CallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Raised for protocol-level problems (unknown tool, bad envelope) —
 *  becomes a JSON-RPC error with the caller's id. */
class ProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** Build an MCP server. deps are injectable for tests; defaults wire the
 *  real api() client and the scope probe. handleMessage returns the
 *  response message, or null for notifications / unanswerable garbage. */
export function createMcpServer(deps: Partial<McpDeps> = {}) {
  const d: McpDeps = {
    api: api as McpApiFn,
    canWrite: resolveCanWrite,
    now: () => Date.now(),
    ...deps,
  };
  const tools = toolDefs(d);

  async function callTool(name: unknown, args: unknown): Promise<CallResult> {
    if (typeof name !== "string") throw new ProtocolError(-32602, "tool name required");
    const def = tools.find((t) => t.name === name);
    if (!def) throw new ProtocolError(-32602, `unknown tool: ${name}`);
    if (args === undefined || args === null) args = {};
    if (typeof args !== "object" || Array.isArray(args)) {
      return resultError("tool arguments must be a JSON object");
    }
    try {
      if (def.write && !(await d.canWrite())) {
        return resultError(
          "this token is read-only — create a read+write token in dashboard → Settings → API tokens " +
            "(or `korb login` and approve write access)",
        );
      }
      return resultText(await def.run(args as Record<string, unknown>));
    } catch (e) {
      return resultError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleMessage(msg: unknown): Promise<WireMsg | null> {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
    const m = msg as WireMsg;
    if (!("id" in m)) return null; // notification (notifications/initialized …) — nothing to answer
    const { id } = m;
    const method = typeof m.method === "string" ? m.method : null;
    if (!method) return rpcError(id, -32600, "invalid request: missing method");

    switch (method) {
      case "initialize": {
        const params = (m.params ?? {}) as WireMsg;
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: pkg.version },
          instructions:
            "korb is a receive-side webhook gateway (Stripe/Shopify/GitHub → your services). " +
            "Typical flow: list_failed to find undelivered events, get_payload to inspect one, " +
            "replay to redeliver after fixing the consumer, send_test to verify end-to-end.",
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !t.write },
          })),
        });
      case "tools/call": {
        const params = (m.params ?? {}) as WireMsg;
        try {
          return reply(id, await callTool(params.name, params.arguments));
        } catch (e) {
          if (e instanceof ProtocolError) return rpcError(id, e.code, e.message);
          throw e;
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  return { handleMessage, tools };
}

/** The stdio loop. One JSON-RPC message per line in, one response line out.
 *  Never touches stdout with anything else; exits 0 when stdin closes. */
export async function runMcpStdio(): Promise<number> {
  if (!authToken()) {
    process.stderr.write(
      "korb mcp: no token — run `korb login` or set KORB_TOKEN (handshake will still answer)\n",
    );
  }
  const server = createMcpServer();
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      process.stderr.write("korb mcp: skipping non-JSON line\n");
      continue;
    }
    try {
      const resp = await server.handleMessage(msg);
      if (resp !== null) process.stdout.write(JSON.stringify(resp) + "\n");
    } catch (e) {
      process.stderr.write(`korb mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return 0;
}
