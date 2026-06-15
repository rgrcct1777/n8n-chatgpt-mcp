# TODO — n8n-chatgpt-mcp

Remaining tasks after initial local setup (2026-06-15).

## Requires your action

- [ ] **Add N8N credentials** — Edit `.env` and set `N8N_HOST` and `N8N_API_KEY` from your N8N instance (Settings → API).
- [ ] **Change default passwords** — Update `ADMIN_PASSWORD`, `SESSION_SECRET`, and `JWT_SECRET` in `.env` before any public deployment.
- [ ] **Run N8N locally** (optional) — If you don't have N8N yet: `npx n8n` or Docker `docker run -p 5678:5678 n8nio/n8n`.

## Code / project improvements

- [ ] **Restore full OAuth auth modules** — `src/middleware/auth.ts`, `src/routes/auth.ts`, `src/routes/oauth.ts` are minimal stubs; production OAuth logic lives in `oauth-mcp-server.mjs`.
- [ ] **Address npm audit vulnerabilities** — Run `npm audit` and update or patch affected packages.
- [ ] **Fix Jest open handles** — Tests pass but Jest doesn't exit cleanly; investigate timers in `McpServer`.
- [ ] **Align module format** — `package.json` is `"type": "module"` but TypeScript compiles to CommonJS; current workaround is `dist/package.json` with `"type": "commonjs"`. Consider migrating `tsc` to ESM output long-term.
- [ ] **Update Quick Start clone URL** — README still references `yourusername/n8nmcp`; actual repo is `rgrcct1777/n8n-chatgpt-mcp`.

## Optional next steps

- [ ] Connect Claude.ai or ChatGPT to `http://localhost:3007` (requires tunnel like ngrok for external AI clients).
- [ ] Explore Docker deployment: `docker-compose -f docker-compose.standalone.yml up`.
- [ ] Review `mcp-gateway/` sub-project for advanced plugin architecture.

## Completed in this setup session

- [x] Installed dependencies (`npm install`)
- [x] Fixed TypeScript build (added missing auth stubs, `settings` on `N8nWorkflow`)
- [x] Fixed ESM/CJS interop for `dist/` output
- [x] Created `.env` for local development
- [x] Verified build (`npm run build`)
- [x] Verified tests (9 passing)
- [x] Verified server starts (`node start.js` → port 3007)
- [x] Updated README with local setup section
