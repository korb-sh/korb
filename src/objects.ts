// Object + event commands: sources / destinations / routes / events /
// replay. Printers stay plain-text aligned — grep-able over pipes.

import { api } from "./client.js";
import type { ListedEvent } from "./forward.js";

export interface SourceRow {
  id: string;
  name: string;
  preset: string;
  status: string;
  created_at: number;
  last_event_at: number | null;
  secret_set: number;
}

export interface DestinationRow {
  id: string;
  name: string;
  url: string;
  status: string;
  preset: string;
  timeout_s: number;
  rate_limit_per_s: number;
  /** egress auth header NAMES (values are write-only server-side). */
  auth_headers?: string[];
}

export interface RouteRow {
  id: string;
  source_id: string;
  destination_id: string;
  filter?: string[] | null;
  enabled: number;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "never";
}

export async function cmdSources(): Promise<number> {
  const { sources } = await api<{ sources: SourceRow[] }>("/api/sources");
  if (sources.length === 0) {
    console.log("no sources — create one in the dashboard");
    return 0;
  }
  console.log(`${pad("ID", 26)}${pad("NAME", 18)}${pad("PRESET", 10)}${pad("STATUS", 10)}LAST EVENT`);
  for (const s of sources) {
    console.log(`${pad(s.id, 26)}${pad(s.name, 18)}${pad(s.preset, 10)}${pad(s.status, 10)}${when(s.last_event_at)}`);
  }
  return 0;
}

export async function cmdDestinations(): Promise<number> {
  const { destinations } = await api<{ destinations: DestinationRow[] }>("/api/destinations");
  if (destinations.length === 0) {
    console.log("no destinations");
    return 0;
  }
  console.log(`${pad("ID", 26)}${pad("NAME", 18)}${pad("STATUS", 12)}${pad("AUTH", 16)}URL`);
  for (const d of destinations) {
    const auth = d.auth_headers?.length ? d.auth_headers.join(",") : "-";
    console.log(`${pad(d.id, 26)}${pad(d.name, 18)}${pad(d.status, 12)}${pad(auth, 16)}${d.url}`);
  }
  return 0;
}

export async function cmdRoutes(): Promise<number> {
  const [{ routes }, sources, destinations] = await Promise.all([
    api<{ routes: RouteRow[] }>("/api/routes"),
    api<{ sources: SourceRow[] }>("/api/sources"),
    api<{ destinations: DestinationRow[] }>("/api/destinations"),
  ]);
  const srcName = new Map(sources.sources.map((s) => [s.id, s.name]));
  const dstName = new Map(destinations.destinations.map((d) => [d.id, d.name]));
  if (routes.length === 0) {
    console.log("no routes");
    return 0;
  }
  console.log(`${pad("SOURCE", 18)}-> ${pad("DESTINATION", 18)}${pad("FILTER", 24)}${pad("ENABLED", 8)}ROUTE ID`);
  for (const r of routes) {
    const filt = r.filter && r.filter.length ? r.filter.join(",") : "-";
    console.log(
      `${pad(srcName.get(r.source_id) ?? r.source_id, 18)}-> ${pad(dstName.get(r.destination_id) ?? r.destination_id, 18)}${pad(filt, 24)}${pad(r.enabled ? "yes" : "no", 8)}${r.id}`,
    );
  }
  return 0;
}

export interface EventsOpts {
  hours: number;
  status?: string;
  source?: string;
}

export async function cmdEvents(opts: EventsOpts): Promise<number> {
  const since = Date.now() - opts.hours * 3_600_000;
  const out: ListedEvent[] = [];
  let until: number | undefined;
  const seen = new Set<string>();
  for (;;) {
    const p = new URLSearchParams({ since: String(since) });
    if (until !== undefined) p.set("until", String(until));
    if (opts.source) p.set("source", opts.source);
    const { events } = await api<{ events: ListedEvent[] }>(`/api/events?${p}`);
    if (events.length === 0) break;
    const fresh = events.filter((e) => !seen.has(e.id));
    for (const e of fresh) {
      seen.add(e.id);
      out.push(e);
    }
    if (fresh.length === 0) break;
    const oldest = Math.min(...events.map((e) => e.received_at));
    if (until !== undefined && oldest >= until) break;
    until = oldest;
  }
  const rows = out
    .sort((a, b) => b.received_at - a.received_at)
    .filter((e) => !opts.status || e.status === opts.status);
  if (rows.length === 0) {
    console.log(`no events in the last ${opts.hours}h`);
    return 0;
  }
  console.log(`${pad("RECEIVED", 20)}${pad("STATUS", 10)}${pad("TYPE", 26)}ID`);
  for (const e of rows) {
    console.log(
      `${pad(when(e.received_at), 20)}${pad(e.status, 10)}${pad(e.event_type ?? "-", 26)}${e.id}`,
    );
  }
  return 0;
}

