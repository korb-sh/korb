// tsc strips nothing it shouldn't, but the shebang lives in src/index.ts
// as a comment — this guarantees the bin entry starts with it regardless.
import { readFileSync, writeFileSync } from "node:fs";

const p = new URL("../dist/index.js", import.meta.url);
const src = readFileSync(p, "utf8");
if (!src.startsWith("#!")) {
  writeFileSync(p, `#!/usr/bin/env node\n${src}`);
}
