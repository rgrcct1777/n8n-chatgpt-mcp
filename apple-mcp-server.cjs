#!/usr/bin/env node
/**
 * Apple MCP Server
 * Gives AI assistants (Claude, ChatGPT, Copilot) control over your Apple apps:
 * - Calendar: create and list events
 * - Reminders: create, list, and complete reminders
 * - Notes: create and read notes
 * - Mail: send emails via Mail app
 * - Messages: send iMessages
 *
 * USAGE WITH CLAUDE DESKTOP:
 * Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "apple": {
 *       "command": "node",
 *       "args": ["/Users/richardgentry/Projects/n8n-chatgpt-mcp/apple-mcp-server.js"]
 *     }
 *   }
 * }
 *
 * USAGE AS HTTP SERVER (for ChatGPT / web):
 * node apple-mcp-server.js --http --port 3010
 */

'use strict';

const { execSync, exec } = require('child_process');
const http = require('http');

// ─── AppleScript helpers ──────────────────────────────────────────────────────

function runAppleScript(script) {
  try {
    const result = execSync(`osascript -e ${JSON.stringify(script)}`, {
      encoding: 'utf8',
      timeout: 15000,
    });
    return result.trim();
  } catch (err) {
    throw new Error(`AppleScript error: ${err.stderr || err.message}`);
  }
}

// ─── Tool implementations ──────────────────────────────────────────────────────

function apple_get_datetime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('en-US'),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function apple_calendar_create_event({ title, startDate, endDate, notes = '', calendarName = '' }) {
  if (!title) throw new Error('title is required');
  if (!startDate) throw new Error('startDate is required (e.g. "2026-05-10 14:00")');

  const start = new Date(startDate);
  const end = endDate ? new Date(endDate) : new Date(start.getTime() + 60 * 60 * 1000);

  const startStr = start.toLocaleString('en-US');
  const endStr = end.toLocaleString('en-US');

  const calClause = calendarName
    ? `set targetCal to calendar "${calendarName}"`
    : 'set targetCal to default calendar of application "Calendar"';

  const script = `
    tell application "Calendar"
      ${calClause}
      set newEvent to make new event at end of events of targetCal with properties {summary:"${title.replace(/"/g, '\\"')}", start date:date "${startStr}", end date:date "${endStr}", description:"${notes.replace(/"/g, '\\"')}"}
      return "Created event: ${title.replace(/"/g, '\\"')}"
    end tell
  `;
  const result = runAppleScript(script);
  return { message: result, title, startDate: startStr, endDate: endStr };
}

function apple_calendar_list_events({ days = 7, calendarName = '' } = {}) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const nowStr = now.toLocaleString('en-US');
  const futureStr = future.toLocaleString('en-US');

  const calClause = calendarName
    ? `set targetCals to {calendar "${calendarName}"}`
    : 'set targetCals to calendars';

  const script = `
    tell application "Calendar"
      ${calClause}
      set eventList to {}
      repeat with aCal in targetCals
        set calEvents to (every event of aCal whose start date >= date "${nowStr}" and start date <= date "${futureStr}")
        repeat with anEvent in calEvents
          set end of eventList to (summary of anEvent & " | " & (start date of anEvent as string))
        end repeat
      end repeat
      return eventList as string
    end tell
  `;
  const raw = runAppleScript(script);
  const events = raw ? raw.split(', ').filter(Boolean) : [];
  return { count: events.length, events, rangedays: days };
}

function apple_reminders_create({ title, dueDate = '', listName = '', notes = '' }) {
  if (!title) throw new Error('title is required');

  const dueLine = dueDate
    ? `set due date of newReminder to date "${new Date(dueDate).toLocaleString('en-US')}"`
    : '';

  const listClause = listName
    ? `set targetList to list "${listName}" of application "Reminders"`
    : 'set targetList to default list of application "Reminders"';

  const script = `
    tell application "Reminders"
      ${listClause}
      set newReminder to make new reminder at end of reminders of targetList with properties {name:"${title.replace(/"/g, '\\"')}", body:"${notes.replace(/"/g, '\\"')}"}
      ${dueLine}
      return "Created reminder: ${title.replace(/"/g, '\\"')}"
    end tell
  `;
  return { message: runAppleScript(script), title };
}

