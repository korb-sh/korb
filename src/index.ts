// Entry point — subcommand dispatch. Zero-dep arg parsing: commands are
// positional, flags are --key value (or --key for booleans).

import { cmdLogin } from "./login.js";
import { cmdForward } from "./forward.js";
import {
  cmdSources,
  cmdDestinations,
  cmdRoutes,
  cmdEvents,
  cmdEventGet,
  cmdReplay,
  cmdDelete,
} from "./objects.js";
import { cmdPresets, cmdTest } from "./testevent.js";
import { runMcpStdio } from "./mcp.js";
import { clearCredentials, apiBase, authToken, loadCredentials } from "./config.js";
import { api } from "./client.js";

const HELP = `korb — receive-side webhook gateway (https://korb.sh)

USAGE
  korb login                          approve API access in the browser
  korb whoami                         show tenant + token scope
  korb logout                         remove the local token

  korb forward <url> [flags]          forward live events to a local server
      --source <id>                   only one source
      --interval <ms>                 poll interval (default 1000)
      --since <epoch-ms>              start from a timestamp, not now

  korb sources                        list sources
  korb destinations                   list destinations
  korb routes                         list routes (with names)
  korb events [--hours N] [--status s] [--source id]
  korb events get <id>                headers + body of one event
  korb replay <id>                    redeliver one event

  korb presets                        preset catalog (public, no login)
  korb test <source>                  fire the preset's test event

  korb mcp                            MCP server over stdio (Claude/Cursor/etc)
                                      auth: saved login or KORB_TOKEN env
                                      config: {"command":"korb","args":["mcp"]}

  korb delete <source|destination|route> <id-or-name>
                                      delete ONE named object (no wildcards)

  --api-base <url>                    api endpoint (login only; also KORB_API_BASE)
ENV
  KORB_TOKEN                          bearer token (CI — skips the file)
  KORB_API_BASE                       api endpoint override
`;

interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "", ...rest0] = argv;
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  const VALUE_FLAGS = new Set(["source", "interval", "since", "hours", "status", "api-base"]);
  for (let i = 0; i < rest0.length; i++) {
    const a = rest0[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < rest0.length) {
        flags.set(key, rest0[++i]!);
      } else {
        flags.set(key, true);
      }
    } else {
      rest.push(a);
    }
  }
  return { command, rest, flags };
}

async function cmdWhoami(): Promise<number> {
  const me = await api<{
    email: string;
    role: string;
    tenant_id: string;
    tenant_name: string;
    plan: string;
    can_write?: boolean;
  }>("/api/me");
  const creds = loadCredentials();
  // /api/me is the truth (works for KORB_TOKEN env too); the file's scope
  // is the fallback for older deploys that don't report it yet
  const scope = me.can_write ?? (creds?.can_write === true);
  console.log(`tenant:   ${me.tenant_name} (${me.tenant_id})`);
  console.log(`plan:     ${me.plan}`);
  console.log(`identity: ${me.email} [${me.role}]`);
  console.log(`scope:    ${scope ? "read+write" : "read-only"}`);
  console.log(`api:      ${apiBase()}${authToken() ? "" : " (KORB_TOKEN not set)"}`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, rest, flags } = parseArgs(argv);
  const apiBaseFlag = typeof flags.get("api-base") === "string" ? (flags.get("api-base") as string) : undefined;

  switch (command) {
    case "login":
      return cmdLogin(apiBaseFlag);
    case "logout": {
      const removed = clearCredentials();
      console.log(
        removed
          ? "token removed locally — revoke it in dashboard → Settings → API tokens if it should die server-side"
          : "no stored token",
      );
      return 0;
    }
    case "whoami":
      return cmdWhoami();
    case "forward": {
      const target = rest[0];
      if (!target || !/^https?:\/\//.test(target)) {
        console.error("usage: korb forward <http://localhost:PORT/path> [--source id] [--interval ms]");
        return 1;
      }
      return cmdForward({
        target,
        source: typeof flags.get("source") === "string" ? (flags.get("source") as string) : undefined,
        intervalMs: Number(flags.get("interval")) > 0 ? Number(flags.get("interval")) : 1000,
        sinceMs: Number(flags.get("since")) > 0 ? Number(flags.get("since")) : undefined,
      });
    }
    case "sources":
      return cmdSources();
    case "destinations":
      return cmdDestinations();
    case "routes":
      return cmdRoutes();
    case "events": {
      if (rest[0] === "get") {
        if (!rest[1]) {
          console.error("usage: korb events get <id>");
          return 1;
        }
        return cmdEventGet(rest[1]);
      }
      return cmdEvents({
        hours: Number(flags.get("hours")) > 0 ? Number(flags.get("hours")) : 24,
        status: typeof flags.get("status") === "string" ? (flags.get("status") as string) : undefined,
        source: typeof flags.get("source") === "string" ? (flags.get("source") as string) : undefined,
      });
    }
    case "replay": {
      if (!rest[0]) {
        console.error("usage: korb replay <event-id>");
        return 1;
      }
      return cmdReplay(rest[0]);
    }
    case "presets":
      return cmdPresets();
    case "mcp":
      // never returns until stdin closes; exit code rides process.exitCode
      return runMcpStdio();
    case "test": {
      if (!rest[0]) {
        console.error("usage: korb test <source-id-or-name>");
        return 1;
      }
      return cmdTest(rest[0]);
    }
    case "apply":
      console.error("korb apply was removed — sources mint secret URLs a config file can never hold. Use the dashboard or `korb delete` for removals.");
      return 1;
    case "delete": {
      const kind = rest[0];
      const ref = rest[1];
      if (!kind || !ref || !["source", "destination", "route"].includes(kind)) {
        console.error("usage: korb delete <source|destination|route> <id-or-name>");
        return 1;
      }
      return cmdDelete(kind as "source" | "destination" | "route", ref);
    }
    case "help":
    case "--help":
    case "":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

process.on("unhandledRejection", (err) => {
  console.error(String(err));
  process.exit(1);
});

// run only as a real bin — importing (tests) must not execute the CLI.
// pathToFileURL resolves argv[1] (often relative) the way import.meta.url
// is spelled — naive string concat silently never matches.
// realpathSync is REQUIRED: bins are invoked through symlinks (npm -g,
// npx, node_modules/.bin) — argv[1] is then the LINK path while
// import.meta.url is the real file, and the naive compare silently
// skips main() (exit 0, no output). Node's documented main-module check.
// NOTE: success paths set exitCode and RETURN — process.exit() here would
// truncate buffered stdout on pipes/redirects (console.log to a file is
// async; the exit kills the flush). stderr is sync, so error exits are
// safe to hard-exit.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