export async function cmdEventGet(id: string): Promise<number> {
  const d = await api<{
    id: string;
    status: string;
    event_type: string | null;
    received_at: number;
    size: number;
    redacted: boolean;
    headers: Record<string, string> | null;
    body: string | null;
    content_type: string | null;
  }>(`/api/events/${id}`);
  console.log(`id:         ${d.id}`);
  console.log(`received:   ${when(d.received_at)}`);
  console.log(`status:     ${d.status}`);
  console.log(`type:       ${d.event_type ?? "-"}`);
  console.log(`size:       ${d.size}B`);
  console.log(`headers:`);
  for (const [k, v] of Object.entries(d.headers ?? {})) console.log(`  ${k}: ${v}`);
  if (d.redacted || d.body === null) {
    console.log(`body:       [redacted — toggle off in dashboard]`);
  } else if ((d.content_type ?? "").includes("json")) {
    try {
      console.log(`body:\n${JSON.stringify(JSON.parse(d.body), null, 2)}`);
    } catch {
      console.log(`body:\n${d.body}`);
    }
  } else {
    console.log(`body:\n${d.body}`);
  }
  return 0;
}

export async function cmdReplay(id: string): Promise<number> {
  const out = await api<{ queued: number }>(`/api/events/${id}/replay`, { method: "POST", body: {} });
  console.log(`replayed — ${out.queued} delivery(ies) queued`);
  return 0;
}

// --- delete: ONE named object, no wildcards, print what died ---

async function resolveDestination(ref: string): Promise<DestinationRow | null> {
  const { destinations } = await api<{ destinations: DestinationRow[] }>("/api/destinations");
  return (
    destinations.find((d) => d.id === ref) ??
    destinations.find((d) => d.name === ref) ??
    null
  );
}

async function resolveRoute(ref: string): Promise<RouteRow | null> {
  const [{ routes }, sources, destinations] = await Promise.all([
    api<{ routes: RouteRow[] }>("/api/routes"),
    api<{ sources: SourceRow[] }>("/api/sources"),
    api<{ destinations: DestinationRow[] }>("/api/destinations"),
  ]);
  const srcName = new Map(sources.sources.map((s) => [s.id, s.name]));
  const dstName = new Map(destinations.destinations.map((d) => [d.id, d.name]));
  return (
    routes.find((r) => r.id === ref) ??
    // a route "name" is its human pair: "src -> dst"
    routes.find((r) => `${srcName.get(r.source_id)} -> ${dstName.get(r.destination_id)}` === ref) ??
    null
  );
}

export async function cmdDelete(
  kind: "source" | "destination" | "route",
  ref: string,
): Promise<number> {
  if (kind === "source") {
    const { sources } = await api<{ sources: SourceRow[] }>("/api/sources");
    const src = sources.find((s) => s.id === ref) ?? sources.find((s) => s.name === ref);
    if (!src) {
      console.error(`no source "${ref}" — run \`korb sources\``);
      return 1;
    }
    console.log(`deleting source "${src.name}" (${src.id}, preset ${src.preset})`);
    console.log("its ingest URL dies with it — repoint any vendor using it first");
    await api(`/api/sources/${src.id}`, { method: "DELETE" });
    console.log("deleted");
    return 0;
  }
  if (kind === "destination") {
    const dst = await resolveDestination(ref);
    if (!dst) {
      console.error(`no destination "${ref}" — run \`korb destinations\``);
      return 1;
    }
    console.log(`deleting destination "${dst.name}" (${dst.id}, ${dst.url})`);
    await api(`/api/destinations/${dst.id}`, { method: "DELETE" });
    console.log("deleted");
    return 0;
  }
  const route = await resolveRoute(ref);
  if (!route) {
    console.error(`no route "${ref}" — routes are referenced by id or "source -> destination"`);
    return 1;
  }
  console.log(`deleting route ${route.id}`);
  await api(`/api/routes/${route.id}`, { method: "DELETE" });
  console.log("deleted");
  return 0;
}
