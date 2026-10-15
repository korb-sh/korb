// `korb forward` — point a source at korb, get live events on localhost.
//
// Poll-based by design (v1): the events API already exists, ~1s latency is
// imperceptible for dev-time forwarding, and push (SSE/WS) would need
// per-tenant streaming infra for zero visible gain. The walk below is
// built so an SSE upgrade later is transparent to the user.
//
// Correctness core: the server cursor uses `received_at <` (strict) which
// can skip same-millisecond events at page boundaries — so catch-up NEVER
// uses it. Instead: inclusive `since`/`until` windows walked backwards
// (until = oldest seen so far), deduped by event id. Costs one extra
// request per poll; misses nothing.

import { api } from "./client.js";

export interface ListedEvent {
  id: string;
  source_id: string | null;
  status: string;
  event_type: string | null;
  received_at: number;
  size: number;
  delivered_count: number;
  failed_count: number;
}

interface EventDetail extends ListedEvent {
  headers: Record<string, string> | null;
  body: string | null;
  content_type: string | null;
  redacted: boolean;
}

/** Hop-by-hop + transport headers that must not ride a re-POST. */
const STRIP_HEADERS = new Set(
  [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
    "expect",
    "accept-encoding", // local reply may differ; let fetch negotiate
  ].map((h) => h.toLowerCase()),
);

export function forwardableHeaders(stored: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored ?? {})) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Fetch every event with received_at >= sinceMs, oldest-first. Pages via
 *  until-shrink + id-dedupe (see header note). fetchPage is injected for
 *  tests. */
export async function collectNewEvents(
  sinceMs: number,
  fetchPage: (q: { since: number; until?: number }) => Promise<{ events: ListedEvent[] }>,
): Promise<ListedEvent[]> {
  const seen = new Set<string>();
  const out: ListedEvent[] = [];
  let until: number | undefined;

  for (;;) {
    const { events } = await fetchPage({ since: sinceMs, until });
    if (events.length === 0) break;
    const fresh = events.filter((e) => !seen.has(e.id));
    if (fresh.length === 0) break; // full overlap — window drained
    for (const e of fresh) {
      seen.add(e.id);
      out.push(e);
    }
    // shrink to the oldest seen; same-ms siblings re-arrive next page and
    // dedupe absorbs them (termination is fresh==0, NEVER a timestamp
    // stall — a burst can legitimately spend several pages on one ms)
    const oldest = Math.min(...events.map((e) => e.received_at));
    if (until === undefined || oldest < until) until = oldest;
  }
  out.sort((a, b) => a.received_at - b.received_at || (a.id < b.id ? -1 : 1));
  return out;
}

export interface ForwardOpts {
  target: string;
  source?: string;
  intervalMs: number;
  sinceMs?: number;
}

const DEDUPE_RETENTION_MS = 5 * 60_000;

function line(ev: ListedEvent, suffix: string): void {
  const t = new Date(ev.received_at).toLocaleTimeString();
  console.log(`[${t}] ${ev.id} ${ev.event_type ?? "-"} (${ev.size}B) ${suffix}`);
}

export async function cmdForward(opts: ForwardOpts): Promise<number> {
  let lastSeen = opts.sinceMs ?? Date.now();
  // ids delivered recently — survives across polls because `since` is
  // inclusive and refetches the boundary millisecond
  const recent = new Map<string, number>();
  let forwarded = 0;
  let failed = 0;
  let running = true;

  process.on("SIGINT", () => {
    running = false; // finish the current poll, then report
  });

  console.log(
    `forwarding ${opts.source ? `source ${opts.source} ` : ""}-> ${opts.target} (Ctrl-C to stop)`,
  );

  while (running) {
    try {
      const events = await collectNewEvents(lastSeen, (q) => {
        const p = new URLSearchParams({ since: String(q.since) });
        if (q.until !== undefined) p.set("until", String(q.until));
        if (opts.source) p.set("source", opts.source);
        return api<{ events: ListedEvent[] }>(`/api/events?${p}`);
      });

      // evict stale dedupe entries
      const cutoff = lastSeen - DEDUPE_RETENTION_MS;
      for (const [id, at] of recent) if (at < cutoff) recent.delete(id);

      const fresh = events.filter((e) => !recent.has(e.id));
      for (const ev of fresh) {
        recent.set(ev.id, ev.received_at);
        const detail = await api<EventDetail>(`/api/events/${ev.id}`);
        if (detail.redacted || detail.body === null) {
          line(ev, "SKIPPED — payloads redacted (toggle off in dashboard)");
          continue;
        }
        const headers = forwardableHeaders(detail.headers);
        if (detail.content_type && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          headers["content-type"] = detail.content_type;
        }
        try {
          const res = await fetch(opts.target, {
            method: "POST",
            headers,
            body: detail.body,
            signal: AbortSignal.timeout(30_000),
          });
          forwarded++;
          line(ev, `-> ${res.status}`);
        } catch (err) {
          failed++;
          line(ev, `-> LOCAL ERROR ${String(err).slice(0, 80)} (stored in korb — replay later)`);
        }
        if (ev.received_at > lastSeen) lastSeen = ev.received_at;
      }
    } catch (err) {
      console.error(`poll failed: ${String(err).slice(0, 120)}`);
    }
    if (running) await new Promise((r) => setTimeout(r, opts.intervalMs));
  }

  console.log(`\nstopped — ${forwarded} forwarded, ${failed} failed locally.`);
  return 0;
}
