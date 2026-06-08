#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const LM_STUDIO_URL = (process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
const MODEL = process.env.LM_STUDIO_MODEL || 'google/gemma-4-e4b';
const MAX_TOOL_ROUNDS = Number(process.env.LM_AGENT_MAX_TOOL_ROUNDS || 6);

const tools = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List tracked and normal untracked files in this repository. Does not include node_modules, .git, or build output.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum file paths to return.',
            default: 80,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_search',
      description: 'Search this repository using a literal text query. Returns matching file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Literal text to search for.',
          },
          limit: {
            type: 'number',
            description: 'Maximum result lines to return.',
            default: 25,
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a non-secret file from this repository. Paths must stay inside the repo.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Repository-relative path to read.',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters to return.',
            default: 16000,
          },
        },
        required: ['file_path'],
      },
    },
  },
];

const messages = [
  {
    role: 'system',
    content: [
      'You are a local AI agent running through LM Studio.',
      `Repository root: ${REPO_ROOT}`,
      'Use the available read-only tools when you need repo context.',
      'Do not ask to delete, move, expose, or modify files. You can recommend changes, but this agent only reads.',
      'Never request or reveal secrets, tokens, API keys, passwords, credential files, or .env files.',
      'Keep answers practical and concise.',
    ].join('\n'),
  },
];

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isInsideRepo(candidate) {
  const resolved = path.resolve(REPO_ROOT, candidate);
  return resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`);
}

function isBlockedPath(candidate) {
  const normalized = candidate.split(path.sep).join('/').toLowerCase();
  const base = path.basename(normalized);
  if (base === '.env' || base.startsWith('.env.')) return true;
  return [
    'secret',
    'secrets',
    'credential',
    'credentials',
    'password',
    'passwd',
    'token',
    'api_key',
    'apikey',
  ].some((needle) => normalized.includes(needle));
}

async function listFiles(args) {
  const limit = Math.min(Math.max(Number(args.limit || 80), 1), 300);
  try {
    const { stdout } = await execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: REPO_ROOT,
      maxBuffer: 1024 * 1024,
    });
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.startsWith('node_modules/') && !file.startsWith('dist/') && !file.startsWith('mcp-gateway/dist/'))
      .filter((file) => !isBlockedPath(file))
      .slice(0, limit);
    return { root: REPO_ROOT, count: files.length, files };
  } catch (error) {
    return { error: `Unable to list files: ${error.message}` };
  }
}

async function repoSearch(args) {
  const query = String(args.query || '').trim();
  const limit = Math.min(Math.max(Number(args.limit || 25), 1), 80);
  if (!query) return { error: 'query is required' };

  try {
    const { stdout } = await execFile(
      'rg',
      [
        '-n',
        '-F',
        '--hidden',
        '--no-ignore',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules/**',
        '--glob',
        '!dist/**',
        '--glob',
        '!mcp-gateway/dist/**',
        '--glob',
        '!.env*',
        '--glob',
        '!*secret*',
        '--glob',
        '!*credential*',
        '--glob',
        '!*password*',
        '--glob',
        '!*token*',
        '--glob',
        '!*api_key*',
        '--glob',
        '!*apikey*',
        query,
        REPO_ROOT,
      ],
      {
        cwd: REPO_ROOT,
        maxBuffer: 1024 * 1024,
      },
    );

    const matches = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(`${REPO_ROOT}${path.sep}`, ''))
      .filter((line) => !isBlockedPath(line.split(':')[0] || ''))
      .slice(0, limit);
    return { query, count: matches.length, matches };
  } catch (error) {
    if (error.code === 1) return { query, count: 0, matches: [] };
    return { error: `Search failed: ${error.message}` };
  }
}

async function readFileTool(args) {
  const filePath = String(args.file_path || '').trim();
  const maxChars = Math.min(Math.max(Number(args.max_chars || 16000), 1000), 50000);
  if (!filePath) return { error: 'file_path is required' };
  if (!isInsideRepo(filePath)) return { error: 'Path must stay inside the repository.' };
  if (isBlockedPath(filePath)) return { error: 'Refusing to read a path that may contain secrets or credentials.' };

  const fullPath = path.resolve(REPO_ROOT, filePath);
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return { error: 'Path is not a file.' };
    const content = await fs.readFile(fullPath, 'utf8');
    return {
      file_path: path.relative(REPO_ROOT, fullPath),
      truncated: content.length > maxChars,
      content: content.slice(0, maxChars),
    };
  } catch (error) {
    return { error: `Unable to read file: ${error.message}` };
  }
}

async function callTool(name, args) {
  if (name === 'list_files') return listFiles(args);
  if (name === 'repo_search') return repoSearch(args);
  if (name === 'read_file') return readFileTool(args);
  return { error: `Unknown tool: ${name}` };
}

async function createCompletion() {
  const response = await fetch(`${LM_STUDIO_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LM Studio request failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function askAgent(userText) {
  messages.push({ role: 'user', content: userText });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const data = await createCompletion();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('LM Studio returned no assistant message.');

    messages.push(message);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const content = message.content || '';
      console.log(content.trim() || '(No response text returned.)');
      return;
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      const args = parseToolArgs(toolCall.function?.arguments);
      const result = await callTool(name, args);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result, null, 2),
      });
    }
  }

  console.log('The agent reached its tool-round limit before a final answer.');
}

async function main() {
  const firstPrompt = process.argv.slice(2).join(' ').trim();
  if (firstPrompt) {
    await askAgent(firstPrompt);
    return;
  }

  console.log(`LM Studio local agent ready. Model: ${MODEL}`);
  console.log(`Repo: ${REPO_ROOT}`);
  console.log('Type a question, or .exit to quit.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const input = (await rl.question('\nYou> ')).trim();
      if (!input || input === '.exit' || input === '.quit') break;
      await askAgent(input);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`LM agent error: ${error.message}`);
  console.error('Make sure LM Studio is open, a model is loaded, and the local server is running at http://127.0.0.1:1234.');
  process.exit(1);
});
