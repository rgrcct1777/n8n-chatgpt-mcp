import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcError, McpTool, McpToolResult, McpServerInfo, StreamingClient } from '../types/mcp';
import { N8nClient } from './n8n-client';
import { config } from '../config';

const NOTES_DIR = process.env.NOTES_DIR || path.join(process.cwd(), 'data', 'notes');
if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

export class McpServer extends EventEmitter {
  private n8nClient: N8nClient;
  private streamingClients: Map<string, StreamingClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  constructor(n8nClient?: N8nClient) {
    super();
    this.n8nClient = n8nClient ?? new N8nClient();
    this.startHeartbeat();
  }

  public setN8nClient(client: N8nClient): void {
    this.n8nClient = client;
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      for (const [clientId, client] of this.streamingClients.entries()) {
        const timeSinceLastHeartbeat = now.getTime() - client.lastHeartbeat.getTime();
        if (timeSinceLastHeartbeat > config.mcp.streamHeartbeatInterval * 2) {
          this.removeStreamingClient(clientId);
        } else {
          this.sendToClient(clientId, { type: 'heartbeat', timestamp: now.toISOString() });
        }
      }
    }, config.mcp.streamHeartbeatInterval);
  }

  public addStreamingClient(response: any): string {
    if (this.streamingClients.size >= config.mcp.maxStreamClients) {
      throw new Error('Maximum streaming clients reached');
    }

    const clientId = uuidv4();
    this.streamingClients.set(clientId, {
      id: clientId,
      response,
      lastHeartbeat: new Date(),
    });

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
    });

    response.on('close', () => {
      this.removeStreamingClient(clientId);
    });

    this.sendToClient(clientId, { type: 'connected', clientId });
    return clientId;
  }

  public removeStreamingClient(clientId: string): void {
    const client = this.streamingClients.get(clientId);
    if (client) {
      try {
        client.response.end();
      } catch (error) {
        // Client may have already disconnected
      }
      this.streamingClients.delete(clientId);
    }
  }

  private sendToClient(clientId: string, data: any): void {
    const client = this.streamingClients.get(clientId);
    if (client) {
      try {
        client.response.write(`data: ${JSON.stringify(data)}\n\n`);
        client.lastHeartbeat = new Date();
      } catch (error) {
        this.removeStreamingClient(clientId);
      }
    }
  }

  public broadcastToClients(data: any): void {
    for (const clientId of this.streamingClients.keys()) {
      this.sendToClient(clientId, data);
    }
  }

  public getServerInfo(): McpServerInfo {
    return {
      name: config.mcp.serverName,
      version: config.mcp.serverVersion,
    };
  }

  public getTools(): McpTool[] {
    const legacyTools: McpTool[] = [
      {
        name: 'get_workflows',
        description: 'Get all N8N workflows',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'get_workflow',
        description: 'Get a specific N8N workflow by ID',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'create_workflow',
        description: 'Create a new N8N workflow',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Workflow name' },
            nodes: { type: 'array', description: 'Workflow nodes' },
            connections: { type: 'object', description: 'Node connections' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Workflow tags' },
          },
          required: ['name', 'nodes', 'connections'],
        },
      },
      {
        name: 'update_workflow',
        description: 'Update an existing N8N workflow',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow ID' },
            name: { type: 'string', description: 'Workflow name' },
            nodes: { type: 'array', description: 'Workflow nodes' },
            connections: { type: 'object', description: 'Node connections' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Workflow tags' },
          },
          required: ['id'],
        },
      },
      {
        name: 'delete_workflow',
        description: 'Delete an N8N workflow',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'activate_workflow',
        description: 'Activate an N8N workflow',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'deactivate_workflow',
        description: 'Deactivate an N8N workflow',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'execute_workflow',
        description: 'Execute an N8N workflow',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow ID' },
            data: { type: 'object', description: 'Input data for workflow execution' },
          },
          required: ['id'],
        },
      },
      {
        name: 'get_executions',
        description: 'Get workflow execution history',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'Filter by workflow ID' },
            limit: { type: 'number', description: 'Maximum executions to return', default: 20 },
          },
          required: [],
        },
      },
      {
        name: 'get_execution',
        description: 'Get a specific workflow execution',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Execution ID' } },
          required: ['id'],
        },
      },
      {
        name: 'stop_execution',
        description: 'Stop a running workflow execution',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Execution ID' } },
          required: ['id'],
        },
      },
    ];

    const enhancedTools: McpTool[] = [
      {
        name: 'n8n_list_workflows',
        description: 'List workflows with optional filters (active, tags, pagination)',
        inputSchema: {
          type: 'object',
          properties: {
            active: { type: 'boolean', description: 'Filter by active status' },
            limit: { type: 'number', description: 'Maximum workflows to return' },
            offset: { type: 'number', description: 'Skip a number of workflows' },
            search: { type: 'string', description: 'Search by name' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
          },
        },
      },
      {
        name: 'n8n_get_workflow',
        description: 'Get a workflow by ID with full definition',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_get_workflow_details',
        description: 'Get workflow metadata including execution stats and usage',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_get_workflow_structure',
        description: 'Return only nodes and connections for a workflow',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_get_workflow_minimal',
        description: 'Return minimal workflow information (id, name, active, tags)',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_create_workflow',
        description: 'Create a workflow (alias of create_workflow)',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Workflow name' },
            nodes: { type: 'array', description: 'Workflow nodes' },
            connections: { type: 'object', description: 'Workflow connections' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Workflow tags' },
          },
          required: ['name', 'nodes', 'connections'],
        },
      },
      {
        name: 'n8n_update_full_workflow',
        description: 'Update workflow by replacing nodes, connections, and settings',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow ID' },
            name: { type: 'string', description: 'Workflow name' },
            nodes: { type: 'array', description: 'Complete workflow nodes' },
            connections: { type: 'object', description: 'Complete workflow connections' },
            settings: { type: 'object', description: 'Workflow settings' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Workflow tags' },
          },
          required: ['id'],
        },
      },
      {
        name: 'n8n_update_partial_workflow',
        description: 'Apply targeted operations to a workflow (add/update nodes, connections, settings)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow ID' },
            operations: { type: 'array', description: 'Array of operations to apply', items: { type: 'object' } },
            validateOnly: { type: 'boolean', description: 'Validate without saving changes' },
          },
          required: ['id', 'operations'],
        },
      },
      {
        name: 'n8n_delete_workflow',
        description: 'Delete a workflow (alias of delete_workflow)',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Workflow ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_execute_workflow',
        description: 'Execute a workflow by ID (alias of execute_workflow)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow ID' },
            workflowId: { type: 'string', description: 'Workflow ID (alternate field)' },
            data: { type: 'object', description: 'Payload for the execution' },
          },
          required: [],
        },
      },
      {
        name: 'n8n_list_executions',
        description: 'List executions with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'Filter by workflow ID' },
            limit: { type: 'number', description: 'Maximum executions to return' },
            status: { type: 'string', description: 'Filter by execution status' },
            lastId: { type: 'string', description: 'Pagination cursor (execution ID)' },
          },
        },
      },
      {
        name: 'n8n_get_execution',
        description: 'Get execution details by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Execution ID' },
            includeData: { type: 'boolean', description: 'Include execution data payload' },
          },
          required: ['id'],
        },
      },
      {
        name: 'n8n_delete_execution',
        description: 'Delete an execution permanently',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Execution ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_stop_execution',
        description: 'Stop a running execution',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Execution ID' } },
          required: ['id'],
        },
      },
      {
        name: 'n8n_health_check',
        description: 'Check n8n instance health and API connectivity',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'n8n_trigger_webhook_workflow',
        description: 'Trigger a workflow via webhook URL',
        inputSchema: {
          type: 'object',
          properties: {
            webhookUrl: { type: 'string', description: 'Full webhook URL' },
            httpMethod: { type: 'string', description: 'HTTP method to use (default POST)' },
            data: { type: 'object', description: 'Payload for webhook requests' },
            headers: { type: 'object', description: 'Additional request headers' },
            waitForResponse: { type: 'boolean', description: 'Wait for webhook response (default true)' },
          },
          required: ['webhookUrl'],
        },
      },
    ];

    const utilityTools: McpTool[] = [
      {
        name: 'utility_get_datetime',
        description: 'Get the current date, time, day of week, and timezone',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'utility_fetch_url',
        description: 'Fetch and return the text content of any URL or webpage',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch' },
            maxLength: { type: 'number', description: 'Max characters to return (default 5000)' },
          },
          required: ['url'],
        },
      },
      {
        name: 'utility_take_note',
        description: 'Save a note with a name and content for later retrieval',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name/title for the note (used as filename)' },
            content: { type: 'string', description: 'The note content to save' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'utility_list_notes',
        description: 'List all saved notes by name',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'utility_read_note',
        description: 'Read the content of a saved note by name',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name of the note to read' },
          },
          required: ['name'],
        },
      },
      {
        name: 'utility_delete_note',
        description: 'Delete a saved note by name',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name of the note to delete' },
          },
          required: ['name'],
        },
      },
    ];

    return [...legacyTools, ...enhancedTools, ...utilityTools];
  }

  public async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    console.log(`MCP Server handling request: ${request.method}`, request.params);
    
    try {
      let result: any;
      
      switch (request.method) {
        case 'initialize':
          result = this.handleInitialize();
          console.log('Initialize response:', JSON.stringify(result, null, 2));
          break;
        case 'notifications/initialized':
          result = {};
          console.log('Notifications/initialized acknowledged');
          break;
        case 'tools/list':
          result = this.handleToolsList();
          console.log('Tools list response:', JSON.stringify(result, null, 2));
          break;
        case 'tools/call':
          result = await this.handleToolsCall(request);
          break;
        default:
          console.log(`Unknown method: ${request.method}`);
          return this.createErrorResponse(request.id ?? null, -32601, 'Method not found');
      }

      const response: JsonRpcResponse = {
        jsonrpc: '2.0' as const,
        id: request.id ?? null,
        result: result,
      };
      
      return response;
    } catch (error) {
      console.error('MCP Server error:', error);
      return this.createErrorResponse(request.id ?? null, -32603, `Internal error: ${error}`);
    }
  }

  private handleInitialize(): any {
    this.initialized = true;
    return {
      protocolVersion: "2024-11-05",
      capabilities: { 
        tools: {}
      },
      serverInfo: {
        name: "n8n-mcp-server",
        version: "1.0.0"
      }
    };
  }

  private handleToolsList(): any {
    return {
      tools: this.getTools(),
    };
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<any> {
    const params = request.params ?? {};
    const name = params.name;
    if (typeof name !== 'string' || !name.length) {
      throw new Error('Tool name is required');
    }
    const args = params.arguments || {};

    return this.executeTool(name, args);
  }

  private async executeTool(name: string, args: any): Promise<McpToolResult> {
    switch (name) {
      case 'get_workflows':
        return await this.getWorkflows();
      case 'n8n_list_workflows':
        return await this.getWorkflows(args);
      case 'get_workflow':
        return await this.getWorkflow(args.id);
      case 'n8n_get_workflow':
        return await this.getWorkflow(args.id);
      case 'n8n_get_workflow_details':
        return await this.getWorkflowDetails(args.id);
      case 'n8n_get_workflow_structure':
        return await this.getWorkflowStructure(args.id);
      case 'n8n_get_workflow_minimal':
        return await this.getWorkflowMinimal(args.id);
      case 'create_workflow':
        return await this.createWorkflow(args);
      case 'n8n_create_workflow':
        return await this.createWorkflow(args);
      case 'update_workflow':
        return await this.updateWorkflow(args);
      case 'n8n_update_full_workflow':
        return await this.updateWorkflow(args);
      case 'n8n_update_partial_workflow':
        return await this.updateWorkflowPartial(args);
      case 'delete_workflow':
        return await this.deleteWorkflow(args.id);
      case 'n8n_delete_workflow':
        return await this.deleteWorkflow(args.id);
      case 'activate_workflow':
        return await this.activateWorkflow(args.id);
      case 'deactivate_workflow':
        return await this.deactivateWorkflow(args.id);
      case 'execute_workflow':
        return await this.executeWorkflow(args.id, args.data);
      case 'n8n_execute_workflow':
        return await this.executeWorkflow(args.id || args.workflowId, args.data);
      case 'get_executions':
        return await this.getExecutions(args);
      case 'n8n_list_executions':
        return await this.getExecutions(args);
      case 'get_execution':
        return await this.getExecution(args.id);
      case 'n8n_get_execution':
        return await this.getExecution(args.id, args.includeData);
      case 'stop_execution':
        return await this.stopExecution(args.id);
      case 'n8n_stop_execution':
        return await this.stopExecution(args.id);
      case 'n8n_delete_execution':
        return await this.deleteExecution(args.id);
      case 'n8n_health_check':
        return await this.healthCheck();
      case 'n8n_trigger_webhook_workflow':
        return await this.triggerWebhook(args);
      case 'utility_get_datetime':
        return this.utilityGetDatetime();
      case 'utility_fetch_url':
        return await this.utilityFetchUrl(args.url, args.maxLength);
      case 'utility_take_note':
        return this.utilityTakeNote(args.name, args.content);
      case 'utility_list_notes':
        return this.utilityListNotes();
      case 'utility_read_note':
        return this.utilityReadNote(args.name);
      case 'utility_delete_note':
        return this.utilityDeleteNote(args.name);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  public async callTool(name: string, args?: any): Promise<McpToolResult> {
    return this.executeTool(name, args ?? {});
  }

  private async getWorkflows(filters?: any): Promise<McpToolResult> {
    const params: any = {};
    if (filters) {
      if (typeof filters.active === 'boolean') params.active = filters.active;
      if (typeof filters.limit === 'number') params.limit = filters.limit;
      if (typeof filters.offset === 'number') params.offset = filters.offset;
      if (typeof filters.search === 'string') params.search = filters.search;
      if (Array.isArray(filters.tags)) params.tags = filters.tags;
    }

    const workflows = await this.n8nClient.getWorkflows(Object.keys(params).length ? params : undefined);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflows, null, 2),
      }],
    };
  }

  private async getWorkflow(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.getWorkflow(id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflow, null, 2),
      }],
    };
  }

  private async getWorkflowDetails(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.getWorkflowDetails(id);
    return {
      content: [{ type: 'text', text: JSON.stringify(workflow, null, 2) }],
    };
  }

  private async getWorkflowStructure(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.getWorkflow(id);
    const structure = {
      id: workflow.id,
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structure, null, 2) }],
    };
  }

  private async getWorkflowMinimal(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.getWorkflow(id);
    const minimal = {
      id: workflow.id,
      name: workflow.name,
      active: workflow.active,
      tags: workflow.tags || [],
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(minimal, null, 2) }],
    };
  }

  private async createWorkflow(args: any): Promise<McpToolResult> {
    const workflow = await this.n8nClient.createWorkflow(args);
    this.broadcastToClients({ type: 'workflow_created', workflow });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflow, null, 2),
      }],
    };
  }

  private async updateWorkflow(args: any): Promise<McpToolResult> {
    const { id, ...updates } = args;
    const workflow = await this.n8nClient.updateWorkflow(id, updates);
    this.broadcastToClients({ type: 'workflow_updated', workflow });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflow, null, 2),
      }],
    };
  }

  private async updateWorkflowPartial(args: any): Promise<McpToolResult> {
    const { id, operations, validateOnly } = args;
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('operations array is required for partial updates');
    }

    const workflow = await this.n8nClient.getWorkflow(id);
    const updatedWorkflow = JSON.parse(JSON.stringify(workflow));
    const appliedOperations: string[] = [];

    for (const operation of operations) {
      if (!operation || typeof operation.type !== 'string') {
        throw new Error('Each operation must include a type');
      }

      const type = operation.type;

      switch (type) {
        case 'updateName':
          if (typeof operation.name !== 'string') {
            throw new Error('updateName operation requires a name');
          }
          updatedWorkflow.name = operation.name;
          appliedOperations.push(`updateName:${operation.name}`);
          break;
        case 'updateSettings':
          if (typeof operation.settings !== 'object' || operation.settings === null) {
            throw new Error('updateSettings operation requires a settings object');
          }
          updatedWorkflow.settings = {
            ...(updatedWorkflow.settings || {}),
            ...operation.settings,
          };
          appliedOperations.push('updateSettings');
          break;
        case 'addTag':
          if (typeof operation.tag !== 'string') {
            throw new Error('addTag operation requires a tag');
          }
          updatedWorkflow.tags = Array.from(new Set([...(updatedWorkflow.tags || []), operation.tag]));
          appliedOperations.push(`addTag:${operation.tag}`);
          break;
        case 'removeTag':
          if (typeof operation.tag !== 'string') {
            throw new Error('removeTag operation requires a tag');
          }
          updatedWorkflow.tags = (updatedWorkflow.tags || []).filter((tag: string) => tag !== operation.tag);
          appliedOperations.push(`removeTag:${operation.tag}`);
          break;
        case 'addNode':
          if (!operation.node || typeof operation.node !== 'object') {
            throw new Error('addNode operation requires a node object');
          }
          updatedWorkflow.nodes.push(operation.node);
          appliedOperations.push(`addNode:${operation.node.name || operation.node.id}`);
          break;
        case 'removeNode':
          if (!operation.nodeId && !operation.nodeName) {
            throw new Error('removeNode requires nodeId or nodeName');
          }
          this.removeNode(updatedWorkflow, operation.nodeId, operation.nodeName);
          appliedOperations.push(`removeNode:${operation.nodeId || operation.nodeName}`);
          break;
        case 'moveNode':
          if (!Array.isArray(operation.position) || operation.position.length !== 2) {
            throw new Error('moveNode requires a position array [x, y]');
          }
          this.updateNode(updatedWorkflow, operation, (node) => {
            node.position = operation.position;
          });
          appliedOperations.push(`moveNode:${operation.nodeId || operation.nodeName}`);
          break;
        case 'enableNode':
        case 'disableNode':
          this.updateNode(updatedWorkflow, operation, (node) => {
            node.disabled = type === 'disableNode';
          });
          appliedOperations.push(`${type}:${operation.nodeId || operation.nodeName}`);
          break;
        case 'updateNode':
          if (!operation.updates || typeof operation.updates !== 'object') {
            throw new Error('updateNode requires an updates object');
          }
          this.updateNode(updatedWorkflow, operation, (node) => {
            for (const [key, value] of Object.entries(operation.updates)) {
              this.setDeepValue(node, key, value);
            }
          });
          appliedOperations.push(`updateNode:${operation.nodeId || operation.nodeName}`);
          break;
        case 'addConnection':
          this.addConnection(updatedWorkflow, operation);
          appliedOperations.push(`addConnection:${operation.source}->${operation.target}`);
          break;
        case 'removeConnection':
          this.removeConnection(updatedWorkflow, operation);
          appliedOperations.push(`removeConnection:${operation.source}->${operation.target}`);
          break;
        default:
          throw new Error(`Unsupported operation type: ${type}`);
      }
    }

    if (validateOnly) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id,
            message: 'operations validated successfully (no changes persisted)',
            operations: appliedOperations,
          }, null, 2),
        }],
      };
    }

    const saved = await this.n8nClient.updateWorkflow(id, {
      name: updatedWorkflow.name,
      nodes: updatedWorkflow.nodes,
      connections: updatedWorkflow.connections,
      settings: updatedWorkflow.settings,
      tags: updatedWorkflow.tags,
    });

    this.broadcastToClients({ type: 'workflow_updated', workflow: saved });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          workflow: saved,
          operations: appliedOperations,
        }, null, 2),
      }],
    };
  }

  private async deleteWorkflow(id: string): Promise<McpToolResult> {
    await this.n8nClient.deleteWorkflow(id);
    this.broadcastToClients({ type: 'workflow_deleted', workflowId: id });
    return {
      content: [{
        type: 'text',
        text: `Workflow ${id} deleted successfully`,
      }],
    };
  }

  private async activateWorkflow(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.activateWorkflow(id);
    this.broadcastToClients({ type: 'workflow_activated', workflow });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflow, null, 2),
      }],
    };
  }

  private async deactivateWorkflow(id: string): Promise<McpToolResult> {
    const workflow = await this.n8nClient.deactivateWorkflow(id);
    this.broadcastToClients({ type: 'workflow_deactivated', workflow });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(workflow, null, 2),
      }],
    };
  }

  private async executeWorkflow(id: string, data?: any): Promise<McpToolResult> {
    if (!id) {
      throw new Error('Workflow id is required');
    }
    const execution = await this.n8nClient.executeWorkflow(id, data);
    this.broadcastToClients({ type: 'workflow_executed', execution });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(execution, null, 2),
      }],
    };
  }

  private async getExecutions(filters?: any): Promise<McpToolResult> {
    let params: any = undefined;
    if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
      params = { ...filters };
    } else if (typeof filters === 'string') {
      params = { workflowId: filters };
    }
    const executions = await this.n8nClient.getExecutions(params);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(executions, null, 2),
      }],
    };
  }

  private async getExecution(id: string, includeData?: boolean): Promise<McpToolResult> {
    const execution = await this.n8nClient.getExecution(id, includeData === true);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(execution, null, 2),
      }],
    };
  }

  private async stopExecution(id: string): Promise<McpToolResult> {
    const execution = await this.n8nClient.stopExecution(id);
    this.broadcastToClients({ type: 'execution_stopped', execution });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(execution, null, 2),
      }],
    };
  }

  private async deleteExecution(id: string): Promise<McpToolResult> {
    await this.n8nClient.deleteExecution(id);
    this.broadcastToClients({ type: 'execution_deleted', executionId: id });
    return {
      content: [{
        type: 'text',
        text: `Execution ${id} deleted successfully`,
      }],
    };
  }

  private async healthCheck(): Promise<McpToolResult> {
    const status = await this.n8nClient.healthCheck();
    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
    };
  }

  private async triggerWebhook(args: any): Promise<McpToolResult> {
    if (!args?.webhookUrl) {
      throw new Error('webhookUrl is required');
    }
    const result = await this.n8nClient.triggerWebhook(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private updateNode(workflow: any, operation: any, mutate: (node: any) => void): void {
    const target = this.findNode(workflow, operation.nodeId, operation.nodeName);
    if (!target) {
      throw new Error(`Node not found: ${operation.nodeId || operation.nodeName}`);
    }
    mutate(target);
  }

  private findNode(workflow: any, nodeId?: string, nodeName?: string): any | undefined {
    return workflow.nodes.find((node: any) => {
      if (nodeId && node.id === nodeId) return true;
      if (nodeName && node.name === nodeName) return true;
      return false;
    });
  }

  private removeNode(workflow: any, nodeId?: string, nodeName?: string): void {
    const target = this.findNode(workflow, nodeId, nodeName);
    if (!target) {
      throw new Error(`Node not found: ${nodeId || nodeName}`);
    }

    workflow.nodes = workflow.nodes.filter((node: any) => node !== target);

    const name = target.name;
    const connections = workflow.connections || {};

    // Remove outgoing connections
    if (connections[name]) {
      delete connections[name];
    }

    // Remove incoming connections
    for (const source of Object.keys(connections)) {
      const outputs = connections[source];
      for (const outputName of Object.keys(outputs)) {
        outputs[outputName] = outputs[outputName]
          .map((branch: any[]) => branch.filter((entry) => entry.node !== name))
          .filter((branch: any[]) => branch.length > 0);

        if (outputs[outputName].length === 0) {
          delete outputs[outputName];
        }
      }

      if (Object.keys(outputs).length === 0) {
        delete connections[source];
      }
    }
  }

  private addConnection(workflow: any, operation: any): void {
    const { source, target } = operation;
    if (!source || !target) {
      throw new Error('addConnection requires source and target');
    }

    const sourceOutput = operation.sourceOutput || 'main';
    const targetInput = operation.targetInput || 'main';
    const outputIndex = typeof operation.outputIndex === 'number' ? operation.outputIndex : 0;

    workflow.connections = workflow.connections || {};
    workflow.connections[source] = workflow.connections[source] || {};
    const output = workflow.connections[source][sourceOutput] || [];

    while (output.length <= outputIndex) {
      output.push([]);
    }

    const branch = output[outputIndex];
    const exists = branch.some((connection: any) => connection.node === target && connection.type === targetInput);
    if (!exists) {
      branch.push({ node: target, type: targetInput, index: operation.targetIndex || 0 });
    }

    workflow.connections[source][sourceOutput] = output;
  }

  private removeConnection(workflow: any, operation: any): void {
    const { source, target } = operation;
    if (!source || !target) {
      throw new Error('removeConnection requires source and target');
    }

    const sourceOutput = operation.sourceOutput || 'main';
    const targetInput = operation.targetInput || 'main';

    const connections = workflow.connections || {};
    const outputs = connections[source];
    if (!outputs || !outputs[sourceOutput]) {
      return;
    }

    outputs[sourceOutput] = outputs[sourceOutput]
      .map((branch: any[]) => branch.filter((connection) => {
        return !(connection.node === target && (connection.type || 'main') === targetInput);
      }))
      .filter((branch: any[]) => branch.length > 0);

    if (outputs[sourceOutput].length === 0) {
      delete outputs[sourceOutput];
    }

    if (Object.keys(outputs).length === 0) {
      delete connections[source];
    }
  }

  private setDeepValue(target: any, path: string, value: any): void {
    const segments = path.split('.');
    let current = target;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (i === segments.length - 1) {
        current[segment] = value;
      } else {
        if (typeof current[segment] !== 'object' || current[segment] === null) {
          current[segment] = {};
        }
        current = current[segment];
      }
    }
  }

  private utilityGetDatetime(): McpToolResult {
    const now = new Date();
    const result = {
      iso: now.toISOString(),
      date: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unixTimestamp: Math.floor(now.getTime() / 1000),
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private async utilityFetchUrl(url: string, maxLength = 5000): Promise<McpToolResult> {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RightAPI-MCP/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || '';
    let text = await response.text();
    if (contentType.includes('text/html')) {
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                 .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\s{2,}/g, ' ')
                 .trim();
    }
    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + `\n\n[truncated — ${text.length - maxLength} more characters]`;
    }
    return { content: [{ type: 'text', text }] };
  }

  private utilityTakeNote(name: string, content: string): McpToolResult {
    const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim();
    const filePath = path.join(NOTES_DIR, `${safeName}.txt`);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(filePath, `# ${name}\nSaved: ${timestamp}\n\n${content}`, 'utf8');
    return { content: [{ type: 'text', text: `Note "${name}" saved successfully.` }] };
  }

  private utilityListNotes(): McpToolResult {
    const files = fs.existsSync(NOTES_DIR)
      ? fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.txt')).map(f => f.replace('.txt', ''))
      : [];
    const text = files.length > 0
      ? `Saved notes (${files.length}):\n${files.map(f => `  - ${f}`).join('\n')}`
      : 'No notes saved yet.';
    return { content: [{ type: 'text', text }] };
  }

  private utilityReadNote(name: string): McpToolResult {
    const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim();
    const filePath = path.join(NOTES_DIR, `${safeName}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Note "${name}" not found. Use utility_list_notes to see available notes.`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { content: [{ type: 'text', text: content }] };
  }

  private utilityDeleteNote(name: string): McpToolResult {
    const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim();
    const filePath = path.join(NOTES_DIR, `${safeName}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Note "${name}" not found.`);
    }
    fs.unlinkSync(filePath);
    return { content: [{ type: 'text', text: `Note "${name}" deleted.` }] };
  }

  private createErrorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    };
  }

  public destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const clientId of this.streamingClients.keys()) {
      this.removeStreamingClient(clientId);
    }
  }
}
