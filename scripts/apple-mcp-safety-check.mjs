#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.APPLE_MCP_TEST_PORT || 3011);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function startServer() {
  return spawn(process.execPath, ['apple-mcp-server.cjs', '--http', '--port', String(PORT)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      APPLE_MCP_ALLOW_EXTERNAL_SEND: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(server) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Apple MCP server exited early with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Apple MCP server did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function callTool(name, args) {
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${name} returned MCP error: ${payload.error.message}`);
  }
  return JSON.parse(payload.result.content[0].text);
}

function assertNotSent(kind, result) {
  if (result.status !== 'confirmation_required' || result.delivery !== 'not_sent') {
    throw new Error(`${kind} safety check failed: ${JSON.stringify(result)}`);
  }
}

async function main() {
  const server = startServer();
  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(server);

    const emailResult = await callTool('apple_mail_send', {
      to: 'test@example.com',
      subject: 'Safety check',
      body: 'This must not send.',
      confirmSend: true,
    });
    assertNotSent('email', emailResult);

    const messageResult = await callTool('apple_messages_send', {
      phoneOrEmail: 'test@example.com',
      message: 'This must not send.',
      confirmSend: true,
    });
    assertNotSent('iMessage', messageResult);

    console.log('Apple MCP safety check passed: Mail and Messages did not send by default.');
  } finally {
    server.kill('SIGTERM');
    await delay(100);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
