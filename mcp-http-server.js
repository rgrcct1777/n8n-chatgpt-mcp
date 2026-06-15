import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { McpServer } from './dist/services/mcp-server.js';
import { N8nClient } from './dist/services/n8n-client.js';

// N8N Configuration (with runtime overrides + persistence)
const N8N_HOST = process.env.N8N_HOST || 'https://app.right-api.com';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
let CURRENT_N8N_HOST = N8N_HOST;
let CURRENT_N8N_API_KEY = N8N_API_KEY;

// Persistent storage for credentials (shared with OAuth server)
const DATA_DIR = '/app/data';
const CRED_FILE = path.join(DATA_DIR, 'n8n-credentials.json');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

function loadSavedCredentials() {
  try {
    if (fs.existsSync(CRED_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
      if (saved.host && saved.api_key) {
        CURRENT_N8N_HOST = saved.host;
        CURRENT_N8N_API_KEY = saved.api_key;
        console.log('[SSE] Loaded persisted n8n credentials');
      }
    }
  } catch (e) {
    console.warn('[SSE] Failed to load saved credentials:', e?.message || String(e));
  }
}

function saveCredentials(host, key) {
  try {
    fs.writeFileSync(CRED_FILE, JSON.stringify({ host, api_key: key, savedAt: new Date().toISOString() }, null, 2));
    console.log('[SSE] Persisted n8n credentials');
  } catch (e) {
    console.warn('[SSE] Failed to persist credentials:', e?.message || String(e));
  }
}

// Load any saved credentials on startup
loadSavedCredentials();

const core = new McpServer(new N8nClient({
  baseUrl: CURRENT_N8N_HOST,
  apiKey: CURRENT_N8N_API_KEY,
}));

function refreshCoreClient() {
  core.setN8nClient(new N8nClient({
    baseUrl: CURRENT_N8N_HOST,
    apiKey: CURRENT_N8N_API_KEY,
  }));
}

// Simple N8N API client
async function n8nRequest(endpoint, options = {}) {
  const url = `${CURRENT_N8N_HOST}/api/v1${endpoint}`;
  
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${CURRENT_N8N_API_KEY}`,
      'X-N8N-API-KEY': CURRENT_N8N_API_KEY,
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });
  
  if (!response.ok) {
    throw new Error(`N8N API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

// Create MCP server
function createMCPServer() {
  const server = new Server(
    {
      name: "n8n-mcp-server",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const coreTools = core.getTools();
    const customTools = [
      {
        name: 'list_workflows',
        description: 'List all N8N workflows (alias)',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      { name: 'retry_execution', description: 'Retry an execution', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'delete_execution', description: 'Delete an execution', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'list_credentials', description: 'List all credentials', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_credential', description: 'Get credential by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'create_credential', description: 'Create credential', inputSchema: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] } },
      { name: 'update_credential', description: 'Update credential', inputSchema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'object' } }, required: ['id', 'data'] } },
      { name: 'delete_credential', description: 'Delete credential', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      {
        name: 'search',
        description: 'Search the web (DuckDuckGo)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            max_results: { type: 'number', default: 5 },
          },
          required: ['query'],
        },
      },
      {
        name: 'retrieve',
        description: 'Retrieve and summarize a web page',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL to fetch' } },
          required: ['url'],
        },
      },
      {
        name: 'fetch',
        description: 'Fetch a result by id (or URL)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Result id or URL' },
            url: { type: 'string', description: 'URL to fetch (fallback)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'set_n8n_credentials',
        description: 'Set default n8n host and API key for this server session',
        inputSchema: {
          type: 'object',
          properties: {
            host: { type: 'string', description: 'n8n base URL (e.g. https://app.right-api.com)' },
            api_key: { type: 'string', description: 'n8n API key' },
            test: { type: 'boolean', description: 'Test connection after setting', default: true },
          },
          required: ['host', 'api_key'],
        },
      },
      {
        name: 'get_n8n_status',
        description: 'Get current n8n host and whether API key is configured',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ];

    return {
      tools: [...coreTools, ...customTools],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    const coreTools = new Set(core.getTools().map((tool) => tool.name));

    try {
      if (!name) {
        throw new Error('Tool name is required');
      }

      if (coreTools.has(name)) {
        return await core.callTool(name, args);
      }

      switch (name) {
        case "get_workflows":
        case "list_workflows":
          const workflows = await n8nRequest('/workflows');
          return {
            content: [{
              type: "text",
              text: JSON.stringify(workflows, null, 2)
            }]
          };
          
        case "get_workflow":
          const workflow = await n8nRequest(`/workflows/${args.id}`);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(workflow, null, 2)
            }]
          };
          
        case "create_workflow":
          const created = await n8nRequest('/workflows', {
            method: 'POST',
            body: JSON.stringify({
              name: args.name,
              nodes: args.nodes,
              connections: args.connections,
              active: false
            })
          });
          return {
            content: [{
              type: "text",
              text: `Workflow created successfully: ${JSON.stringify(created, null, 2)}`
            }]
          };
          
        case "activate_workflow":
          await n8nRequest(`/workflows/${args.id}/activate`, { method: 'POST' });
          return {
            content: [{
              type: "text",
              text: `Workflow ${args.id} activated successfully`
            }]
          };
          
        case "deactivate_workflow":
          await n8nRequest(`/workflows/${args.id}/deactivate`, { method: 'POST' });
          return {
            content: [{
              type: "text",
              text: `Workflow ${args.id} deactivated successfully`
            }]
          };
          
        case "execute_workflow":
          const execution = await n8nRequest(`/workflows/${args.id}/execute`, {
            method: 'POST',
            body: JSON.stringify(args.data || {})
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify(execution, null, 2)
            }]
          };
        case "update_workflow":
          const payload = {};
          if (args.name !== undefined) payload.name = args.name;
          if (args.nodes !== undefined) payload.nodes = args.nodes;
          if (args.connections !== undefined) payload.connections = args.connections;
          if (args.active !== undefined) payload.active = args.active;
          const updated = await n8nRequest(`/workflows/${args.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
          return { content: [{ type: 'text', text: `Workflow updated: ${JSON.stringify(updated, null, 2)}` }] };
        case "delete_workflow":
          await n8nRequest(`/workflows/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Workflow ${args.id} deleted successfully` }] };
          
        case "get_executions":
          let execEndpoint = '/executions';
          if (args.workflowId) {
            execEndpoint += `?workflowId=${args.workflowId}`;
          }
          if (args.limit) {
            execEndpoint += (args.workflowId ? '&' : '?') + `limit=${args.limit}`;
          }
          const executions = await n8nRequest(execEndpoint);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(executions, null, 2)
            }]
          };
        case "get_execution":
          const exec = await n8nRequest(`/executions/${args.id}`);
          return { content: [{ type: 'text', text: JSON.stringify(exec, null, 2) }] };
        case "retry_execution":
          const retried = await n8nRequest(`/executions/${args.id}/retry`, { method: 'POST' });
          return { content: [{ type: 'text', text: JSON.stringify(retried, null, 2) }] };
        case "delete_execution":
          await n8nRequest(`/executions/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Execution ${args.id} deleted successfully` }] };
        case "list_credentials":
          const creds = await n8nRequest('/credentials');
          return { content: [{ type: 'text', text: JSON.stringify(creds, null, 2) }] };
        case "get_credential":
          const cred = await n8nRequest(`/credentials/${args.id}`);
          return { content: [{ type: 'text', text: JSON.stringify(cred, null, 2) }] };
        case "create_credential":
          const cCreated = await n8nRequest('/credentials', { method: 'POST', body: JSON.stringify(args.data || {}) });
          return { content: [{ type: 'text', text: JSON.stringify(cCreated, null, 2) }] };
        case "update_credential":
          const cUpdated = await n8nRequest(`/credentials/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) });
          return { content: [{ type: 'text', text: JSON.stringify(cUpdated, null, 2) }] };
        case "delete_credential":
          await n8nRequest(`/credentials/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Credential ${args.id} deleted successfully` }] };
        case "set_n8n_credentials": {
          const host = String(args?.host || '').trim();
          const key = String(args?.api_key || '').trim();
          if (!host || !key) throw new Error('host and api_key are required');
          CURRENT_N8N_HOST = host;
          CURRENT_N8N_API_KEY = key;
          refreshCoreClient();
          let testResult = { ok: true };
          if (args?.test !== false) {
            try { await n8nRequest('/health'); } catch (e) { testResult = { ok: false, error: e?.message || String(e) }; }
          }
          saveCredentials(host, key);
          return { content: [{ type: 'text', text: JSON.stringify({ host, apiKeySet: !!key, persisted: true, test: testResult }, null, 2) }] };
        }
        case "get_n8n_status": {
          return { content: [{ type: 'text', text: JSON.stringify({ host: CURRENT_N8N_HOST, apiKeySet: !!CURRENT_N8N_API_KEY }, null, 2) }] };
        }
        case "search": {
          const q = String(args?.query || '').trim();
          const max = Math.min(Math.max(Number(args?.max_results || 5), 1), 10);
          if (!q) throw new Error('query is required');
          const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
          const fetchMod = (await import('node-fetch')).default;
          const rsp = await fetchMod(apiUrl, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
          if (!rsp.ok) throw new Error(`search http ${rsp.status}`);
          const data = await rsp.json();
          const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
          const flatten = (arr) => arr.flatMap(t => t.Topics ? t.Topics : [t]);
          const items = flatten(topics).filter(it => it.FirstURL).slice(0, max).map(it => ({
            id: it.FirstURL,
            title: it.Text || it.Result || it.FirstURL,
            url: it.FirstURL,
            snippet: it.Text || ''
          }));
          return { content: [{ type: 'text', text: JSON.stringify({ query: q, results: items }, null, 2) }] };
        }
        case "retrieve": {
          const target = String(args?.url || '').trim();
          if (!target) throw new Error('url is required');
          const fetchMod = (await import('node-fetch')).default;
          const rsp = await fetchMod(target, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
          const ct = rsp.headers.get('content-type') || '';
          const raw = await rsp.text();
          let text = raw;
          if (ct.includes('html')) {
            text = raw.replace(/<script[\s\S]*?<\/script>/gi, '')
                      .replace(/<style[\s\S]*?<\/style>/gi, '')
                      .replace(/<[^>]+>/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim();
          }
          const out = text.length > 8000 ? text.slice(0, 8000) + '…' : text;
          return { content: [{ type: 'text', text: JSON.stringify({ url: target, contentType: ct, text: out }, null, 2) }] };
        }
        case "fetch": {
          const target = String(args?.id || args?.url || '').trim();
          if (!target) throw new Error('id or url is required');
          const fetchMod = (await import('node-fetch')).default;
          const rsp = await fetchMod(target, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
          const ct = rsp.headers.get('content-type') || '';
          const raw = await rsp.text();
          return { content: [{ type: 'text', text: JSON.stringify({ url: target, contentType: ct, text: raw.slice(0, 8000) + (raw.length > 8000 ? '…' : '') }, null, 2) }] };
        }
          
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error.message}`
        }],
        isError: true
      };
    }
  });

  return server;
}

// CORS configuration
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const allowedOrigins = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
function pickCorsOrigin(requestOrigin) {
  if (!allowedOrigins.length || allowedOrigins.includes('*')) return '*';
  if (!requestOrigin) return allowedOrigins[0];
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
}

// Track active SSE transports by session ID for routing POST messages
const activeSseTransports = new Map();

// Create HTTP server with MCP SSE transport
const httpServer = http.createServer(async (req, res) => {
  // Basic request logging
  try { console.log(`[SSE] ${req.method} ${req.url}`); } catch {}

  // CORS headers (tightened by CORS_ORIGIN)
  const origin = pickCorsOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  
  if (req.method === 'GET' && (req.headers.accept?.includes('text/event-stream') || parsedUrl.pathname === '/sse')) {
    // SSE connection for MCP
    console.log('SSE connection established');
    // Optional: accept n8n credentials via query string for zero-UI configuration
    const q = parsedUrl.query || {};
    const qHost = typeof q.n8n_host === 'string' ? q.n8n_host.trim() : '';
    const qKey = typeof q.n8n_key === 'string' ? q.n8n_key.trim() : '';
    if (qHost && qKey) {
      try {
        CURRENT_N8N_HOST = qHost;
        CURRENT_N8N_API_KEY = qKey;
        refreshCoreClient();
        saveCredentials(qHost, qKey);
        console.log('[SSE] Applied n8n credentials from query params');
      } catch (e) {
        console.warn('[SSE] Failed applying query credentials:', e?.message || String(e));
      }
    }
    const server = createMCPServer();
    const transport = new SSEServerTransport('/sse/message', res);
    await server.connect(transport);
    // Store transport for subsequent POST routing
    activeSseTransports.set(transport.sessionId, transport);
    transport.onclose = () => {
      activeSseTransports.delete(transport.sessionId);
    };
    return;
  }
  
  if (req.method === 'POST' && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/sse/message' || parsedUrl.pathname === '/message')) {
    // Route POST to the correct SSE transport by sessionId
    const sessionId = parsedUrl.query?.sessionId || req.headers['mcp-session-id'] || req.headers['last-event-id'];
    try { console.log(`[SSE] POST ${parsedUrl.pathname} sessionId=${sessionId}`); } catch {}
    if (!sessionId) {
      try { console.warn('[SSE] POST missing sessionId'); } catch {}
      res.writeHead(400).end('Missing sessionId');
      return;
    }
    const transport = activeSseTransports.get(sessionId);
    if (!transport) {
      try { console.warn(`[SSE] POST unknown sessionId=${sessionId}`); } catch {}
      res.writeHead(404).end('Unknown sessionId');
      return;
    }
    try {
      await transport.handlePostMessage(req, res);
      try { console.log(`[SSE] POST handled for sessionId=${sessionId}`); } catch {}
    } catch (err) {
      console.error('Error handling MCP POST:', err?.message || err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Internal Server Error');
    }
    return;
  }
  
  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    // Health check
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', server: 'n8n-mcp-server' }));
    return;
  }

  // OAuth configuration endpoint expected by some clients (e.g., ChatGPT Connectors)
  if (req.method === 'GET' && (parsedUrl.pathname === '/oauth/config' || parsedUrl.pathname === '/oauth/providers')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // No OAuth providers configured for SSE connection; API access is via server-side key
    res.end(JSON.stringify({ providers: [] }));
    return;
  }

  // OAuth discovery (well-known) for clients that probe on the SSE host
  if (req.method === 'GET' && parsedUrl.pathname === '/.well-known/oauth-authorization-server') {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || req.headers['x-forwarded-host'] || 'localhost:3004';
    const base = `${proto}://${host}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    }));
    return;
  }
  
  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'N8N MCP Server',
    version: '1.0.0',
    description: 'N8N Model Context Protocol Server',
    status: 'running',
    transport: 'SSE',
    oauth: { providers: [] },
    endpoints: {
      health: '/health',
      sse: 'Connect with Accept: text/event-stream at /sse',
      post: '/sse/message'
    }
  }));
});

const PORT = process.env.PORT || 3004;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`N8N MCP Server running on port ${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`MCP endpoint: SSE connection to http://0.0.0.0:${PORT}/`);
});
