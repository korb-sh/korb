// `korb login` — browser-approved device flow. The CLI mints an
// unguessable one-time code server-side, the user approves scopes in the
// browser (dashboard session), and the exchange hands the token over
// exactly once.

import { spawn } from "node:child_process";
import { apiBase, saveCredentials, DEFAULT_API_BASE } from "./config.js";

const POLL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60_000;

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* URL is printed regardless */
  }
}

async function loginFetch<T>(path: string, body: unknown, base: string): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* non-json body */
  }
  return { status: res.status, json };
}

export async function cmdLogin(apiBaseOverride?: string): Promise<number> {
  const base = (apiBaseOverride ?? process.env.KORB_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");

  const created = await loginFetch<{ code: string; auth_url: string }>("/api/cli/code", {}, base);
  if (created.status !== 200 || !created.json?.code) {
    console.error(`could not start login (api ${created.status}) — is ${base} reachable?`);
    return 1;
  }
  const { code, auth_url } = created.json;

  console.log(`Approve in your browser:\n\n  ${auth_url}\n`);
  openBrowser(auth_url);
  console.log("Waiting for approval");

  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (Date.now() - started > MAX_WAIT_MS) {
      console.error("\ngave up after 10 minutes — the code expired. Re-run korb login.");
      return 1;
    }
    const ex = await loginFetch<{ status?: string; token?: string; can_write?: boolean }>(
      "/api/cli/exchange",
      { code },
      base,
    );
    if (ex.status === 200 && ex.json?.token) {
      saveCredentials({
        token: ex.json.token,
        api_base: base,
        can_write: ex.json.can_write === true,
        created_at: Date.now(),
      });
      console.log(
        `\n✓ logged in (scope: ${ex.json.can_write ? "read+write" : "read-only"}) — saved ${base}`,
      );
      return 0;
    }
    if (ex.status === 403) {
      console.error("\ndenied — nothing was shared. Re-run korb login if you change your mind.");
      return 1;
    }
    if (ex.status === 410) {
      console.error("\nthe code expired — re-run korb login.");
      return 1;
    }
    if (ex.status === 404) {
      console.error("\nunknown code — re-run korb login.");
      return 1;
    }
    process.stdout.write("."); // 202 pending
  }
}