function apple_reminders_list({ listName = '', showCompleted = false } = {}) {
  const listClause = listName
    ? `set targetList to list "${listName}" of application "Reminders"`
    : 'set targetList to default list of application "Reminders"';

  const completedFilter = showCompleted ? '' : 'whose completed is false';

  const script = `
    tell application "Reminders"
      ${listClause}
      set reminderList to {}
      set theReminders to reminders ${completedFilter} of targetList
      repeat with r in theReminders
        set end of reminderList to (name of r)
      end repeat
      return reminderList as string
    end tell
  `;
  const raw = runAppleScript(script);
  const reminders = raw ? raw.split(', ').filter(Boolean) : [];
  return { count: reminders.length, reminders };
}

function apple_reminders_complete({ title, listName = '' }) {
  if (!title) throw new Error('title is required');

  const listClause = listName
    ? `set targetList to list "${listName}" of application "Reminders"`
    : 'set targetList to default list of application "Reminders"';

  const script = `
    tell application "Reminders"
      ${listClause}
      set theReminders to reminders whose name is "${title.replace(/"/g, '\\"')}" and completed is false
      if (count of theReminders) > 0 then
        set completed of (item 1 of theReminders) to true
        return "Marked complete: ${title.replace(/"/g, '\\"')}"
      else
        return "Reminder not found: ${title.replace(/"/g, '\\"')}"
      end if
    end tell
  `;
  return { message: runAppleScript(script) };
}

function apple_notes_create({ title, content, folderName = '' }) {
  if (!title) throw new Error('title is required');
  if (!content) throw new Error('content is required');

  const folderClause = folderName
    ? `set targetFolder to folder "${folderName}" of application "Notes"`
    : 'set targetFolder to default folder of application "Notes"';

  const script = `
    tell application "Notes"
      ${folderClause}
      make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:"<div><b>${title.replace(/"/g, '\\"')}</b></div><div>${content.replace(/"/g, '\\"').replace(/\n/g, '</div><div>')}</div>"}
      return "Created note: ${title.replace(/"/g, '\\"')}"
    end tell
  `;
  return { message: runAppleScript(script), title };
}

function apple_notes_list({ folderName = '' } = {}) {
  const folderClause = folderName
    ? `set targetFolder to folder "${folderName}" of application "Notes"`
    : 'set targetFolder to default folder of application "Notes"';

  const script = `
    tell application "Notes"
      ${folderClause}
      set noteList to {}
      repeat with n in notes of targetFolder
        set end of noteList to (name of n)
      end repeat
      return noteList as string
    end tell
  `;
  const raw = runAppleScript(script);
  const notes = raw ? raw.split(', ').filter(Boolean) : [];
  return { count: notes.length, notes };
}

function apple_mail_send({ to, subject, body, ccAddress = '' }) {
  if (!to) throw new Error('to (recipient email) is required');
  if (!subject) throw new Error('subject is required');
  if (!body) throw new Error('body is required');

  const ccLine = ccAddress ? `make new to recipient at end of cc recipients with properties {address:"${ccAddress}"}` : '';

  const script = `
    tell application "Mail"
      set newMsg to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:"${body.replace(/"/g, '\\"')}"}
      make new to recipient at end of to recipients of newMsg with properties {address:"${to}"}
      ${ccLine}
      send newMsg
      return "Email sent to ${to}"
    end tell
  `;
  return { message: runAppleScript(script), to, subject };
}

