import http from 'http';
import { randomUUID } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from './dist/services/mcp-server.js';
import { N8nClient } from './dist/services/n8n-client.js';

// Basic WebSocket transport implementing MCP Transport interface
class WebSocketServerTransport {
  constructor(ws) {
    this._ws = ws;
    this.sessionId = randomUUID();
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    this._ws.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(text);
        const parsed = JSONRPCMessageSchema.parse(msg);
        this.onmessage && this.onmessage(parsed, { requestInfo: {}, authInfo: undefined });
      } catch (err) {
        this.onerror && this.onerror(err);
      }
    });

    this._ws.on('close', () => {
      this.onclose && this.onclose();
    });

    this._ws.on('error', (err) => {
      this.onerror && this.onerror(err);
    });
  }

  async send(message) {
    if (this._ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    this._ws.send(JSON.stringify(message));
  }

  async close() {
    if (this._ws.readyState === WebSocket.OPEN) this._ws.close();
    this.onclose && this.onclose();
  }
}

// N8N Configuration (with runtime overrides)
const N8N_HOST = process.env.N8N_HOST || 'https://app.right-api.com';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
let CURRENT_N8N_HOST = N8N_HOST;
let CURRENT_N8N_API_KEY = N8N_API_KEY;

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

async function n8nRequest(endpoint, options = {}) {
  if (!CURRENT_N8N_API_KEY) {
    throw new Error('N8N_API_KEY is not set. Please export N8N_API_KEY in your environment.');
  }
  const url = `${CURRENT_N8N_HOST}/api/v1${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CURRENT_N8N_API_KEY}`,
      'X-N8N-API-KEY': CURRENT_N8N_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`N8N API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function createMCPServer() {
  const server = new Server(
    { name: 'n8n-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Register tools (parity with HTTP/SSE server)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const coreTools = core.getTools();
    const customTools = [
      { name: 'list_workflows', description: 'List all N8N workflows (alias)', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'retry_execution', description: 'Retry a specific execution', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'delete_execution', description: 'Delete a specific execution', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'list_credentials', description: 'List all credentials', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_credential', description: 'Get credential by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'create_credential', description: 'Create credential', inputSchema: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] } },
      { name: 'update_credential', description: 'Update credential', inputSchema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'object' } }, required: ['id', 'data'] } },
      { name: 'delete_credential', description: 'Delete credential', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'search', description: 'Search the web (DuckDuckGo)', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'number', default: 5 } }, required: ['query'] } },
      { name: 'retrieve', description: 'Retrieve and summarize a web page', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] } },
      { name: 'fetch', description: 'Fetch a result by id (or URL)', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Result id or URL' }, url: { type: 'string', description: 'URL to fetch (fallback)' } }, required: ['id'] } },
      { name: 'set_n8n_credentials', description: 'Set default n8n host and API key for this server session', inputSchema: { type: 'object', properties: { host: { type: 'string', description: 'n8n base URL' }, api_key: { type: 'string', description: 'n8n API key' }, test: { type: 'boolean', default: true } }, required: ['host', 'api_key'] } },
      { name: 'get_n8n_status', description: 'Get current n8n host/api key state', inputSchema: { type: 'object', properties: {}, required: [] } },
    ];

    return {
      tools: [...coreTools, ...customTools],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    const coreTools = new Set(core.getTools().map((tool) => tool.name));
    try {
      if (!name) throw new Error('Tool name is required');
      if (coreTools.has(name)) {
        return await core.callTool(name, args);
      }
      switch (name) {
        case 'get_workflows':
        case 'list_workflows': {
          const workflows = await n8nRequest('/workflows');
          return { content: [{ type: 'text', text: JSON.stringify(workflows, null, 2) }] };
        }
        case 'search': {
          const q = String(args?.query || '').trim();
          const max = Math.min(Math.max(Number(args?.max_results || 5), 1), 10);
          if (!q) throw new Error('query is required');
          const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`; 
          const rsp = await fetch(apiUrl, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
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
        case 'retrieve': {
          const target = String(args?.url || '').trim();
          if (!target) throw new Error('url is required');
          const rsp = await fetch(target, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
          const ct = rsp.headers.get('content-type') || '';
          const raw = await rsp.text();
          let text = raw;
          if (ct.includes('html')) {
            // naive HTML -> text extraction
            text = raw.replace(/<script[\s\S]*?<\/script>/gi, '')
                      .replace(/<style[\s\S]*?<\/style>/gi, '')
                      .replace(/<[^>]+>/g, ' ')
                      .replace(/\s+/g, ' ') 
                      .trim();
          }
          const out = text.length > 8000 ? text.slice(0, 8000) + '…' : text;
          return { content: [{ type: 'text', text: JSON.stringify({ url: target, contentType: ct, text: out }, null, 2) }] };
        }
        case 'fetch': {
          const target = String(args?.id || args?.url || '').trim();
          if (!target) throw new Error('id or url is required');
          const rsp = await fetch(target, { headers: { 'User-Agent': 'n8n-mcp/1.0' } });
          const ct = rsp.headers.get('content-type') || '';
          const raw = await rsp.text();
          return { content: [{ type: 'text', text: JSON.stringify({ url: target, contentType: ct, text: raw.slice(0, 8000) + (raw.length > 8000 ? '…' : '') }, null, 2) }] };
        }
        case 'set_n8n_credentials': {
          const host = String(args?.host || '').trim();
          const key = String(args?.api_key || '').trim();
          if (!host || !key) throw new Error('host and api_key are required');
          CURRENT_N8N_HOST = host;
          CURRENT_N8N_API_KEY = key;
          refreshCoreClient();
          let test = { ok: true };
          try { await n8nRequest('/health'); } catch (e) { test = { ok: false, error: e?.message || String(e) }; }
          return { content: [{ type: 'text', text: JSON.stringify({ host, apiKeySet: !!key, test }, null, 2) }] };
        }
        case 'get_n8n_status': {
          return { content: [{ type: 'text', text: JSON.stringify({ host: CURRENT_N8N_HOST, apiKeySet: !!CURRENT_N8N_API_KEY }, null, 2) }] };
        }
        case 'get_workflow': {
          const workflow = await n8nRequest(`/workflows/${args.id}`);
          return { content: [{ type: 'text', text: JSON.stringify(workflow, null, 2) }] };
        }
        case 'create_workflow': {
          const created = await n8nRequest('/workflows', { method: 'POST', body: JSON.stringify({ name: args.name, nodes: args.nodes, connections: args.connections, active: false }) });
          return { content: [{ type: 'text', text: `Workflow created successfully: ${JSON.stringify(created, null, 2)}` }] };
        }
        case 'update_workflow': {
          const payload = {};
          if (args.name !== undefined) payload.name = args.name;
          if (args.nodes !== undefined) payload.nodes = args.nodes;
          if (args.connections !== undefined) payload.connections = args.connections;
          if (args.active !== undefined) payload.active = args.active;
          const updated = await n8nRequest(`/workflows/${args.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
          return { content: [{ type: 'text', text: `Workflow updated: ${JSON.stringify(updated, null, 2)}` }] };
        }
        case 'delete_workflow': {
          await n8nRequest(`/workflows/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Workflow ${args.id} deleted successfully` }] };
        }
        case 'activate_workflow': {
          await n8nRequest(`/workflows/${args.id}/activate`, { method: 'POST' });
          return { content: [{ type: 'text', text: `Workflow ${args.id} activated successfully` }] };
        }
        case 'deactivate_workflow': {
          await n8nRequest(`/workflows/${args.id}/deactivate`, { method: 'POST' });
          return { content: [{ type: 'text', text: `Workflow ${args.id} deactivated successfully` }] };
        }
        case 'execute_workflow': {
          const execution = await n8nRequest(`/workflows/${args.id}/execute`, { method: 'POST', body: JSON.stringify(args.data || {}) });
          return { content: [{ type: 'text', text: JSON.stringify(execution, null, 2) }] };
        }
        case 'get_executions': {
          let execEndpoint = '/executions';
          if (args?.workflowId) execEndpoint += `?workflowId=${args.workflowId}`;
          if (args?.limit) execEndpoint += (args?.workflowId ? '&' : '?') + `limit=${args.limit}`;
          const executions = await n8nRequest(execEndpoint);
          return { content: [{ type: 'text', text: JSON.stringify(executions, null, 2) }] };
        }
        case 'get_execution': {
          const execution = await n8nRequest(`/executions/${args.id}`);
          return { content: [{ type: 'text', text: JSON.stringify(execution, null, 2) }] };
        }
        case 'retry_execution': {
          const retried = await n8nRequest(`/executions/${args.id}/retry`, { method: 'POST' });
          return { content: [{ type: 'text', text: JSON.stringify(retried, null, 2) }] };
        }
        case 'delete_execution': {
          await n8nRequest(`/executions/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Execution ${args.id} deleted successfully` }] };
        }
        case 'list_credentials': {
          const creds = await n8nRequest('/credentials');
          return { content: [{ type: 'text', text: JSON.stringify(creds, null, 2) }] };
        }
        case 'get_credential': {
          const cred = await n8nRequest(`/credentials/${args.id}`);
          return { content: [{ type: 'text', text: JSON.stringify(cred, null, 2) }] };
        }
        case 'create_credential': {
          const created = await n8nRequest('/credentials', { method: 'POST', body: JSON.stringify(args.data || {}) });
          return { content: [{ type: 'text', text: JSON.stringify(created, null, 2) }] };
        }
        case 'update_credential': {
          const updated = await n8nRequest(`/credentials/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.data || {}) });
          return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
        }
        case 'delete_credential': {
          await n8nRequest(`/credentials/${args.id}`, { method: 'DELETE' });
          return { content: [{ type: 'text', text: `Credential ${args.id} deleted successfully` }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  return server;
}

// HTTP + WebSocket server
const PORT = process.env.PORT || 3006;
const HOST = process.env.HOST || '0.0.0.0';

// CORS configuration for HTTP endpoints (WS upgrade path doesn't use CORS)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const allowedOrigins = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
function pickCorsOrigin(requestOrigin) {
  if (!allowedOrigins.length || allowedOrigins.includes('*')) return '*';
  if (!requestOrigin) return allowedOrigins[0];
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
}

const httpServer = http.createServer((req, res) => {
  const origin = pickCorsOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', server: 'n8n-mcp-ws', transport: 'websocket' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'N8N MCP Server',
    version: '1.0.0',
    description: 'N8N Model Context Protocol Server (WebSocket)',
    status: 'running',
    transport: 'WebSocket',
    endpoints: { ws: '/ws', health: '/health' },
  }));
});

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols /* Set<string> */, request) => {
    // Ensure the MCP subprotocol is negotiated
    try {
      if (protocols && typeof protocols.has === 'function' && protocols.has('mcp')) return 'mcp';
    } catch {}
    return false; // Reject if client doesn't speak MCP
  },
});

wss.on('connection', (ws) => {
  const mcpServer = createMCPServer();
  const transport = new WebSocketServerTransport(ws);
  mcpServer.connect(transport).catch((err) => {
    console.error('Error connecting MCP server over WS:', err);
    try { ws.close(); } catch {}
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  if (!url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`N8N MCP WebSocket Server running on ws://${HOST}:${PORT}/ws`);
  console.log(`Health: http://${HOST}:${PORT}/health`);
  if (!N8N_API_KEY) {
    console.warn('Warning: N8N_API_KEY is not set; API calls will fail.');
  }
});
