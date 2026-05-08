# Project: Right API — N8N MCP Server

## What this project is
An MCP (Model Context Protocol) gateway server that lets AI assistants (Claude, ChatGPT, Microsoft Copilot, etc.) control N8N automation workflows. It runs as a web server and speaks the standard MCP protocol over HTTP, SSE (Server-Sent Events), and WebSocket.

The long-term vision: become the "npm for MCP backends" — a marketplace of AI plugins anyone can install.

## Owner
Richard Gentry — no coding background. Claude Code is his primary development copilot. Always explain changes in plain English. Do the work, don't just advise.

## Project structure

```
/                         Root — main server entry points
  index-mcp.js            Legacy entry point
  oauth-mcp-server.js/.mjs OAuth + SSE server for Claude.ai / ChatGPT
  streamable-mcp-server.js Streamable HTTP variant
  mcp-ws-server.js        WebSocket server for ChatGPT Connectors
  start.js                Primary start script

/src/                     TypeScript source (main server)
  index.ts                Express app + route mounting
  config/index.ts         Environment config
  routes/dashboard.ts     Admin dashboard routes
  services/mcp-server.ts  MCP protocol handler + all N8N tools
  services/n8n-client.ts  N8N API client
  services/oauth-host-manager.ts  Multi-host N8N config manager
  types/mcp.ts            MCP type definitions

/mcp-gateway/             Advanced gateway (plugin architecture)
  src/
    adapters/             N8N + Home Assistant adapters
    services/             Plugin manager, marketplace, security, workflow engine
    routes/marketplace.ts Marketplace API
    types/                Plugin + gateway types

/docs/                    Documentation and diagrams
/scripts/                 Utility scripts
/tests/                   Test files
/traefik/                 Traefik reverse proxy config
Dockerfile                Production Docker image
docker-compose.standalone.yml  Standalone deployment
```

## Key technologies
- **Node.js + TypeScript** — runtime and language
- **Express** — HTTP server framework
- **MCP SDK** (`@modelcontextprotocol/sdk`) — MCP protocol
- **OAuth 2.1** — authentication for Claude.ai
- **SSE + WebSocket** — transport protocols for ChatGPT
- **Docker + Traefik** — production deployment
- **N8N** — the automation platform this server controls

## Current MCP tools (what AIs can do via this server)
All tools are in `src/services/mcp-server.ts`:

### N8N Workflow tools
- `get_workflows` / `n8n_list_workflows` — list all workflows
- `get_workflow` / `n8n_get_workflow` — get one workflow
- `n8n_get_workflow_details` — workflow stats
- `n8n_get_workflow_structure` — nodes + connections only
- `n8n_get_workflow_minimal` — lightweight metadata
- `create_workflow` / `n8n_create_workflow` — create new workflow
- `update_workflow` / `n8n_update_full_workflow` — replace workflow
- `n8n_update_partial_workflow` — targeted node/connection edits
- `delete_workflow` / `n8n_delete_workflow` — delete workflow
- `activate_workflow` / `deactivate_workflow` — toggle active
- `execute_workflow` / `n8n_execute_workflow` — run a workflow
- `get_executions` / `n8n_list_executions` — execution history
- `get_execution` / `n8n_get_execution` — single execution
- `stop_execution` / `n8n_stop_execution` — stop running execution
- `n8n_delete_execution` — delete execution record
- `n8n_health_check` — check N8N connectivity
- `n8n_trigger_webhook_workflow` — trigger via webhook URL

### Utility tools (added 2026-05-08)
- `utility_get_datetime` — current date, time, timezone, day of week
- `utility_fetch_url` — fetch and read any webpage or URL
- `utility_take_note` — save a note to persistent storage
- `utility_list_notes` — list all saved notes
- `utility_read_note` — read a specific note by name
- `utility_delete_note` — delete a note

## Multi-AI compatibility
- **Claude.ai** — OAuth 2.1 + SSE (`oauth-mcp-server.js`)
- **ChatGPT Connectors** — SSE mode with `MCP_MODE=sse`
- **Claude Desktop** — via local MCP config pointing to server URL
- **Microsoft Copilot / others** — standard HTTP MCP endpoint

## Admin dashboard
- URL: `/admin`
- Manages multiple N8N host configurations
- Stored in `/app/data/n8n-hosts.json`
- REST API at `/admin/api/hosts`

## Environment variables
See `src/config/index.ts` and `.env.example` for full list. Key ones:
- `N8N_HOST` — N8N instance URL
- `N8N_API_KEY` — N8N API key
- `MCP_MODE` — `sse` or `ws` or `http`
- `PORT` — server port (default 3000)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin dashboard auth

## GitHub
Repository: https://github.com/rgrcct1777/n8n-chatgpt-mcp
Branch: main — always keep this up to date

## Development notes
- `npm run build` compiles TypeScript
- `npm run dev` runs with ts-node (no build needed)
- `node start.js` runs the built server
- Docker: `docker-compose -f docker-compose.standalone.yml up`
- The `mcp-gateway/` folder is a separate, more advanced gateway architecture — treat as a separate sub-project

## Roadmap priorities (as of 2026)
1. Plugin marketplace (discover + install MCP tools)
2. New service adapters: Google Calendar, Gmail, Slack, GitHub, Notion
3. Microsoft Teams + Google Workspace plugins
4. AI-powered workflow builder (natural language)
5. Multi-region deployment
