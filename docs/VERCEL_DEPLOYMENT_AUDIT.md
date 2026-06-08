# Vercel Deployment Risk Audit

Date: 2026-05-16
Repo: `/Users/richardgentry/Projects/n8n-chatgpt-mcp`

## Bottom Line

Do not deploy this repo to Vercel as-is. The project is currently shaped for a long-running Node/Docker server, while Vercel expects request-scoped Functions or a supported framework entrypoint. A safe path is either:

1. Keep this app on a container host or VM where long-lived SSE/WebSocket connections and `/app/data` persistence are expected.
2. Refactor a smaller HTTP-only MCP surface into Vercel Functions under `api/`, with external storage for state and secrets.

## High Risks

### 1. No Vercel entrypoint

There is no `vercel.json`, no `api/` directory, and no supported framework entrypoint. The root `package.json` starts `node dist/index.js`, and the Docker launcher starts one of the long-running servers through `start.js`.

Vercel Node functions are normally exposed through files inside `api/` or framework routes, not by running an arbitrary Express server forever.

Relevant files:

- `package.json`
- `start.js`
- `Dockerfile`
- `src/index.ts`
- `oauth-mcp-server.mjs`
- `mcp-http-server.js`
- `mcp-ws-server.js`

### 2. Build/runtime output is not ready

The root `dist/` directory is not present in this checkout, but runtime wrappers import from `./dist/services/...`. Vercel would need a successful build before these files exist.

The TypeScript config also compiles to CommonJS while the package is marked as ESM:

- `package.json` has `"type": "module"`
- `tsconfig.json` has `"module": "commonjs"`

That combination can produce `.js` files that Node treats as ESM even though they contain CommonJS output.

### 3. Missing source modules for `src/index.ts`

`src/index.ts` imports these modules, but they are not present in the repo source tree:

- `./middleware/auth.js`
- `./services/auth-service.js`
- `./routes/auth.js`
- `./routes/oauth.js`

If Vercel builds the root TypeScript app, this is expected to fail unless those sources are restored or the entrypoint is changed.

### 4. Long-lived SSE/WebSocket design conflicts with Vercel Functions

This repo keeps process-local connection state in maps, uses heartbeat intervals, and has a dedicated WebSocket server:

- `src/services/mcp-server.ts`
- `oauth-mcp-server.mjs`
- `mcp-http-server.js`
- `mcp-ws-server.js`

Vercel Functions can stream responses, but they still have maximum execution durations. Vercel's own WebSocket guidance points to external realtime providers rather than long-lived WebSocket servers inside Functions.

### 5. Local filesystem persistence will not be durable

The app writes persistent state to local paths:

- `/app/data/n8n-hosts.json`
- `/app/data/n8n-credentials.json`
- `data/notes`

Vercel bundles readable files for Functions, but runtime persistence should be moved to external storage such as a database, Vercel KV, Blob, or another durable service.

### 6. Secret exposure risk in tracked files

There are tracked files with real-looking production config or hard-coded token-shaped values. I did not print those values in this audit.

Files to review and rotate before any public deployment:

- `mcp-gateway/.env.production`
- `mcp-gateway/mcp-server.cjs`
- `streamable-mcp-server.js`
- `mcp-gateway/web-admin.html`

Also review `.gitignore`: broad patterns like `*auth*`, `*token*`, and `*secret*` can accidentally hide source files needed for builds while still allowing already-tracked secret files to remain in git history.

## Medium Risks

### 7. Auth defaults are unsafe for production

Defaults such as `ADMIN_PASSWORD=changeme`, fallback JWT/session secrets, and disabled auth paths are present in source/config. Vercel environment variables should be required for production rather than falling back to weak defaults.

### 8. CORS handling is inconsistent

Some paths default to `CORS_ORIGIN='*'` while also supporting credentials or MCP clients. Production should use an exact allowlist for ChatGPT/Claude and the deployed domain.

### 9. Docker and Traefik assumptions do not transfer to Vercel

The current docs and Dockerfile assume exposed ports, health checks, Traefik labels, and `/app/data`. These assumptions do not map directly to Vercel's serverless routing model.

## Recommended Vercel Path

If Vercel is still the target, build a narrow adapter instead of deploying the current server directly:

1. Create `api/mcp.ts` or framework route handlers for HTTP JSON-RPC only.
2. Remove WebSocket mode from the Vercel path; use an external realtime provider if WebSockets are required.
3. Move host records, OAuth sessions, and credentials out of local files into durable storage.
4. Require all production secrets through Vercel environment variables.
5. Add `vercel.json` only after the function entrypoint and max duration are chosen.
6. Rotate any token-shaped values that have been committed.
7. Fix the ESM/CommonJS mismatch before deploying.

## Official Vercel References

- Vercel Functions: https://vercel.com/docs/functions/
- Node.js runtime: https://vercel.com/docs/functions/runtimes/node-js/
- Function duration: https://vercel.com/docs/functions/configuring-functions/duration
- Function limits: https://vercel.com/docs/functions/limitations/
- WebSocket guidance: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Files in Functions: https://vercel.com/guides/how-can-i-use-files-in-serverless-functions
