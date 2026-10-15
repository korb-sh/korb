// `korb test <source>` — fire the preset's test event through a source
// (a REAL event in the REAL lane; what lands in the inbox looks like the
// vendor). Resolution: exact id first, then exact name, then unique
// prefix. Also `korb presets` — the public catalog, no auth needed.

import { api } from "./client.js";
import type { SourceRow } from "./objects.js";

export interface PresetCatalog {
  sources: { id: string; name: string; testEvent: { description: string } | null }[];
  destinations: { id: string; name: string }[];
}

async function loadCatalog(): Promise<PresetCatalog> {
  // public route — api() still sends the token when present, which is fine
  return api<PresetCatalog>("/api/presets", { unauthenticated: true });
}

export async function cmdPresets(): Promise<number> {
  const cat = await loadCatalog();
  console.log("sources:");
  for (const s of cat.sources) {
    console.log(`  ${s.id.padEnd(10)} ${s.name}${s.testEvent ? ` — test: ${s.testEvent.description}` : ""}`);
  }
  console.log("destinations:");
  for (const d of cat.destinations) {
    console.log(`  ${d.id.padEnd(10)} ${d.name}`);
  }
  return 0;
}

/** id > exact name > unique name-prefix. Throws with a helpful message. */
export function resolveSource(sources: readonly SourceRow[], ref: string): SourceRow {
  const byId = sources.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = sources.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`multiple sources named "${ref}" — use the id`);
  const byPrefix = sources.filter((s) => s.name.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) {
    throw new Error(`ambiguous "${ref}" matches: ${byPrefix.map((s) => s.name).join(", ")}`);
  }
  throw new Error(`no source "${ref}" — run \`korb sources\``);
}

export async function cmdTest(ref: string): Promise<number> {
  const { sources } = await api<{ sources: SourceRow[] }>("/api/sources");
  const src = resolveSource(sources, ref);
  const out = await api<{ id: string; queued_to: number }>(
    `/api/sources/${src.id}/test`,
    { method: "POST", body: {} },
  );
  console.log(
    `sent — event ${out.id} through "${src.name}" (${src.preset})${out.queued_to > 0 ? ` -> ${out.queued_to} destination(s)` : " (no routes — inbox only)"}`,
  );
  console.log(`watch: korb events --source ${src.id}`);
  return 0;
}
