// MCP server tests — the pure JSON-RPC core with injected deps (no network,
// no stdio). The stdio loop itself is a thin wrapper over handleMessage.

import { describe, it, expect } from "vitest";
import { createMcpServer, type McpApiFn } from "../src/mcp";
import type { ListedEvent } from "../src/forward";
import type { SourceRow } from "../src/objects";

interface Call {
  path: string;
  init?: { method?: string; body?: unknown };
}

/** Route-table api fake: exact path match (query strings stripped via
 *  prefix matching on the path before "?"). Records every call. */
function fakeApi(routes: Record<string, unknown>): { fn: McpApiFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    const bare = path.split("?")[0]!;
    if (bare in routes) {
      const v = routes[bare]!;
      return typeof v === "function" ? v(init) : v;
    }
    throw new Error(`unexpected api call: ${path}`);
  }) as unknown as McpApiFn;
  return { fn, calls };
}

const NOW = 1_700_000_000_000;

function ev(id: string, extra: Partial<ListedEvent> = {}): ListedEvent {
  return {
    id,
    source_id: "s1",
    status: "delivered",
    event_type: null,
    received_at: NOW - 1000,
    size: 10,
    delivered_count: 1,
    failed_count: 0,
    ...extra,
  };
}

function src(id: string, name: string, preset = "generic"): SourceRow {
  return {
    id,
    name,
    preset,
    status: "active",
    created_at: NOW - 10_000,
    last_event_at: NOW,
    secret_set: 0,
  };
}

const WRITE = () => Promise.resolve(true);
const READONLY = () => Promise.resolve(false);

async function callTool(
  server: ReturnType<typeof createMcpServer>,
  name: string,
  args: unknown,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean } | null> {
  const r = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return (r as { result?: unknown })?.result as { content: { type: string; text: string }[]; isError?: boolean };
}

describe("initialize / protocol plumbing", () => {
  it("echoes a supported protocol version", async () => {
    const s = createMcpServer();
    const r = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }))!;
    expect((r.result as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
    expect((r.result as { serverInfo: { name: string } }).serverInfo.name).toBe("korb");
  });

  it("falls back to latest for an unknown version", async () => {
    const s = createMcpServer();
    const r = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    }))!;
    expect((r.result as Record<string, unknown>).protocolVersion).toBe("2025-06-18");
  });

  it("notifications get no response; unknown methods get -32601; ping answers {}", async () => {
    const s = createMcpServer();
    expect(await s.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const bad = (await s.handleMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" })) as {
      error: { code: number };
    };
    expect(bad.error.code).toBe(-32601);
    const pong = (await s.handleMessage({ jsonrpc: "2.0", id: 8, method: "ping" })) as { result: unknown };
    expect(pong.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("exposes the four tools with schemas + read/write hints", async () => {
    const s = createMcpServer();
    const r = (await s.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }))!;
    const tools = (r.result as { tools: unknown[] }).tools as {
      name: string;
      inputSchema: { required?: string[] };
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual(["list_failed", "get_payload", "replay", "send_test"]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("get_payload")!.inputSchema.required).toEqual(["event_id"]);
    expect(byName.get("replay")!.inputSchema.required).toEqual(["event_id"]);
    expect(byName.get("send_test")!.inputSchema.required).toEqual(["source"]);
    expect(byName.get("list_failed")!.annotations.readOnlyHint).toBe(true);
    expect(byName.get("get_payload")!.annotations.readOnlyHint).toBe(true);
    expect(byName.get("replay")!.annotations.readOnlyHint).toBe(false);
  });
});

describe("list_failed", () => {
  it("returns failed+partial only, newest first, respects limit", async () => {
    let n = 0;
    const pages = [
      { events: [ev("d1"), ev("f1", { status: "failed", received_at: NOW - 5000 }), ev("p1", { status: "partial", received_at: NOW - 2000 })] },
      { events: [] },
    ];
    const { fn } = fakeApi({
      "/api/events": () => pages[Math.min(n++, pages.length - 1)]!,
    });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "list_failed", {});
    expect(r!.isError).toBeUndefined();
    const text = r!.content[0]!.text;
    expect(text).toContain("2 event(s)");
    expect(text).toContain('"id": "p1"');
    expect(text).toContain('"id": "f1"');
    expect(text).not.toContain('"id": "d1"'); // delivered never listed
  });

  it("limit slices oldest out", async () => {
    let n = 0;
    const pages = [
      { events: [ev("f_old", { status: "failed", received_at: NOW - 9000 }), ev("f_new", { status: "failed", received_at: NOW - 1000 })] },
      { events: [] },
    ];
    const { fn } = fakeApi({ "/api/events": () => pages[Math.min(n++, 1)]! });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "list_failed", { limit: 1 });
    expect(r!.content[0]!.text).toContain("f_new");
    expect(r!.content[0]!.text).not.toContain("f_old");
  });

  it("resolves source NAME to id via /api/sources", async () => {
    let n = 0;
    const pages = [{ events: [ev("f1", { status: "failed" })] }, { events: [] }];
    const { fn, calls } = fakeApi({
      "/api/sources": { sources: [src("src_1", "stripe-main", "stripe")] },
      "/api/events": () => pages[Math.min(n++, 1)]!,
    });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    await callTool(s, "list_failed", { source: "stripe-main" });
    const evCall = calls.find((c) => c.path.startsWith("/api/events?"))!;
    expect(evCall.path).toContain("source=src_1");
  });

  it("empty result says so plainly", async () => {
    const { fn } = fakeApi({ "/api/events": { events: [] } });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "list_failed", {});
    expect(r!.content[0]!.text).toContain("no failed or partially failed events");
  });

  it("rejects out-of-range hours", async () => {
    const s = createMcpServer({ canWrite: WRITE });
    const r = await callTool(s, "list_failed", { hours: 0 });
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain('"hours"');
  });
});

