# Apple Assistant Eval

This folder contains the synthetic eval data and API eval definition for the Apple MCP assistant safety checks.

Files:

- `apple-assistant-safety-dataset.csv` is the upload-friendly dashboard dataset.
- `apple-assistant-safety-dataset.jsonl` is the API runner dataset.
- `apple-assistant-eval.json` is the eval definition used by the runner.

Run the no-cost shape check:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
node scripts/openai-apple-eval.mjs --dry-run
```

Run the live eval with the saved local OpenAI key:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
scripts/run-openai-apple-eval.sh
```

The live runner waits for the OpenAI eval run to complete and prints the result counts. To reuse the existing eval definition instead of creating a new one:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
OPENAI_EVAL_ID=eval_6a0bbfeffb488191b4bbef32de87dac6 scripts/run-openai-apple-eval.sh
```

The generated `.last-run.json` file is intentionally ignored by Git.
