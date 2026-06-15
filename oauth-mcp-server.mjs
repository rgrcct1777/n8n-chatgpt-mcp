import http from 'node:http';
import url from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { McpServer } = require('./dist/services/mcp-server.js');
const { N8nClient } = require('./dist/services/n8n-client.js');
const {
  getHostById,
  getDefaultHost,
  getEnvHost,
  resolveHostForRequest,
} = require('./dist/services/oauth-host-manager.js');

// Config and persistence
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const HOSTS_FILE = path.join(DATA_DIR, 'n8n-hosts.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

let hostsData = { hosts: [], defaultHostId: null };
try {
  if (fs.existsSync(HOSTS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
    if (raw && Array.isArray(raw.hosts)) hostsData = { hosts: raw.hosts, defaultHostId: raw.defaultHostId || null };
  } else {
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hostsData, null, 2));
  }
} catch {}

function saveHosts() {
  try { fs.writeFileSync(HOSTS_FILE, JSON.stringify(hostsData, null, 2)); } catch {}
}

function parseCookies(cookieHeader = '') {
  const out = {}; (cookieHeader || '').split(';').forEach(c => { const [k, v] = c.split('='); if (k && v) out[k.trim()] = decodeURIComponent(v.trim()); });
  return out;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function discoveryFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3007';
  const base = process.env.SERVER_URL || `${proto}://${host}`;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256']
  };
}

// In-memory OAuth state (ephemeral; sufficient for ChatGPT connector)
const authCodes = new Map(); // code -> { client_id, redirect_uri, code_challenge, method, scope, state, createdAt }
const accessTokens = new Map(); // token -> { sub, scope, createdAt, expiresIn, hostId }
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_TTL_SEC = 3600; // 1 hour

const activeSseSessions = new Map(); // sessionId -> { transport, server, token }