describe("get_payload", () => {
  const det = {
    id: "e1",
    status: "failed",
    event_type: "checkout.session.completed",
    received_at: NOW,
    size: 13,
    redacted: false,
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    content_type: "application/json",
  };

  it("returns headers + body", async () => {
    const { fn } = fakeApi({ "/api/events/e1": det });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "get_payload", { event_id: "e1" });
    const t = r!.content[0]!.text;
    expect(t).toContain("checkout.session.completed");
    expect(t).toContain('"content-type"');
    expect(t).toContain('{"a":1}');
  });

  it("redacted bodies are called out, not dumped", async () => {
    const { fn } = fakeApi({ "/api/events/e1": { ...det, redacted: true, body: null } });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "get_payload", { event_id: "e1" });
    expect(r!.content[0]!.text).toContain("redacted");
  });

  it("oversize bodies truncate with a note", async () => {
    const big = "x".repeat(70_000);
    const { fn } = fakeApi({
      "/api/events/e1": { ...det, body: big, size: 70_000, content_type: "text/plain" },
    });
    const s = createMcpServer({ api: fn, canWrite: WRITE, now: () => NOW });
    const r = await callTool(s, "get_payload", { event_id: "e1" });
    expect(r!.content[0]!.text).toContain("[truncated — 70000B total]");
  });

  it("missing event_id is a tool error", async () => {
    const s = createMcpServer({ canWrite: WRITE });
    const r = await callTool(s, "get_payload", {});
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain('"event_id"');
  });
});

describe("write gating (scoped tokens from day one)", () => {
  it("replay on a read-only token: clear refusal, NO api call", async () => {
    const { fn, calls } = fakeApi({});
    const s = createMcpServer({ api: fn, canWrite: READONLY });
    const r = await callTool(s, "replay", { event_id: "e1" });
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain("read-only");
    expect(calls).toHaveLength(0);
  });

  it("send_test on a read-only token: same refusal", async () => {
    const { fn, calls } = fakeApi({});
    const s = createMcpServer({ api: fn, canWrite: READONLY });
    const r = await callTool(s, "send_test", { source: "stripe-main" });
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain("read-only");
    expect(calls).toHaveLength(0);
  });

  it("replay with write: POSTs the replay endpoint", async () => {
    const { fn, calls } = fakeApi({ "/api/events/e1/replay": { queued: 2 } });
    const s = createMcpServer({ api: fn, canWrite: WRITE });
    const r = await callTool(s, "replay", { event_id: "e1" });
    expect(r!.isError).toBeUndefined();
    expect(r!.content[0]!.text).toContain("2 delivery(ies)");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("send_test with write: resolves name, POSTs test, reports routing", async () => {
    const { fn, calls } = fakeApi({
      "/api/sources": { sources: [src("src_2", "github-main", "github"), src("src_3", "gh-other", "github")] },
      "/api/sources/src_2/test": { ok: true, id: "evt_new", queued_to: 3 },
    });
    const s = createMcpServer({ api: fn, canWrite: WRITE });
    const r = await callTool(s, "send_test", { source: "github-main" });
    expect(r!.content[0]!.text).toContain("evt_new");
    expect(r!.content[0]!.text).toContain("3 destination(s)");
    const post = calls.find((c) => c.path.endsWith("/test"))!;
    expect(post.path).toBe("/api/sources/src_2/test");
    expect(post.init?.method).toBe("POST");
  });
});

describe("tools/call error envelope", () => {
  it("unknown tool is a JSON-RPC error (-32602), not an isError result", async () => {
    const s = createMcpServer();
    const r = (await server_call(s, "nope", {})) as { error: { code: number; message: string } };
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("unknown tool");
  });

  it("api failures surface as isError with the message", async () => {
    const boom = (async () => {
      throw new Error("api 500: boom");
    }) as unknown as McpApiFn;
    const s = createMcpServer({ api: boom, canWrite: WRITE });
    const r = await callTool(s, "get_payload", { event_id: "e1" });
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain("boom");
  });

  it("non-object arguments are a tool error", async () => {
    const s = createMcpServer({ canWrite: WRITE });
    const r = await callTool(s, "get_payload", ["not", "an", "object"]);
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain("JSON object");
  });
});

/** raw handleMessage helper returning the full message (for error-shape tests) */
async function server_call(s: ReturnType<typeof createMcpServer>, name: string, args: unknown) {
  return s.handleMessage({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name, arguments: args },
  });
}
