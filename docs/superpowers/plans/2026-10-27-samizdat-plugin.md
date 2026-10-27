# Samizdat Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Kimi Code MCP plugin that delegates workspace tasks to Samizdat and reliably returns run results and approval requests.

**Architecture:** A Node.js MCP server resolves or launches one Samizdat HTTP server per workspace. A small HTTP/SSE client manages run attendance and cursors, while MCP tools expose spawning, waiting, approval decisions, steering, and lifecycle controls. Samizdat owns models, credentials, tools, and persistence.

**Tech Stack:** Node.js ESM, built-in `fetch` and `node:test`, official `@modelcontextprotocol/sdk`, Samizdat HTTP/SSE API.

**Spec:** `docs/superpowers/specs/2026-10-27-samizdat-plugin-design.md`

## Global Constraints

- Plugin and MCP server name are exactly `samizdat`; no plugin-side provider configuration or direct model calls.
- Use `/Users/yogthos/bin/samizdat` by default when executable, then `samizdat` on PATH; `SAMIZDAT_BIN` overrides it.
- Never modify Samizdat source/configuration or stop external servers.
- Map MCP `provider` to Samizdat run-request field `model`.
- Keep an authorized SSE stream open for every active run so `attended` approvals work.
- Return pending approvals immediately; Kimi triages them and resumes waiting after each decision.
- No git commits unless the user explicitly requests them.

## Review Focus

- A server URL for the wrong project must be refused before any run-changing call; test canonical and symlinked roots in Task 2.
- A start request taking over 60 seconds must not time out or be reposted; test the 150-second policy without a real delay in Task 1.
- SSE chunks may split JSON, CRLF lines, event IDs, or multiline data at arbitrary positions; test fragmented input in Task 3.
- Permission and questionnaire approvals have incompatible decision bodies; test kind/shape mismatches in Task 4.
- MCP shutdown must close streams and only terminate managed children; test external-server survival and failed-start cleanup in Tasks 2 and 5.

---

### Task 1: Package and Authenticated Samizdat HTTP Client

**Files:**
- Create: `package.json`, `package-lock.json`, `kimi.plugin.json`, `.gitignore`
- Create: `src/config.js`, `src/samizdat-client.js`
- Test: `test/config.test.js`, `test/samizdat-client.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env)` returning executable, optional external URL/token, and timeout constants.
- Produces: `createSamizdatClient({ baseUrl, token, fetchImpl = fetch })` with async `health()`, `project()`, `startRun(input)`, `runDetail(id)`, `journal(id, since)`, `approvals(id)`, `decide(id, body)`, `post(path, body)`, and `get(path)`.
- `startRun({ task, provider, maxTurns, beamWidth, tokenBudget })` emits only `problem`, optional `model`, `max_turns`, `beam_width`, and `token_budget`.

- [ ] **Step 1: Write failing client/config tests** covering default and override config, bearer headers, JSON errors, project/run decoding, exact start body, and an injected clock/timeout signal proving start uses 150000 ms rather than the ordinary request timeout.
- [ ] **Step 2: Run `node --test test/config.test.js test/samizdat-client.test.js`** and confirm failure because the modules do not exist.
- [ ] **Step 3: Scaffold the package and implement config/client** using built-in fetch, explicit JSON response validation, sanitized HTTP errors, and no start-run retry.
- [ ] **Step 4: Install the pinned MCP SDK with `npm install`**, producing the lockfile without adding a second runtime dependency unless the SDK requires it.
- [ ] **Step 5: Run the Task 1 tests** and confirm all pass.

### Task 2: Managed and External Server Lifecycle

**Files:**
- Create: `src/server-manager.js`
- Test: `test/server-manager.test.js`, `test/helpers/fake-samizdat-bin.js`

**Interfaces:**
- Consumes: Task 1 config and `createSamizdatClient`.
- Produces: `createServerManager({ config, spawnImpl, fetchImpl })` with async `clientFor(cwd)` and `close()`.
- `clientFor` returns `{ client, cwd, baseUrl, managed }`; `close()` settles streams/children owned by the manager.

- [ ] **Step 1: Write failing lifecycle tests** for absolute/existing cwd validation, canonical root matching, external mismatch refusal, managed reuse, concurrent first-use, distinct workspaces, separate HTTP/nREPL ports, readiness failure, and managed-versus-external shutdown.
- [ ] **Step 2: Run `node --test test/server-manager.test.js`** and confirm the expected module-not-found failure.
- [ ] **Step 3: Implement the fake executable and server manager** with per-workspace startup promises, bounded diagnostic buffers, token-file loading, `/health` readiness, `/v1/harness/project` verification, and idempotent cleanup.
- [ ] **Step 4: Run the Task 2 tests** and confirm all pass, including that external shutdown makes no process kill call.

### Task 3: Incremental SSE and Run Attendance

**Files:**
- Create: `src/sse.js`, `src/run-stream.js`
- Test: `test/sse.test.js`, `test/run-stream.test.js`

**Interfaces:**
- Produces: `createSseParser(onEvent)` with `push(string)` and `end()`; event shape `{ id, event, data }` where data is decoded JSON when possible.
- Produces: `createRunStream({ client, runId, onEvent, onError })` with `start()`, `close()`, `cursor`, and terminal-event detection; reconnection sends `Last-Event-ID`.

