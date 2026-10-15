// Bin invocation — the shipped binary must actually run main() in every
// real-world form. Regression: the ESM run-gate compared import.meta.url
// to the LITERAL argv[1]; via symlink (npm i -g, npx, node_modules/.bin —
// every normal invocation) argv[1] is the link path, the compare failed
// silently, and the CLI exited 0 with no output (shipped in 0.1.1/0.1.2).

import { describe, it, expect } from "vitest";
import { symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const bin = join(here, "..", "dist", "index.js");

// Invoke as node <target> --help: identical to the shebang invocation as
// far as the gate is concerned (argv[1] = the path AS TYPED — through a
// symlink it stays the LINK path while import.meta.url is the real file),
// without depending on the local exec bit (npm chmods bin entries at
// install time; a fresh tsc build has none).
function run(target: string, arg: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [target, arg], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; code?: string };
    if (err.code && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error(`spawn failed (${err.code})`);
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

describe("bin entry point", () => {
  it("runs via a symlink (npm -g / npx / .bin shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "korb-binlink-"));
    try {
      const link = join(dir, "korb");
      symlinkSync(bin, link);
      const r = run(link, "--help");
      expect(r.out).toContain("webhook gateway");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs via a relative direct path", () => {
    const r = run(bin, "--help");
    expect(r.out).toContain("webhook gateway");
  });
});
