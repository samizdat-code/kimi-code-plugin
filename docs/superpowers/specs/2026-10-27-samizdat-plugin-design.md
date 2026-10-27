# Samizdat Kimi Code Plugin — Revised Design and Plan

## Intent

Build an installable Kimi Code plugin named `samizdat` that delegates coding tasks to Samizdat through its real HTTP API. Samizdat owns the agent workflow, workspace tools, model/provider configuration, credentials, run persistence, and approval gates. The plugin is a thin MCP adapter, not another LLM/tool loop.

There will be no plugin-side provider JSON, direct model API requests, or plugin-implemented filesystem/shell tools.

## Confirmed Samizdat contract

The installed executable is `/Users/yogthos/bin/samizdat`; `samizdat --headless` starts only the HTTP server. A server is bound to the project directory where it starts. The repository confirms these API flows:

- `POST /v1/runs` with `problem`, optional `model`, `max_turns`, `beam_width`, and `token_budget`; returns `run_id` and initial status. The run-request contract rejects unknown fields: the MCP argument named `provider` must be sent as Samizdat's `model` field, which selects a configured provider alias.
- `GET /v1/runs/:id/events` for a resumable SSE stream. An open stream also registers attendance, which is required for Samizdat's `attended` approval mode to block and ask rather than refuse.
- `GET /v1/runs/:id/journal?since=<cursor>&limit=<n>` for journal recovery and cursor validation, including `run-finished`.
- `GET /v1/runs/:id` for run status and `final_answer`.
- `GET /v1/runs/:id/approvals` and `POST /v1/approvals/:id` for pending permission gates and `ask_human` questionnaires. Permission decisions are `allow`/`deny`; questionnaire answers use `decision: "answer"` plus positional `answers` (or `deny` to decline).
- `POST /v1/runs/:id/interventions` to steer a run.
- `POST /v1/runs/:id/interrupt`, `/abort`, and `/resume` for lifecycle control.
- `GET /v1/harness/project` to verify the server's bound root and inspect its selected model.
- Loopback requests use the bearer token at `~/.config/samizdat/http/<port>.token`; `/health` is the unauthenticated readiness check.

The start request can legitimately take up to 150 seconds, so the adapter must not use a short default HTTP timeout or retry a start blindly and create duplicate runs.

## Goals

- Expose Samizdat delegation and run control as MCP tools from a standard `kimi.plugin.json` plugin.
- Auto-start and reuse one dedicated headless Samizdat server per canonical workspace by default.
- Optionally attach to an existing `SAMIZDAT_URL`, after verifying its project matches the requested workspace.
- Leave model selection to Samizdat by default and accept an optional configured provider alias, mapped to the run request's `model` field.
- Preserve run IDs, SSE connections, and event cursors so Kimi can wait, inspect, triage approvals/questionnaires, steer, interrupt, resume, and collect final answers without losing state.
- Return pending approvals immediately so Kimi can triage them like its own permission questions instead of leaving Samizdat blocked.
- Support independent concurrent runs and workspaces without global conversation mixing.
- Never print tokens, provider credentials, or child-server output onto MCP stdout.

## Non-goals and constraints

- No changes to Samizdat source or its config files.
- No plugin-side model defaults, API keys, temperatures, or duplicate provider configuration.
- No blanket auto-allow policy and no automatic answering of `ask_human` questionnaires by the MCP server. Kimi, as the parent agent, performs the approval triage and involves the user when needed.
- No detached/orphaned server design: only child processes started by the adapter are stopped during adapter shutdown; externally supplied servers are never stopped.
- Results include provider/model metadata reported by the server when available rather than asserting a model the adapter did not verify.

## Runtime and server lifecycle

Use Node.js ESM, built-in `fetch`, `node:test`, and the official MCP JavaScript SDK.

