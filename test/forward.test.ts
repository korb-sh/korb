// Pure-logic tests: header filtering, the same-ms-safe window walk, and
// arg parsing. Network-touching commands are covered by the app-side
// suite (the API they call) + the live E2E.

import { describe, it, expect } from "vitest";
import { forwardableHeaders, collectNewEvents, type ListedEvent } from "../src/forward";
import { parseArgs } from "../src/index";

function ev(id: string, received_at: number, extra: Partial<ListedEvent> = {}): ListedEvent {
  return {
    id,
    source_id: "s1",
    status: "delivered",
    event_type: null,
    received_at,
    size: 10,
    delivered_count: 1,
    failed_count: 0,
    ...extra,
  };
}

describe("forwardableHeaders", () => {
  it("strips hop-by-hop + transport headers, keeps the rest", () => {
    const out = forwardableHeaders({
      Host: "korb.sh",
      "content-type": "application/json",
      "Content-Length": "42",
      connection: "keep-alive",
      "stripe-signature": "t=1,v1=abc",
      "X-Custom": "keepme",
      "accept-encoding": "gzip",
    });
    expect(out).toEqual({
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=abc",
      "X-Custom": "keepme",
    });
  });

  it("null headers -> empty object", () => {
    expect(forwardableHeaders(null)).toEqual({});
  });
});

describe("collectNewEvents (same-ms-safe window walk)", () => {
  it("single page, returned oldest-first", async () => {
    const events = [ev("b", 2000), ev("a", 1000)];
    const out = await collectNewEvents(0, async () => ({ events }));
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("multi-page catch-up via until-shrink, deduped", async () => {
    // page1 (newest window): c,b ; page2 (until=oldest): b,a — b refetched
    const pages = [
      { events: [ev("c", 3000), ev("b", 2000)] },
      { events: [ev("b", 2000), ev("a", 1000)] },
      { events: [] },
    ];
    let i = 0;
    const out = await collectNewEvents(0, async () => pages[Math.min(i++, pages.length - 1)]!);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("same-millisecond events across pages are not lost", async () => {
    // the strict `<` cursor would drop these; the walk must not
    const pages = [
      { events: [ev("x2", 5000), ev("x1", 5000)] },
      { events: [ev("x1", 5000), ev("x0", 5000)] }, // same ms, new id beyond page 1
      { events: [ev("x0", 5000), ev("w", 4000)] },
      { events: [] },
    ];
    let i = 0;
    const out = await collectNewEvents(0, async () => pages[Math.min(i++, pages.length - 1)]!);
    expect(out.map((e) => e.id).sort()).toEqual(["w", "x0", "x1", "x2"]);
  });

  it("stops when a full window overlaps (fresh==0)", async () => {
    const page = { events: [ev("a", 1000)] };
    let calls = 0;
    const out = await collectNewEvents(0, async () => {
      calls++;
      return page;
    });
    expect(out.map((e) => e.id)).toEqual(["a"]);
    expect(calls).toBe(2); // initial + one overlap probe
  });

  it("respects since boundary (server-side filter mirrored in calls)", async () => {
    const calls: { since: number; until?: number }[] = [];
    await collectNewEvents(1234, async (q) => {
      calls.push(q);
      return { events: [] };
    });
    expect(calls[0]!.since).toBe(1234);
  });
});

describe("parseArgs", () => {
  it("splits command, positionals, and value flags", () => {
    const p = parseArgs(["forward", "http://localhost:3000/hook", "--source", "s1", "--interval", "250"]);
    expect(p.command).toBe("forward");
    expect(p.rest).toEqual(["http://localhost:3000/hook"]);
    expect(p.flags.get("source")).toBe("s1");
    expect(p.flags.get("interval")).toBe("250");
  });

  it("boolean flags and nested subcommands", () => {
    const p = parseArgs(["events", "get", "evt_1", "--status", "failed"]);
    expect(p.command).toBe("events");
    expect(p.rest).toEqual(["get", "evt_1"]);
    expect(p.flags.get("status")).toBe("failed");
  });

  it("unknown value-less flag becomes boolean true", () => {
    const p = parseArgs(["x", "--weird"]);
    expect(p.flags.get("weird")).toBe(true);
  });

  it("empty argv", () => {
    const p = parseArgs([]);
    expect(p.command).toBe("");
    expect(p.rest).toEqual([]);
  });
});
