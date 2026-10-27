# Samizdat for Kimi Code

A Kimi Code plugin that delegates coding tasks to [Samizdat](https://github.com/samizdat-code/samizdat) through its HTTP API. Samizdat owns the agent workflow, workspace tools, models, credentials, persistence, and approval gates; this plugin supplies MCP tools and run attendance.

## Requirements

- Node.js 20 or newer
- Samizdat at `~/bin/samizdat` or `samizdat` on `PATH`
- A working Samizdat provider/model configuration

Install the plugin's dependencies before installing it into Kimi Code:

```bash
cd /path/to/this/plugin
npm install
/plugins install /path/to/this/plugin
```

Run `/plugins install` inside Kimi Code, not in the shell. Then run `/reload` or `/new`. Kimi copies the directory into its managed plugins, so reinstall after changing the source.

## Model selection

The plugin does not duplicate provider configuration or credentials. A delegation uses Samizdat's configured default model unless the caller supplies `provider`, which names a provider alias already declared in Samizdat. The adapter sends that alias as the run request's `model` field, matching Samizdat's API contract.

For example, ask Kimi:

> Use Samizdat to inspect the parser and fix the failing tests in this workspace.

Or select a configured alias explicitly:

> Spawn a Samizdat agent with provider `coding` to review this change.

## Server modes

### Managed per-workspace servers

By default, the plugin starts `samizdat --headless` in the delegated absolute `cwd`, using separate available HTTP and nREPL ports. It reuses one healthy server per canonical workspace and stops only these managed children when the MCP server shuts down.

`SAMIZDAT_BIN` overrides the executable path when Kimi Code starts.

### Existing server

Set `SAMIZDAT_URL` to attach to a running Samizdat server. Set `SAMIZDAT_TOKEN` when that setup needs an explicit bearer token. For standard loopback servers, the adapter reads Samizdat's token from `~/.config/samizdat/http/<port>.token`.

The adapter calls `/v1/harness/project` before run-changing operations and refuses a server bound to another workspace. It never stops an external server.

## MCP tools

- `spawn_samizdat_agent`: start a run with `task` and absolute `cwd`; optionally set `provider`, `maxTurns`, `beamWidth`, `tokenBudget`, and an initial `waitMs`.
- `wait_samizdat_agent`: wait for completion, a failure, or a pending approval. Each call has a bounded wait and can be repeated safely.
- `get_samizdat_run`: inspect status, model metadata, final answer, and pending approvals without advancing the event cursor.
- `decide_samizdat_approval`: allow or deny a permission gate, answer a questionnaire with positional `answers`, or decline it.
- `message_samizdat_agent`: steer a run with text, optionally for one branch.
- `interrupt_samizdat_agent`: stop current work and leave the run resumable.
- `abort_samizdat_agent`: abort a run.
- `resume_samizdat_agent`: resume with optional `maxTurns` and `message`, reopening approval attendance.

Every result includes concise text and structured MCP content. Run IDs are required for subsequent control calls.

## Approval handling

The plugin keeps an authorized server-sent-events stream open for each active run. Besides delivering run events, this registers attendance so Samizdat's `attended` approval mode can ask instead of refuse.

Pending approvals return immediately to Kimi. Kimi then:

1. Inspects each permission request against the task, existing permissions, reversibility, and blast radius.
2. Allows routine authorized work, denies unsafe or out-of-scope work, and asks the user when a decision genuinely needs them.
3. Surfaces `ask_human` questionnaires and returns the user's positional answers.
4. Calls `decide_samizdat_approval` and immediately waits again.

The MCP adapter transports and validates decisions; it does not independently authorize actions.

## Security

A Samizdat subagent can modify its workspace and run tools with the permissions Samizdat gives it. Review the delegated task and approval requests carefully. Server project checks prevent accidentally pointing the adapter at a different workspace, but they are not a sandbox.

Bearer tokens are never included in MCP results. Child-process diagnostics are bounded, and externally managed servers are never terminated by the plugin.

## Development

```bash
npm test
npm run check
npm pack --dry-run
```

The tests include a real MCP stdio client and a fake Samizdat HTTP/SSE backend, covering delegation, SSE reconnection, permission gates, questionnaires, final answers, and lifecycle controls. Routine tests do not contact a model provider or consume provider quota.