- [ ] **Step 1: Write failing parser tests** for arbitrary chunk splits, LF/CRLF, comments, multiline data, blank-line dispatch, malformed JSON, and final incomplete events.
- [ ] **Step 2: Write failing stream tests** for authorized startup, cursor advance, heartbeats, reconnect after a dropped response, terminal close, and no completion inference from disconnect.
- [ ] **Step 3: Run both test files** and confirm failure because the modules do not exist.
- [ ] **Step 4: Implement parser and stream** using incremental response-body reads, bounded reconnect backoff, journal recovery for cursor gaps, and idempotent close.
- [ ] **Step 5: Run both test files** and confirm all pass.

### Task 4: Run Orchestration and Approval Triage Results

**Files:**
- Create: `src/runs.js`
- Test: `test/runs.test.js`, `test/helpers/fake-samizdat-server.js`

**Interfaces:**
- Consumes: server manager `clientFor(cwd)` and Task 3 run streams.
- Produces: `createRunManager({ servers })` with `spawn(input)`, `wait(input)`, `status(input)`, `decideApproval(input)`, `message(input)`, `interrupt(input)`, `abort(input)`, `resume(input)`, and `close()`.
- Results use `{ status, runId, cwd, approvals?, finalAnswer?, run? }`; pending approval records retain all API fields.

- [ ] **Step 1: Write failing run tests** for spawn plus early completion, running/wait timeout, attended permission return, questionnaire return, decide-then-wait flow, final-answer collection, empty final answers, and terminal statuses.
- [ ] **Step 2: Add invalid-decision tests** proving permission `answer`, questionnaire `allow`, questionnaire `answer` without positional `answers`, and permission-only `always` misuse fail before HTTP submission.
- [ ] **Step 3: Add control tests** for message/branch payloads, interrupt, abort, and resume with `max_turns`/`message` plus reopened attendance.
- [ ] **Step 4: Run `node --test test/runs.test.js`** and confirm the expected module-not-found failure.
- [ ] **Step 5: Implement the fake HTTP/SSE server and run manager** with per-run event buffers/waiters, SSE-driven approval wakeups, immediate approval returns, cursor-safe waiting, and retained final results.
- [ ] **Step 6: Run the Task 4 tests** and confirm all pass.

### Task 5: MCP Tool Surface and End-to-End Integration

**Files:**
- Create: `src/server.js`, `src/result.js`
- Test: `test/mcp-integration.test.js`

**Interfaces:**
- Consumes: Task 4 run manager and its result shapes.
- Produces MCP tools `spawn_samizdat_agent`, `wait_samizdat_agent`, `get_samizdat_run`, `decide_samizdat_approval`, `message_samizdat_agent`, `interrupt_samizdat_agent`, `abort_samizdat_agent`, and `resume_samizdat_agent`.
- Every tool returns MCP text plus `structuredContent`; errors are concise and contain no token.

- [ ] **Step 1: Write the failing MCP integration test** using the SDK stdio client and fake Samizdat backend: list all eight tools, spawn, receive a permission, allow it, receive a questionnaire, answer it, wait for the exact final answer, and inspect structured metadata.
- [ ] **Step 2: Add schema/error tests** for required absolute cwd/task/run IDs, bounded waits and budgets, approval decision validation, and shutdown closing managed resources.
- [ ] **Step 3: Run `node --test test/mcp-integration.test.js`** and confirm failure because the MCP entry point does not exist.
- [ ] **Step 4: Implement MCP registration and result shaping**, with tool descriptions that require Kimi to triage pending approvals and wait again rather than ending with Samizdat parked.
- [ ] **Step 5: Complete `kimi.plugin.json`** with name `samizdat`, stdio command `node ./src/server.js`, `cwd: "./"`, sufficient tool timeout, and system-prompt approval-triage instructions.
- [ ] **Step 6: Run the integration test** and confirm the complete fake-backend scenario passes through real MCP and HTTP/SSE calls.

### Task 6: Documentation and Deliverable Verification

**Files:**
- Create: `README.md`
- Modify: `kimi.plugin.json`, `package.json` only if verification exposes metadata/script issues

**Interfaces:**
- Produces: installable plugin directory and documented `npm test` / `npm run check` verification commands.

- [ ] **Step 1: Write README** with `/plugins install <path>` and `/reload`, managed/external modes, optional provider alias selection, all tool workflows, approval triage, security limitations, and development commands; do not include provider credentials.
- [ ] **Step 2: Add `scripts/check.js`** to syntax-check source and validate manifest/package JSON and required MCP fields without starting a server.
- [ ] **Step 3: Run `npm test` and `npm run check`** and confirm every test/check passes.
- [ ] **Step 4: Smoke-test the actual Samizdat binary** in a temporary workspace on allocated ports: `/health` plus authenticated `/v1/harness/project`, then stop only the launched child; record the exact result.
- [ ] **Step 5: Run `npm pack --dry-run`** and inspect that only intended plugin source, manifest, docs, and package metadata are included, with no test state or secrets.