- `SAMIZDAT_BIN` overrides the executable. Otherwise use `~/bin/samizdat` when executable, then `samizdat` on PATH.
- `SAMIZDAT_URL` selects external-server mode. In that mode every tool validates `GET /v1/harness/project` against the canonical `cwd`; a mismatch fails instead of modifying the wrong repository.
- In managed mode, validate that `cwd` is an absolute existing directory, canonicalize it, and reuse the healthy registry entry for that directory. Verify an apparently live entry's project before reuse.
- For a new server, allocate separate loopback HTTP and nREPL ports, then spawn `SAMIZDAT_BIN --headless` with `cwd` and `HARNESS_PORT` / `HARNESS_NREPL_PORT`. Pipe child output into bounded diagnostic buffers. Poll `/health` with a bounded startup deadline and fail with sanitized diagnostics if the child exits or never becomes ready.
- Read the loopback token from Samizdat's documented per-port token file at request time. Support `SAMIZDAT_TOKEN` as an optional explicit override for nonstandard/external setups; never return or log it.
- Keep registry state in the MCP process: canonical workspace, child (if managed), base URL, active run streams/cursors, and last-known run routing. On MCP shutdown, close run streams and terminate only managed children, waiting briefly before forced cleanup. Handle startup failures and concurrent first-use with per-workspace promises to avoid duplicate servers.

## Run streaming and waiting

- Opening a run also opens `GET /v1/runs/:id/events?since=0` with authorization and keeps it open until terminal status or adapter shutdown. This is both the event feed and the attendance registration required by `attended` approval mode.
- Parse SSE incrementally across chunk boundaries, handle named events, JSON data, comments/heartbeats, and `id` cursors. Buffer events per run and wake current waiters on new events.
- Reconnect a dropped stream with `Last-Event-ID` and bounded backoff. Use the journal endpoint to recover/validate after reconnect ambiguity; never silently mark a run complete from a dropped connection.
- `wait_samizdat_agent` waits on the buffered stream state and pending approvals rather than opening a second attendance stream. It returns on new terminal status, pending approval/questionnaire, unrecoverable stream failure, or bounded wait expiry. On completion it fetches run detail for `final_answer` and metadata.
- Close terminal run streams and release waiter state without losing the retained final result needed by later status calls.

## Kimi approval triage

Pending approvals are first-class MCP results, not incidental status text. Every pending item includes its ID, run ID, kind, reason/input/details, and questionnaire fields where present.

The plugin's system-prompt guidance requires this loop after every spawn or wait:

1. If no approval is pending, continue normally.
2. For a permission gate, Kimi inspects the requested action against the user's task, existing permissions, reversibility, and blast radius. Kimi may allow routine, reversible, already-authorized work directly; it denies unsafe or out-of-scope work and asks the user when approval is genuinely required, using the normal structured question flow.
3. For an `ask_human` questionnaire, Kimi surfaces the questions and options to the user and returns positional answers, unless the user has already answered them unambiguously in the current request.
4. Kimi immediately calls `decide_samizdat_approval`, then calls `wait_samizdat_agent` again. It must not end its turn while a delegated run is merely parked on an untriaged approval.

The MCP adapter validates decision shapes and transports them; it does not make authorization decisions itself. This preserves Kimi's normal parent-agent permission judgment while ensuring Samizdat does not remain stuck waiting.

## MCP tools

Use `samizdat` as the plugin and MCP server name:

- `spawn_samizdat_agent`: required `task` and absolute `cwd`; optional `provider`, `maxTurns`, `beamWidth`, and `tokenBudget`. Map `provider` to request field `model`, start exactly one run, open its event stream, then wait briefly for an early approval or completion. Return `runId`, workspace, status, selected run settings, and any pending approvals or final answer.
- `wait_samizdat_agent`: required `runId` and `cwd`; optional bounded `waitMs`. Use the retained event stream/cursor. Return promptly on pending approvals/questionnaires, `run-finished`, failure, or wait expiry, including the final answer when complete.
- `get_samizdat_run`: fetch current run detail and pending approvals without advancing the event cursor.
- `decide_samizdat_approval`: require `runId`, `cwd`, `approvalId`, and `decision` (`allow`, `deny`, or `answer`). Permission gates allow only `allow`/`deny`; questionnaires allow `answer` with positional `answers` or `deny`. Support optional `note` and `always` where applicable, preserve question/options metadata in results, and reject a decision shape that does not match the approval kind.
- `message_samizdat_agent`: send a text intervention to a run, optionally to a specific branch.
- `interrupt_samizdat_agent`, `abort_samizdat_agent`, and `resume_samizdat_agent`: wrap the corresponding lifecycle endpoints. Resume accepts optional `maxTurns` and `message` and reopens attendance streaming for the resumed run.

