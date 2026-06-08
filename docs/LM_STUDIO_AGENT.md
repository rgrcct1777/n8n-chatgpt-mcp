# LM Studio Local Agent

This repo now includes a small read-only AI agent that talks to the LM Studio local API.

## Current Local Setup

- LM Studio app: `/Applications/LM Studio.app`
- Local server: `http://127.0.0.1:1234`
- Model verified locally: `google/gemma-4-e4b`

## Run It

From this repo:

```bash
/Users/richardgentry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/lm-agent.mjs "What are the biggest deployment risks in this repo?"
```

If your normal shell has npm available, this also works:

```bash
npm run agent:lm -- "What are the biggest deployment risks in this repo?"
```

For an interactive chat:

```bash
/Users/richardgentry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/lm-agent.mjs
```

## Configuration

```bash
LM_STUDIO_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=google/gemma-4-e4b
LM_AGENT_MAX_TOOL_ROUNDS=6
```

The agent has read-only repo tools:

- `list_files`
- `repo_search`
- `read_file`

It refuses to read common secret-bearing paths such as `.env`, token, credential, password, secret, and API-key files.
