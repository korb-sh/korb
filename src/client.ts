// API client — bearer auth, JSON bodies, errors that print well.

import { apiBase, authToken } from "./config.js";

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`api ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  /** login/exchange are pre-auth surfaces */
  unauthenticated?: boolean;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const token = authToken();
  if (!init.unauthenticated && !token) {
    throw new Error("not logged in — run `korb login` (or set KORB_TOKEN)");
  }
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      /* raw text is fine */
    }
    throw new ApiError(res.status, msg);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