All tools return concise MCP text plus structured content. Terminal statuses and an empty final answer are represented explicitly rather than fabricated as success. HTTP errors preserve Samizdat's useful error message but strip authorization data. Tool descriptions make clear that a running Samizdat agent can modify the workspace and describe the parent-agent approval triage contract.

## Plugin and documentation files

- `kimi.plugin.json`: documented root manifest with `name: "samizdat"`, version/metadata, system-prompt delegation and approval-triage guidance, and stdio MCP declaration `node ./src/server.js` with `cwd: "./"` and an adequate tool timeout for run-start latency.
- `package.json` and lockfile: package name `kimi-samizdat-plugin`, ESM, official MCP SDK, test/start/check scripts, Node engine requirement.
- `src/config.js`: executable/URL/token environment resolution and bounded runtime constants.
- `src/samizdat-client.js`: authenticated HTTP calls, 150-second start timeout, JSON/error validation, project verification, run/journal/SSE/approval/control methods.
- `src/sse.js`: incremental SSE parser and reconnect/cursor helpers.
- `src/server-manager.js`: managed/external server selection, port allocation, readiness, registry, concurrent startup, and child cleanup.
- `src/runs.js`: spawn/wait/result shaping, active attendance streams, cursor tracking, and pending-approval detection.
- `src/server.js`: MCP schemas, handlers, stdio transport, and shutdown.
- `test/`: unit tests plus real MCP/HTTP/SSE integration tests with fake Samizdat services.
- `README.md`: install/reload, Samizdat model selection, managed versus external server modes, every MCP tool, Kimi approval/questionnaire triage, security, and limitations.
- `.gitignore`: dependencies, logs, temporary test state, and local secret-bearing files.

## Verification

1. Unit-test configuration resolution, URL/token handling, HTTP errors, provider-to-`model` request mapping, and project-root comparison.
2. Unit-test managed-server reuse, per-workspace isolation, concurrent startup, startup failure, and managed-versus-external shutdown using a fake headless executable.
3. Unit-test incremental SSE parsing, heartbeat handling, cursor resume/reconnect, and terminal cleanup.
4. Test run start, streamed waiting, early/final completion, attended pending permissions and `ask_human` questionnaires, valid/invalid decisions, steering, interruption, resume, malformed responses, and timeout behavior against a fake Samizdat HTTP/SSE server.
5. Run a real MCP stdio client against the plugin with the fake Samizdat backend: discover tools, spawn a run, triage both a permission gate and a questionnaire through the same decide/wait loop Kimi will use, wait for completion, and verify the exact final answer and structured metadata.
6. Smoke-test the actual `/Users/yogthos/bin/samizdat --headless` in a temporary workspace on allocated HTTP/nREPL ports: verify `/health` and authenticated `/v1/harness/project`, then stop only that child. Do not start a real model run or consume provider quota as part of routine verification.
7. Run `npm test`, `npm run check` (syntax and JSON manifest checks), and `npm pack --dry-run`; inspect final package contents and installation instructions.

## Implementation order

1. Scaffold package, manifest, ignore rules, and documentation skeleton.
2. Implement/test configuration and Samizdat HTTP client.
3. Implement/test managed and external server lifecycle.
4. Implement/test run orchestration, SSE attendance, approval triage results, and all MCP tools.
5. Add the real MCP fake-backend end-to-end test.
6. Finish documentation, smoke-test the installed Samizdat binary, and run full verification.