function apple_messages_send({ phoneOrEmail, message }) {
  if (!phoneOrEmail) throw new Error('phoneOrEmail is required');
  if (!message) throw new Error('message is required');

  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${phoneOrEmail}" of targetService
      send "${message.replace(/"/g, '\\"')}" to targetBuddy
      return "iMessage sent to ${phoneOrEmail}"
    end tell
  `;
  return { message: runAppleScript(script), to: phoneOrEmail };
}

function apple_open_app({ appName }) {
  if (!appName) throw new Error('appName is required');
  runAppleScript(`tell application "${appName}" to activate`);
  return { message: `Opened ${appName}` };
}

// ─── MCP tool registry ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'apple_get_datetime',
    description: 'Get the current date, time, and timezone from your Mac',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apple_calendar_create_event',
    description: 'Create a new event in Apple Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        startDate: { type: 'string', description: 'Start date/time, e.g. "2026-05-10 14:00"' },
        endDate: { type: 'string', description: 'End date/time (optional, defaults to 1 hour after start)' },
        notes: { type: 'string', description: 'Event notes/description' },
        calendarName: { type: 'string', description: 'Calendar name (uses default if omitted)' },
      },
      required: ['title', 'startDate'],
    },
  },
  {
    name: 'apple_calendar_list_events',
    description: 'List upcoming events from Apple Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days ahead to look (default 7)' },
        calendarName: { type: 'string', description: 'Specific calendar to check (all if omitted)' },
      },
    },
  },
  {
    name: 'apple_reminders_create',
    description: 'Create a new reminder in Apple Reminders',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title' },
        dueDate: { type: 'string', description: 'Due date/time, e.g. "2026-05-10 09:00" (optional)' },
        listName: { type: 'string', description: 'Reminders list name (uses default if omitted)' },
        notes: { type: 'string', description: 'Additional notes' },
      },
      required: ['title'],
    },
  },
  {
    name: 'apple_reminders_list',
    description: 'List pending reminders from Apple Reminders',
    inputSchema: {
      type: 'object',
      properties: {
        listName: { type: 'string', description: 'Specific list to check (default list if omitted)' },
        showCompleted: { type: 'boolean', description: 'Include completed reminders (default false)' },
      },
    },
  },
  {
    name: 'apple_reminders_complete',
    description: 'Mark a reminder as completed in Apple Reminders',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Exact reminder title to mark complete' },
        listName: { type: 'string', description: 'List name (default list if omitted)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'apple_notes_create',
    description: 'Create a new note in Apple Notes',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content (plain text)' },
        folderName: { type: 'string', description: 'Notes folder name (default folder if omitted)' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'apple_notes_list',
    description: 'List notes from Apple Notes',
    inputSchema: {
      type: 'object',
      properties: {
        folderName: { type: 'string', description: 'Specific folder to list (default folder if omitted)' },
      },
    },
  },
  {
    name: 'apple_mail_send',
    description: 'Send an email using Apple Mail',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
        ccAddress: { type: 'string', description: 'CC email address (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'apple_messages_send',
    description: 'Send an iMessage using the Messages app',
    inputSchema: {
      type: 'object',
      properties: {
        phoneOrEmail: { type: 'string', description: 'Phone number or Apple ID email of recipient' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['phoneOrEmail', 'message'],
    },
  },
  {
    name: 'apple_open_app',
    description: 'Open any Mac app by name',
    inputSchema: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'App name exactly as it appears in Applications, e.g. "Safari", "Notion", "Finder"' },
      },
      required: ['appName'],
    },
  },
];

// ─── Tool executor ─────────────────────────────────────────────────────────────

function callTool(name, args) {
  switch (name) {
    case 'apple_get_datetime':          return apple_get_datetime();
    case 'apple_calendar_create_event': return apple_calendar_create_event(args);
    case 'apple_calendar_list_events':  return apple_calendar_list_events(args);
    case 'apple_reminders_create':      return apple_reminders_create(args);
    case 'apple_reminders_list':        return apple_reminders_list(args);
    case 'apple_reminders_complete':    return apple_reminders_complete(args);
    case 'apple_notes_create':          return apple_notes_create(args);
    case 'apple_notes_list':            return apple_notes_list(args);
    case 'apple_mail_send':             return apple_mail_send(args);
    case 'apple_messages_send':         return apple_messages_send(args);
    case 'apple_open_app':              return apple_open_app(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP protocol handler ──────────────────────────────────────────────────────

function handleMcpRequest(req) {
  const { method, params, id } = req;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'apple-mcp-server', version: '1.0.0' },
        };
        break;
      case 'notifications/initialized':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const toolResult = callTool(toolName, toolArgs);
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
        break;
      }
      default:
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'Method not found' } };
    }
    return { jsonrpc: '2.0', id: id ?? null, result };
  } catch (err) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: String(err.message || err) } };
  }
}

// ─── Transport: STDIO (for Claude Desktop) ────────────────────────────────────

function runStdio() {
  process.stdout.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const req = JSON.parse(trimmed);
        const res = handleMcpRequest(req);
        process.stdout.write(JSON.stringify(res) + '\n');
      } catch {
        // ignore malformed JSON
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

// ─── Transport: HTTP + SSE (for ChatGPT / web) ────────────────────────────────

function runHttp(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'apple-mcp-server', version: '1.0.0' }));
      return;
    }

    if (url.pathname === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', server: 'apple-mcp-server' })}\n\n`);
      const hb = setInterval(() => res.write(': heartbeat\n\n'), 30000);
      res.on('close', () => clearInterval(hb));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const mcpReq = JSON.parse(body);
          const mcpRes = handleMcpRequest(mcpReq);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mcpRes));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`Apple MCP Server running on http://localhost:${port}`);
    console.log(`  Health: http://localhost:${port}/health`);
    console.log(`  MCP:    http://localhost:${port}/mcp (POST)`);
    console.log(`  SSE:    http://localhost:${port}/sse`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--http')) {
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3010;
  runHttp(port);
} else {
  runStdio();
}
