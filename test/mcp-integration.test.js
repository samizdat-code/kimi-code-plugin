import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFakeSamizdatServer } from './helpers/fake-samizdat-server.js';

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'samizdat-mcp-'));
  const backend = await createFakeSamizdatServer({ root: cwd });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.js'],
    cwd: pluginRoot,
    env: {
      ...process.env,
      SAMIZDAT_URL: backend.baseUrl,
      SAMIZDAT_TOKEN: backend.token
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'samizdat-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await backend.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { client, backend, cwd };
}

test('MCP exposes the complete Samizdat delegation and approval workflow', async t => {
  const { client, backend, cwd } = await setup(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'abort_samizdat_agent',
    'decide_samizdat_approval',
    'get_samizdat_run',
    'interrupt_samizdat_agent',
    'message_samizdat_agent',
    'resume_samizdat_agent',
    'spawn_samizdat_agent',
    'wait_samizdat_agent'
  ]);

  const spawned = await client.callTool({
    name: 'spawn_samizdat_agent',
    arguments: { task: 'Implement the feature', cwd, provider: 'coding', maxTurns: 12, beamWidth: 1, tokenBudget: 4000, waitMs: 0 }
  });
  assert.equal(spawned.isError, undefined);
  const runId = spawned.structuredContent.runId;
  assert.equal(spawned.structuredContent.status, 'running');
  assert.equal(backend.requests[0].body.model, 'coding');

  const permission = backend.addApproval(runId, { reason: 'Edit one source file', input: 'edit_file', details: { path: 'src/a.js' } });
  const pendingPermission = await client.callTool({ name: 'wait_samizdat_agent', arguments: { runId, cwd, waitMs: 1000 } });
  assert.equal(pendingPermission.structuredContent.status, 'awaiting_approval');
  assert.equal(pendingPermission.structuredContent.approvals[0].reason, 'Edit one source file');
  const allowed = await client.callTool({
    name: 'decide_samizdat_approval',
    arguments: { runId, cwd, approvalId: permission.id, decision: 'allow' }
  });
  assert.equal(allowed.structuredContent.status, 'running');

  const question = backend.addApproval(runId, {
    kind: 'question',
    questions: [{ header: 'Scope', question: 'Which approach?', options: ['Small', 'Large'], multi: false }]
  });
  const pendingQuestion = await client.callTool({ name: 'get_samizdat_run', arguments: { runId, cwd } });
  assert.equal(pendingQuestion.structuredContent.approvals[0].kind, 'question');
  await client.callTool({
    name: 'decide_samizdat_approval',
    arguments: { runId, cwd, approvalId: question.id, decision: 'answer', answers: ['Small'] }
  });

  backend.finishRun(runId, 'Feature implemented and tests pass.');
  const finished = await client.callTool({ name: 'wait_samizdat_agent', arguments: { runId, cwd, waitMs: 1000 } });
  assert.equal(finished.structuredContent.status, 'completed');
  assert.equal(finished.structuredContent.finalAnswer, 'Feature implemented and tests pass.');
  assert.equal(finished.structuredContent.run.provider, 'coding');
  assert.equal(finished.content[0].text, 'Feature implemented and tests pass.');
});

test('MCP validates task, cwd, run IDs, waits, and budgets', async t => {
  const { client, cwd } = await setup(t);
  for (const request of [
    { name: 'spawn_samizdat_agent', arguments: { task: '', cwd }, message: /task/ },
    { name: 'spawn_samizdat_agent', arguments: { task: 'work', cwd: 'relative' }, message: /absolute/ },
    { name: 'spawn_samizdat_agent', arguments: { task: 'work', cwd, maxTurns: 0 }, message: /maxTurns/ },
    { name: 'wait_samizdat_agent', arguments: { runId: '', cwd }, message: /runId/ },
    { name: 'wait_samizdat_agent', arguments: { runId: 'run-1', cwd, waitMs: 30001 }, message: /waitMs/ },
    { name: 'message_samizdat_agent', arguments: { runId: 'run-1', cwd, text: '' }, message: /text/ }
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, request.message);
  }
});

test('MCP errors do not leak the server token', async t => {
  const { client, cwd, backend } = await setup(t);
  await backend.close();
  const result = await client.callTool({ name: 'spawn_samizdat_agent', arguments: { task: 'work', cwd } });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, new RegExp(backend.token));
});

test('MCP timeout covers managed startup, run start, verification, and initial wait', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'kimi.plugin.json'), 'utf8'));
  const worstCaseSpawnMs = 30000 + 150000 + 10000 + 30000;
  assert.ok(manifest.mcpServers.samizdat.toolTimeoutMs > worstCaseSpawnMs);
});

test('managed MCP shutdown closes active attendance and terminates its child', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'samizdat-mcp-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'samizdat-mcp-managed-'));
  const marker = path.join(home, 'stream-closed');
  const env = { ...process.env, HOME: home, SAMIZDAT_BIN: path.join(pluginRoot, 'test/helpers/fake-samizdat-bin.js'), FAKE_SAMIZDAT_STREAM_CLOSED_FILE: marker };
  delete env.SAMIZDAT_URL;
  delete env.SAMIZDAT_TOKEN;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.js'],
    cwd: pluginRoot,
    env,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'samizdat-managed-shutdown-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const spawned = await client.callTool({ name: 'spawn_samizdat_agent', arguments: { task: 'keep running', cwd, waitMs: 0 } });
  assert.equal(spawned.structuredContent.status, 'running');
  await client.close();
  await fs.access(marker);
  const tokenDir = path.join(home, '.config', 'samizdat', 'http');
  assert.deepEqual(await fs.readdir(tokenDir), []);
});