function createCoreServer(host) {
  if (!host || !host.url || !host.apiKey) {
    throw new Error('No n8n host configured');
  }
  const core = new McpServer(new N8nClient({
    baseUrl: host.url,
    apiKey: host.apiKey,
  }));

  const server = new Server(
    {
      name: 'n8n-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: core.getTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    if (!name) {
      return {
        content: [{ type: 'text', text: 'Error: Tool name is required' }],
        isError: true,
      };
    }

    try {
      return await core.callTool(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return { server, core };
}

function authenticateRequest(req, res) {
  cleanupExpired();
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    try {
      const q = new url.URL(req.url, 'http://localhost');
      token = (q.searchParams.get('access_token') || q.searchParams.get('token') || '').trim();
    } catch {}
  }
  if (!token) {
    json(res, 401, { error: 'invalid_token', error_description: 'Access token required' });
    return null;
  }
  const record = accessTokens.get(token);
  if (!record) {
    json(res, 401, { error: 'invalid_token', error_description: 'Token invalid or expired' });
    return null;
  }
  return { token, record };
}

function cleanupExpired() {
  const now = Date.now();
  for (const [code, rec] of authCodes) if (now - rec.createdAt > CODE_TTL_MS) authCodes.delete(code);
  for (const [tok, rec] of accessTokens) if ((now - rec.createdAt) / 1000 > rec.expiresIn) accessTokens.delete(tok);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}

const AdminPages = {
  login: ({ client_id = '', redirect_uri = '', state = '', code_challenge = '', code_challenge_method = 'S256', scope = 'mcp' }) => `<!doctype html>
<html><head><meta charset="utf-8"/><title>N8N MCP Login</title><style>body{font-family:system-ui,Arial;margin:0;background:#f6f8fb} .wrap{max-width:420px;margin:80px auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:22px}label{display:block;margin:10px 0 6px}input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px}button{margin-top:14px;width:100%;padding:10px;border:0;background:#1f78d1;color:#fff;border-radius:8px;cursor:pointer}</style></head><body><div class="wrap"><h2>Admin Login</h2><form method="POST" action="/oauth/login"><input type="hidden" name="client_id" value="${client_id}"><input type="hidden" name="redirect_uri" value="${redirect_uri}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code_challenge" value="${code_challenge}"><input type="hidden" name="code_challenge_method" value="${code_challenge_method}"><input type="hidden" name="scope" value="${scope}"><label>Username</label><input name="username" required><label>Password</label><input name="password" type="password" required><button type="submit">Login</button></form></div></body></html>`,
  admin: () => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>N8N Hosts Admin</title>
    <style>
      body{font-family:system-ui,Arial;margin:0;background:#f6f8fb}
      .wrap{max-width:960px;margin:24px auto}
      .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:16px 0}
      input,button{padding:10px;font-size:14px}
      input{border:1px solid #cbd5e1;border-radius:8px}
      button{border:0;border-radius:8px;background:#1f78d1;color:#fff;cursor:pointer}
      table{width:100%;border-collapse:collapse}
      th,td{padding:8px 10px;border-bottom:1px solid #ecf0f4}
      .muted{color:#64748b;font-size:12px}
      .actions button{margin-right:8px;background:#334155}
      .actions .danger{background:#b91c1c}
      .actions .default{background:#0f766e}
      .ok{color:#16a34a}
      .err{color:#b91c1c}
    </style>
  </head>
  <body>
    <div class="wrap">
      <h2>N8N Hosts Admin</h2>
      <div class="card">
        <h3>Add Host</h3>
        <form id="f">
          <input id="name" placeholder="Name" required>
          <input id="url" placeholder="https://app.right-api.com" required>
          <input id="apiKey" placeholder="API Key" required>
          <button type="submit">Add</button>
          <button type="button" id="testsave">Test & Save</button>
          <span id="msg" class="muted"></span>
        </form>
      </div>
      <div class="card">
        <h3>Configured Hosts</h3>
        <table id="t">
          <thead>
            <tr><th>Name</th><th>URL</th><th>API Key</th><th>Default</th><th>Actions</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    <script>
      const el = (id) => document.getElementById(id);
      const tbody = document.querySelector('#t tbody');
      const msg = el('msg');
      function maskKey(k){ if(!k) return ''; return k.length <= 6 ? '******' : k.slice(0,3) + '***' + k.slice(-3); }
      async function list(){
        let r;
        try {
          r = await fetch('/admin/api/hosts', { headers: { 'Accept': 'application/json' } });
        } catch (e) { msg.textContent = 'Network error'; return; }
        const ct = (r.headers.get('content-type')||'').toLowerCase();
        if (!ct.includes('application/json')) { window.location.href = '/admin'; return; }
        const d = await r.json();
        tbody.innerHTML='';
        (d.hosts||[]).forEach(h=>{
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td>\${h.name||''}</td>
            <td>\${h.url||''}</td>
            <td>\${maskKey(h.apiKey)||''}</td>
            <td>\${d.defaultHostId===h.id?'<span class="ok">Yes</span>':'No'}</td>
            <td class="actions">
              <button class="default" data-act="default" data-id=\"\${h.id}\">Make default</button>
              <button data-act="test" data-id=\"\${h.id}\">Test</button>
              <button class="danger" data-act="del" data-id=\"\${h.id}\">Delete</button>
            </td>\`;
          tbody.appendChild(tr);
        });
      }
      document.addEventListener('click', async (e)=>{
        const b = e.target.closest('button[data-act]');
        if(!b) return;
        const id = b.getAttribute('data-id');
        const act = b.getAttribute('data-act');
        if(act==='del'){
          await fetch('/admin/api/hosts/'+id,{method:'DELETE'});
          await list();
        }else if(act==='default'){
          await fetch('/admin/api/hosts/'+id+'/default',{method:'POST'});
          await list();
        }else if(act==='test'){
          const r = await fetch('/admin/api/hosts/'+id+'/test',{method:'POST'});
          let text = 'unknown error';
          try { const d = await r.json(); text = d && d.ok ? 'Reachable' : ('Failed: '+(d&&d.error||'unknown')); } catch {}
          alert(text);
        }
      });
      el('f').addEventListener('submit', async (e)=>{
        e.preventDefault(); msg.textContent='';
        const name = el('name').value.trim();
        const url = el('url').value.trim();
        const apiKey = el('apiKey').value.trim();
        if(!name||!url||!apiKey){ msg.textContent='Please fill all fields'; return; }
        let r;
        try {
          r = await fetch('/admin/api/hosts',{
            method:'POST',
            headers:{'Content-Type':'application/json','Accept':'application/json'},
            body: JSON.stringify({name, url, apiKey})
          });
        } catch (e) { msg.textContent='Network error'; return; }
        const ct = (r.headers.get('content-type')||'').toLowerCase();
        if (!ct.includes('application/json')) { window.location.href = '/admin'; return; }
        if(r.status===201){ el('name').value=''; el('url').value=''; el('apiKey').value=''; await list(); msg.textContent='Added'; }
        else { const t = await r.text(); msg.textContent='Error: '+t; }
      });
      el('testsave').addEventListener('click', async (e)=>{
        e.preventDefault(); msg.textContent='';
        const name = el('name').value.trim();
        const url = el('url').value.trim();
        const apiKey = el('apiKey').value.trim();
        if(!name||!url||!apiKey){ msg.textContent='Please fill all fields'; return; }
        // 1) Test
        let tr;
        try {
          tr = await fetch('/admin/api/hosts/test', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ url, apiKey }) });
        } catch (e) { msg.textContent='Network error during test'; return; }
        const tct = (tr.headers.get('content-type')||'').toLowerCase();
        if (!tct.includes('application/json')) { window.location.href='/admin'; return; }
        const tout = await tr.json();
        if(!tout.ok){ msg.textContent='Test failed: '+(tout.error||'unknown'); return; }
        // 2) Save
        let sr;
        try {
          sr = await fetch('/admin/api/hosts', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify({ name, url, apiKey }) });
        } catch (e) { msg.textContent='Network error during save'; return; }
        if(sr.status===201){ el('name').value=''; el('url').value=''; el('apiKey').value=''; await list(); msg.textContent='Saved'; }
        else { const t = await sr.text(); msg.textContent='Save error: '+t; }
      });
      list();
    </script>
  </body>
 </html>`,
};

function requireAuth(req, res) {
  const cookies = parseCookies(req.headers['cookie']);
  if (cookies.admin_session === '1') return true;
  html(res, 200, AdminPages.login({}));
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname: p } = new url.URL(req.url, 'http://localhost');

    if (p === '/.well-known/openid-configuration') {
      return json(res, 200, discoveryFromReq(req));
    }

    if (req.method === 'GET' && p === '/oauth/authorize') {
      cleanupExpired();
      const q = new url.URL(req.url, 'http://localhost');
      const params = Object.fromEntries(q.searchParams.entries());
      const cookies = parseCookies(req.headers['cookie']);
      const isAuthed = cookies.admin_session === '1';
      if (!isAuthed) {
        return html(res, 200, AdminPages.login(params));
      }
      // Issue authorization code and redirect
      const {
        client_id = '', redirect_uri = '', state = '', scope = 'mcp',
        code_challenge = '', code_challenge_method = 'S256'
      } = params;
      const hostId = params.host_id || params.hostId || hostsData.defaultHostId || null;
      if (!redirect_uri) return json(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' });
      const code = crypto.randomBytes(24).toString('hex');
      authCodes.set(code, { client_id, redirect_uri, state, scope, code_challenge, method: code_challenge_method, hostId, createdAt: Date.now() });
      const sep = redirect_uri.includes('?') ? '&' : '?';
      const location = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      res.writeHead(302, { Location: location });
      return res.end();
    }

    if (req.method === 'POST' && p === '/oauth/token') {
      cleanupExpired();
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        const form = Object.fromEntries(new URLSearchParams(body || ''));
        const { grant_type, code, redirect_uri, client_id = '', code_verifier = '' } = form;
        if (grant_type !== 'authorization_code') {
          return json(res, 400, { error: 'unsupported_grant_type' });
        }
        if (!code || !redirect_uri) {
          return json(res, 400, { error: 'invalid_request', error_description: 'missing code or redirect_uri' });
        }
        const rec = authCodes.get(code);
        if (!rec) return json(res, 400, { error: 'invalid_grant', error_description: 'code not found or expired' });
        if (rec.redirect_uri !== redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (rec.client_id && client_id && rec.client_id !== client_id) return json(res, 400, { error: 'invalid_client' });
        // PKCE validation if challenge present
        if (rec.code_challenge) {
          if (!code_verifier) return json(res, 400, { error: 'invalid_request', error_description: 'code_verifier required' });
          const expected = await sha256Base64Url(code_verifier);
          if (expected !== rec.code_challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        // Issue token
        authCodes.delete(code);
        let hostId = rec.hostId;
        if (hostId && hostId !== 'env' && !getHostById(hostsData, hostId)) {
          hostId = undefined;
        }
        if (!hostId) {
          const defHost = getDefaultHost(hostsData);
          if (defHost) hostId = defHost.id;
        }
        if (!hostId) {
          const envHost = getEnvHost({
            url: process.env.N8N_HOST || process.env.N8N_API_URL || '',
            apiKey: process.env.N8N_API_KEY || '',
          });
          if (envHost) hostId = envHost.id;
        }
        const token = crypto.randomBytes(32).toString('hex');
        accessTokens.set(token, { sub: 'admin', scope: rec.scope || 'mcp', createdAt: Date.now(), expiresIn: TOKEN_TTL_SEC, hostId });
        return json(res, 200, { access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_SEC, scope: rec.scope || 'mcp', host_id: hostId });
      });
      return;
    }

    // Login (set simple cookie session)
    if (req.method === 'POST' && p === '/oauth/login') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(body || ''));
        if (params.username === ADMIN_USERNAME && params.password === ADMIN_PASSWORD) {
          res.setHeader('Set-Cookie', 'admin_session=1; Path=/; HttpOnly; SameSite=Lax; Secure');
          // If an OAuth request context was provided, issue code and redirect accordingly
          const client_id = params.client_id || '';
          const redirect_uri = params.redirect_uri || '/admin';
          const state = params.state || '';
          const scope = params.scope || 'mcp';
          const code_challenge = params.code_challenge || '';
          const code_challenge_method = params.code_challenge_method || 'S256';
          if (params.redirect_uri) {
            // Directly issue an authorization code and redirect to the client's redirect_uri
            const code = crypto.randomBytes(24).toString('hex');
            authCodes.set(code, { client_id, redirect_uri, state, scope, code_challenge, method: code_challenge_method, createdAt: Date.now() });
            const sep = redirect_uri.includes('?') ? '&' : '?';
            const location = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
            res.writeHead(302, { Location: location });
            return res.end();
          }
          // Otherwise just go to admin UI
          res.writeHead(302, { Location: redirect_uri });
          return res.end();
        } else {
          html(res, 200, AdminPages.login(params));
        }
      });
      return;
    }

    if (req.method === 'GET' && p === '/oauth/userinfo') {
      // Minimal userinfo for completeness (no real user store)
      const auth = req.headers['authorization'] || '';
      const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '').trim();
      if (!token || !accessTokens.has(token)) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { sub: 'admin', name: 'Admin', scope: accessTokens.get(token).scope });
    }

    if (req.method === 'GET' && p === '/mcp' && req.headers.accept?.includes('text/event-stream')) {
      const auth = authenticateRequest(req, res);
      if (!auth) return;
      try {
        const host = resolveHostForRequest({
          requestUrl: req.url,
          hostsData,
          tokenRecord: auth.record,
          envConfig: {
            url: process.env.N8N_HOST || process.env.N8N_API_URL || '',
            apiKey: process.env.N8N_API_KEY || '',
          },
        });
        if (!host) {
          return json(res, 503, { error: 'host_not_configured', message: 'No n8n host is configured' });
        }
        const { server: coreServer } = createCoreServer(host);
        const transport = new SSEServerTransport('/mcp/message', res);
        await coreServer.connect(transport);
        activeSseSessions.set(transport.sessionId, { transport, server: coreServer, token: auth.token });
        transport.onclose = () => {
          activeSseSessions.delete(transport.sessionId);
        };
      } catch (err) {
        console.error('[mcp] SSE connection error:', err?.message || err);
        try {
          json(res, 500, { error: 'mcp_error', message: err instanceof Error ? err.message : String(err) });
        } catch {}
      }
      return;
    }

    if (req.method === 'POST' && p === '/mcp/message') {
      const auth = authenticateRequest(req, res);
      if (!auth) return;
      const q = new url.URL(req.url, 'http://localhost');
      const sessionId = req.headers['mcp-session-id'] || q.searchParams.get('sessionId') || q.searchParams.get('session_id');
      if (!sessionId) {
        return json(res, 400, { error: 'invalid_request', message: 'sessionId is required' });
      }
      const session = activeSseSessions.get(sessionId);
      if (!session) {
        return json(res, 404, { error: 'unknown_session', message: 'Session not found' });
      }
      if (session.token !== auth.token) {
        return json(res, 403, { error: 'forbidden', message: 'Session does not belong to this token' });
      }
      try {
        await session.transport.handlePostMessage(req, res);
      } catch (err) {
        console.error('[mcp] POST message error:', err?.message || err);
        if (!res.headersSent) {
          json(res, 500, { error: 'mcp_error', message: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    if (req.method === 'DELETE' && p === '/mcp/session') {
      const auth = authenticateRequest(req, res);
      if (!auth) return;
      const q = new url.URL(req.url, 'http://localhost');
      const sessionId = q.searchParams.get('sessionId') || q.searchParams.get('session_id');
      if (!sessionId) {
        return json(res, 400, { error: 'invalid_request', message: 'sessionId is required' });
      }
      const session = activeSseSessions.get(sessionId);
      if (session && session.token === auth.token) {
        activeSseSessions.delete(sessionId);
      }
      return json(res, 200, { ok: true });
    }

    // Admin UI
    if (req.method === 'GET' && p === '/admin') {
      if (!requireAuth(req, res)) { console.log('[admin] not authenticated, showing login'); return; }
      console.log('[admin] render admin UI');
      return html(res, 200, AdminPages.admin());
    }

    // Admin API: list hosts
    if (req.method === 'GET' && p === '/admin/api/hosts') {
      if (!requireAuth(req, res)) { console.log('[admin] list hosts blocked (auth)'); return; }
      console.log('[admin] list hosts', hostsData.hosts.length);
      return json(res, 200, { hosts: hostsData.hosts, defaultHostId: hostsData.defaultHostId });
    }

    // Admin API: add host
    if (req.method === 'POST' && p === '/admin/api/hosts') {
      if (!requireAuth(req, res)) { console.log('[admin] add host blocked (auth)'); return; }
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        try {
          const { name, url: base, apiKey } = JSON.parse(body || '{}');
          console.log('[admin] add host', { name, urlLen: (base||'').length, keyLen: (apiKey||'').length });
          const id = String(Date.now());
          hostsData.hosts.push({ id, name, url: base, apiKey, createdAt: new Date().toISOString() });
          if (!hostsData.defaultHostId) hostsData.defaultHostId = id;
          saveHosts();
          json(res, 201, { ok: true, id });
        } catch (e) { console.log('[admin] add host parse error', e?.message||String(e)); json(res, 400, { error: 'invalid json' }); }
      }); return;
    }

    // Admin API: test a not-yet-saved host
    if (req.method === 'POST' && p === '/admin/api/hosts/test') {
      if (!requireAuth(req, res)) { console.log('[admin] test host blocked (auth)'); return; }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { url: base, apiKey } = JSON.parse(body || '{}');
          const result = await (async function testN8n(baseUrl, key){
            try {
              if (!/^https?:\/\//i.test(baseUrl)) throw new Error('invalid url');
              const u = baseUrl.replace(/\/$/, '') + '/api/v1/health';
              const r = await fetch(u, { headers: { 'Authorization': 'Bearer '+key, 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' }, method: 'GET' });
              const ok = r.ok;
              const status = r.status;
              let info = '';
              try { const j = await r.json(); info = JSON.stringify(j); } catch { info = await r.text(); }
              return ok ? { ok:true, status, info } : { ok:false, status, error: info || ('http '+status) };
            } catch (e) { return { ok:false, error: e?.message || String(e) }; }
          })(base, apiKey);
          return json(res, result.ok ? 200 : 400, result);
        } catch (e) {
          console.log('[admin] test host parse error', e?.message||String(e));
          return json(res, 400, { ok:false, error:'invalid json' });
        }
      });
      return;
    }

    // Admin API: delete host
    if (req.method === 'DELETE' && p.startsWith('/admin/api/hosts/')) {
      if (!requireAuth(req, res)) return; const id = p.split('/admin/api/hosts/')[1];
      hostsData.hosts = hostsData.hosts.filter(h => h.id !== id);
      if (hostsData.defaultHostId === id) hostsData.defaultHostId = hostsData.hosts[0]?.id || null;
      saveHosts(); return json(res, 200, { ok: true });
    }

    // Admin API: set default
    if (req.method === 'POST' && p.endsWith('/default') && p.startsWith('/admin/api/hosts/')) {
      if (!requireAuth(req, res)) return; const id = p.split('/admin/api/hosts/')[1].replace(/\/default$/, '');
      const exists = hostsData.hosts.some(h => h.id === id);
      if (!exists) return json(res, 404, { error: 'not_found' });
      hostsData.defaultHostId = id; saveHosts(); return json(res, 200, { ok: true, defaultHostId: id });
    }

    // Admin API: test existing host
    if (req.method === 'POST' && p.endsWith('/test') && p.startsWith('/admin/api/hosts/')) {
      if (!requireAuth(req, res)) return;
      const id = p.split('/admin/api/hosts/')[1].replace(/\/test$/, '');
      const host = hostsData.hosts.find(h => h.id === id);
      if (!host) return json(res, 404, { ok:false, error: 'not_found' });
      const result = await (async function testN8n(baseUrl, key){
        try {
          if (!/^https?:\/\//i.test(baseUrl)) throw new Error('invalid url');
          const u = baseUrl.replace(/\/$/, '') + '/api/v1/health';
          const r = await fetch(u, { headers: { 'Authorization': 'Bearer '+key, 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' }, method: 'GET' });
          const ok = r.ok; const status = r.status; let info='';
          try { const j = await r.json(); info = JSON.stringify(j); } catch { info = await r.text(); }
          return ok ? { ok:true, status, info } : { ok:false, status, error: info || ('http '+status) };
        } catch (e) { return { ok:false, error: e?.message || String(e) }; }
      })(host.url, host.apiKey);
      return json(res, result.ok ? 200 : 400, { id, ...result });
    }

    // Fallback
    return text(res, 200, 'N8N MCP OAuth Admin service');
  } catch (e) {
    text(res, 500, 'Internal Server Error');
  }
});

const port = Number(process.env.PORT || 3007);
server.listen(port, '0.0.0.0', () => {
  console.log(`OAuth MCP Admin listening on ${port}`);
});
