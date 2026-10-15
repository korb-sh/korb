# korb

**Catch every webhook. Never drop one again.**

korb is a receive-side webhook gateway: point Stripe, Shopify, GitHub, or any
HTTP POST source at your korb URL, and korb verifies, stores, and fans events
out to your destinations — with retries, logs, and replay.

- Web: https://korb.sh
- GitHub: https://github.com/korb-sh/korb

Zero runtime dependencies. Node >= 18.

## Setup

```sh
npm i -g @korb-sh/korb
korb login           # approve access in your browser
```

`login` opens a device-style handshake and saves a token to
`~/.korb/credentials.json` (0600). For CI, create an API token in the
dashboard (Settings → API tokens) and export it:

```sh
export KORB_TOKEN=korb_...
export KORB_API_BASE=https://korb.sh   # override the default endpoint
```

## Commands

```
korb login / whoami / logout
korb forward <url> [--source id] [--interval ms]   live events -> localhost
korb sources / destinations / routes
korb events [--hours N] [--status s] [--source id]
korb events get <id>                               headers + body of one event
korb replay <id>                                   redeliver one event
korb presets                                       preset catalog (public)
korb test <source>                                 fire the preset's test event
korb delete <source|destination|route> <id-or-name>
```

## MCP server

`korb mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio — let your agent operate your webhooks: find failed
deliveries, inspect payloads, replay, fire test events.

Tools: `list_failed`, `get_payload`, `replay`, `send_test`
(replay + send_test need a read+write token; the server refuses politely on
read-only tokens).

Claude Desktop / Cursor config:

```json
{
  "mcpServers": {
    "korb": {
      "command": "korb",
      "args": ["mcp"],
      "env": { "KORB_TOKEN": "korb_..." }
    }
  }
}
```

Without `KORB_TOKEN` it uses the saved `korb login` credentials.

Typical agent flow: `list_failed` → what broke? → `get_payload` → what was
sent? → `replay` after fixing the consumer → `send_test` to verify
end-to-end.

## Scoped tokens

API tokens are minted in the dashboard and are read-only or read+write.
Write actions through a read-only token are refused locally (clear message)
and re-enforced server-side. Billing and account deletion are always
dashboard-session-only — a token can never touch them.
