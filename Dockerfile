# korb MCP server (stdio) — for directory automated checks + container users.
# The server runs with the USER's credentials: pass -e KORB_TOKEN=korb_...
# (or mount ~/.korb). Without a token, initialize/tools/list answer normally
# and tool calls return a clear auth error.
FROM node:22-slim

RUN npm install -g @korb-sh/korb

# stdio is the wire — run with `docker run -i`
ENTRYPOINT ["korb", "mcp"]
