// Config file handling — KORB_CONFIG_DIR isolates the test environment.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveCredentials,
  loadCredentials,
  clearCredentials,
  credentialsPath,
  apiBase,
  authToken,
} from "../src/config";

let dir: string;
const PREV = { config: process.env.KORB_CONFIG_DIR, api: process.env.KORB_API_BASE, token: process.env.KORB_TOKEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "korb-cli-"));
  process.env.KORB_CONFIG_DIR = dir;
  delete process.env.KORB_API_BASE;
  delete process.env.KORB_TOKEN;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (PREV.config === undefined) delete process.env.KORB_CONFIG_DIR;
  else process.env.KORB_CONFIG_DIR = PREV.config;
  if (PREV.api !== undefined) process.env.KORB_API_BASE = PREV.api;
  if (PREV.token !== undefined) process.env.KORB_TOKEN = PREV.token;
});

describe("credentials file", () => {
  it("save -> load round-trip; file is owner-only (mode 0600 where POSIX)", () => {
    saveCredentials({ token: "korb_abc", api_base: "https://x.test", can_write: true, created_at: 1 });
    const loaded = loadCredentials();
    expect(loaded).toEqual({ token: "korb_abc", api_base: "https://x.test", can_write: true, created_at: 1 });
    if (process.platform !== "win32") {
      expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("missing file -> null; corrupt file -> null (not a throw)", () => {
    expect(loadCredentials()).toBeNull();
    writeFileSync(credentialsPath(), "{not json");
    expect(loadCredentials()).toBeNull();
  });

  it("clear removes the file and reports", () => {
    saveCredentials({ token: "t", api_base: "b", can_write: false, created_at: 1 });
    expect(clearCredentials()).toBe(true);
    expect(existsSync(credentialsPath())).toBe(false);
    expect(clearCredentials()).toBe(false);
  });
});

describe("resolution precedence", () => {
  it("env KORB_TOKEN beats the file; file beats default absence", () => {
    saveCredentials({ token: "korb_file", api_base: "https://file.test", can_write: false, created_at: 1 });
    expect(authToken()).toBe("korb_file");
    process.env.KORB_TOKEN = "korb_env";
    expect(authToken()).toBe("korb_env");
  });

  it("KORB_API_BASE overrides the stored base", () => {
    saveCredentials({ token: "korb_file", api_base: "https://file.test", can_write: false, created_at: 1 });
    expect(apiBase()).toBe("https://file.test");
    process.env.KORB_API_BASE = "https://env.test";
    expect(apiBase()).toBe("https://env.test");
  });
});
