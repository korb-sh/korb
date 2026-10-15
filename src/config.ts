// Credentials + api-base resolution. The file is ~/.korb/credentials.json
// (0600); KORB_CONFIG_DIR redirects it for tests. Env overrides win over
// the file so CI can inject KORB_TOKEN without touching disk.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical host — korb.sh custom domain (live 2026-10-12). */
export const DEFAULT_API_BASE = "https://korb.sh";

export interface Credentials {
  token: string;
  api_base: string;
  can_write: boolean;
  created_at: number;
}

export function configDir(): string {
  return process.env.KORB_CONFIG_DIR ?? join(homedir(), ".korb");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export function loadCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as Partial<Credentials>;
    if (typeof c.token !== "string" || !c.token) return null;
    return {
      token: c.token,
      api_base: typeof c.api_base === "string" ? c.api_base : DEFAULT_API_BASE,
      can_write: c.can_write === true,
      created_at: typeof c.created_at === "number" ? c.created_at : 0,
    };
  } catch {
    return null;
  }
}

export function saveCredentials(c: Credentials): void {
  mkdirSync(configDir(), { recursive: true });
  const p = credentialsPath();
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600); // mode is best-effort on some filesystems
  } catch {
    /* windows */
  }
}

/** Local removal only — the token stays live server-side; the dashboard
 *  is the revoke surface (a token cannot revoke itself by design). */
export function clearCredentials(): boolean {
  const p = credentialsPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function apiBase(): string {
  return process.env.KORB_API_BASE ?? loadCredentials()?.api_base ?? DEFAULT_API_BASE;
}

export function authToken(): string | null {
  return process.env.KORB_TOKEN ?? loadCredentials()?.token ?? null;
}
