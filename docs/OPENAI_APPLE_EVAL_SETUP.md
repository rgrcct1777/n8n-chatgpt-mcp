# OpenAI + Apple Evaluation Setup

This repo now has a starter evaluation for the Apple assistant tools in `apple-mcp-server.cjs`.

The goal is intentionally narrow: test whether an assistant chooses the right safety posture before touching Calendar, Reminders, Notes, Mail, Messages, Shortcuts, Photos, local files, secrets, or location.

## What Is Set Up

- Synthetic dashboard upload file: `evals/apple-assistant/apple-assistant-safety-dataset.csv`
- Evals API dataset: `evals/apple-assistant/apple-assistant-safety-dataset.jsonl`
- Eval definition: `evals/apple-assistant/apple-assistant-eval.json`
- Runner: `scripts/openai-apple-eval.mjs`
- Saved-key live runner: `scripts/run-openai-apple-eval.sh`
- Apple MCP send-safety checker: `scripts/apple-mcp-safety-check.mjs`
- Apple MCP safety guard: `apple-mcp-server.cjs` blocks Mail and Messages sends by default and returns a confirmation-required preview.
- Local eval API key file: `/Users/richardgentry/.codex/secrets/openai-apple-assistant-eval.env`

The starter cases avoid real personal data. They use fake names and generic examples so the first eval can be safely uploaded to OpenAI Platform.

## Latest Live Result

- Eval ID: `eval_6a0bbfeffb488191b4bbef32de87dac6`
- Run ID: `evalrun_6a0bc9d6e67c81918be5499e0b49d28f`
- Result: `12 passed / 0 failed / 0 errored`
- Report: `https://platform.openai.com/evaluations/eval_6a0bbfeffb488191b4bbef32de87dac6?project_id=proj_vqE08wMbkqn5pTNJAYv1xVVe&run_id=evalrun_6a0bc9d6e67c81918be5499e0b49d28f`

## Apple MCP Send Safety

Mail and Messages are external communications. The Apple MCP server now treats them as confirmation-required:

- Default behavior: return `status: "confirmation_required"` and `delivery: "not_sent"`.
- To send for real, the server must be started with `APPLE_MCP_ALLOW_EXTERNAL_SEND=1`.
- The tool call must also include `confirmSend: true`.
- Only set `confirmSend: true` after the user has reviewed the exact recipient and exact message body.

This keeps normal read-only and local-write tools usable while reducing the chance that an assistant sends an email or iMessage before the user approves it.

## Guideline Basis

OpenAI guidance used here:

- Define a specific eval objective.
- Use task-specific data with normal cases, edge cases, and adversarial cases.
- Prefer classification or scoring criteria that are easy to grade.
- Keep improving the eval over time from real failures and human review.
- Keep secrets out of source files and out of eval datasets.

Apple guidance used here:

- Respect the user's permission settings.
- Do not force or manipulate consent for unnecessary data access.
- Be clear about third-party data sharing and privacy practices.
- Avoid tracking/fingerprinting behavior without proper consent.
- For Apple automation surfaces, provide clear intent metadata and keep behavior aligned with the user's explicit request.

Primary references:

- https://developers.openai.com/api/docs/guides/evaluation-best-practices
- https://developers.openai.com/api/docs/guides/evals
- https://developers.openai.com/api/docs/guides/your-data
- https://developer.apple.com/app-store/user-privacy-and-data-use/
- https://developer.apple.com/app-store/app-privacy-details/
- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/documentation/AppIntents/app-intents

## Run It Locally

Dry-run validation:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
node scripts/openai-apple-eval.mjs --dry-run
```

Run the live eval with the saved local key:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
scripts/run-openai-apple-eval.sh
```

The live runner now waits for OpenAI Platform to finish the eval run, prints the pass/fail/error counts, and saves the latest run pointer in `evals/apple-assistant/.last-run.json`. If any rows fail, it prints the failed user request, expected policy label, and model output.

Apple MCP safety check, one command:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
node scripts/apple-mcp-safety-check.mjs
```

Expected result:

```text
Apple MCP safety check passed: Mail and Messages did not send by default.
```

Manual Apple MCP safety check:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
node --check apple-mcp-server.cjs
node apple-mcp-server.cjs --http --port 3010
```

In a second Terminal window:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
curl -sS http://127.0.0.1:3010/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"apple_mail_send","arguments":{"to":"test@example.com","subject":"Test","body":"Do not send"}}}'
```

Expected result: `delivery` is `not_sent`.

Live OpenAI Platform run, when `OPENAI_API_KEY` is already available in your shell:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
node scripts/openai-apple-eval.mjs
```

Optional project/model overrides:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
OPENAI_PROJECT=proj_vqE08wMbkqn5pTNJAYv1xVVe OPENAI_EVAL_MODEL=gpt-4.1 node scripts/openai-apple-eval.mjs
```

Reuse the existing eval definition instead of creating a new dashboard eval:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
OPENAI_EVAL_ID=eval_6a0bbfeffb488191b4bbef32de87dac6 scripts/run-openai-apple-eval.sh
```

Queue a run without waiting for completion:

```bash
cd /Users/richardgentry/Projects/n8n-chatgpt-mcp
scripts/run-openai-apple-eval.sh --no-wait
```

There is also an `npm run eval:apple` script for environments where `npm` is on the shell path. On this Mac, direct `node` is the safer copy/paste command.

## Dashboard Setup

Created OpenAI Platform dataset:

- Name: `Apple Assistant Safety Triage`
- Dataset ID: `dset_6a0bb9f953d88195aa376373b1097a8c07f722ceb89f4b4f`
- URL: `https://platform.openai.com/evaluation/datasets/dset_6a0bb9f953d88195aa376373b1097a8c07f722ceb89f4b4f`
- Uploaded file: `evals/apple-assistant/apple-assistant-safety-dataset.csv`
- Rows: `12`

The dashboard prompt was drafted with the same label-only classification prompt used by the local runner. If the dashboard still shows a draft or unsaved prompt state, use the local API runner below as the source of truth for live eval runs.

The API runner does the same structure programmatically and uses inline `file_content`, so it does not need a separate file upload step.

## Maintenance

- Add real failure cases only after removing names, locations, emails, phone numbers, file paths, and private content.
- Keep Shortcuts import tests on the safe workflow: quarantine, scan, plain-English report, manual review, no auto-import, no auto-run.
- Re-run `node scripts/apple-mcp-safety-check.mjs` after changing `apple-mcp-server.cjs`.
- Re-run `scripts/run-openai-apple-eval.sh` after changing the eval prompt, dataset, or Apple assistant behavior.
- If the eval key is no longer needed, delete the key in OpenAI Platform and remove `/Users/richardgentry/.codex/secrets/openai-apple-assistant-eval.env`.
