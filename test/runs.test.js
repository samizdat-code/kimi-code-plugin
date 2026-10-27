import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakeSamizdatServer } from './helpers/fake-samizdat-server.js';
import { createSamizdatClient } from '../src/samizdat-client.js';
import { createRunManager } from '../src/runs.js';

async function setup(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'samizdat-runs-'));
  const backend = await createFakeSamizdatServer({ root: cwd });
  const servers = {
    clientFor: async input => ({
      client: createSamizdatClient({ baseUrl: backend.baseUrl, token: backend.token }),
      cwd,
      baseUrl: backend.baseUrl,
      managed: false
    }),
    close: async () => {}
  };
  const manager = createRunManager({ servers });
  t.after(async () => {
    await manager.close();
    await backend.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { backend, manager, cwd };
}

test('spawn starts one run and wait returns running at the wait boundary', async t => {
  const { backend, manager, cwd } = await setup(t);
  const started = await manager.spawn({ task: 'inspect', cwd, provider: 'fast', maxTurns: 8, beamWidth: 1, tokenBudget: 900, waitMs: 0 });
  assert.equal(started.status, 'running');
  assert.match(started.runId, /^run-/);
  assert.deepEqual(backend.requests[0].body, { problem: 'inspect', model: 'fast', max_turns: 8, beam_width: 1, token_budget: 900 });
  assert.equal(backend.eventRequests, 1);
  assert.equal((await manager.wait({ runId: started.runId, cwd, waitMs: 0 })).status, 'running');
});

test('a terminal event returns the exact final answer and run metadata', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'finish', cwd, waitMs: 0 });
  backend.finishRun(runId, 'Implemented and verified.');
  const result = await manager.wait({ runId, cwd, waitMs: 1000 });
  assert.equal(result.status, 'completed');
  assert.equal(result.finalAnswer, 'Implemented and verified.');
  assert.equal(result.run.id, runId);
  assert.equal(result.run.provider, 'fake');
});

test('empty final answers and exhausted terminal status remain explicit', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'finish', cwd, waitMs: 0 });
  backend.finishRun(runId, '', 'exhausted');
  const result = await manager.wait({ runId, cwd, waitMs: 1000 });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.finalAnswer, '');
});

test('permission approvals bubble up and continue after Kimi allows them', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'edit', cwd, waitMs: 0 });
  const approval = backend.addApproval(runId, { reason: 'Edit src/file.js', input: 'write_file', details: { path: 'src/file.js' } });
  const pending = await manager.wait({ runId, cwd, waitMs: 1000 });
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(pending.approvals[0].id, approval.id);
  assert.equal(pending.approvals[0].reason, 'Edit src/file.js');
  const decided = await manager.decideApproval({ runId, cwd, approvalId: approval.id, decision: 'allow', always: true });
  assert.equal(decided.status, 'running');
  backend.finishRun(runId, 'done');
  assert.equal((await manager.wait({ runId, cwd, waitMs: 1000 })).finalAnswer, 'done');
});

test('ask_human questionnaires preserve questions and accept positional answers', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'choose', cwd, waitMs: 0 });
  const approval = backend.addApproval(runId, {
    kind: 'question',
    questions: [{ question: 'Which option?', header: 'Choice', options: ['A', 'B'], multi: false }]
  });
  const pending = await manager.wait({ runId, cwd, waitMs: 1000 });
  assert.equal(pending.approvals[0].questions[0].options[1], 'B');
  await manager.decideApproval({ runId, cwd, approvalId: approval.id, decision: 'answer', answers: ['B'] });
  assert.deepEqual(backend.requests.at(-1).body, { decision: 'answer', answers: ['B'] });
});

test('invalid decision shapes fail before an approval POST', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'decide', cwd, waitMs: 0 });
  const permission = backend.addApproval(runId, {});
  await assert.rejects(manager.decideApproval({ runId, cwd, approvalId: permission.id, decision: 'answer', answers: ['x'] }), /permission/i);
  await manager.decideApproval({ runId, cwd, approvalId: permission.id, decision: 'deny' });
  const question = backend.addApproval(runId, { kind: 'question', questions: [{ question: 'Pick', options: ['A'] }] });
  await assert.rejects(manager.decideApproval({ runId, cwd, approvalId: question.id, decision: 'allow' }), /question/i);
  await assert.rejects(manager.decideApproval({ runId, cwd, approvalId: question.id, decision: 'answer' }), /answers/i);
  await assert.rejects(manager.decideApproval({ runId, cwd, approvalId: question.id, decision: 'answer', answers: ['A'], always: true }), /always/i);
  assert.equal(backend.requests.filter(item => item.path.startsWith('/v1/approvals/')).length, 1);
});

test('message, interrupt, abort, and resume use the control contract', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'control', cwd, waitMs: 0 });
  await manager.message({ runId, cwd, text: 'focus on tests', branchId: 'branch-2' });
  assert.deepEqual(backend.requests.at(-1), {
    path: `/v1/runs/${runId}/interventions`,
    body: { kind: 'message', payload: 'focus on tests', branch_id: 'branch-2' }
  });
  assert.equal((await manager.interrupt({ runId, cwd })).status, 'interrupted');
  await manager.resume({ runId, cwd, maxTurns: 12, message: 'continue' });
  assert.deepEqual(backend.requests.at(-1).body, { max_turns: 12, message: 'continue' });
  for (let attempt = 0; attempt < 20 && backend.eventRequests < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(backend.eventRequests, 2);
  assert.equal((await manager.abort({ runId, cwd })).status, 'aborted');
});

test('resume skips historical terminal events and keeps attendance for new approvals', async t => {
  const { backend, manager, cwd } = await setup(t);
  const { runId } = await manager.spawn({ task: 'resume safely', cwd, waitMs: 0 });
  await manager.interrupt({ runId, cwd });
  await manager.resume({ runId, cwd });
  for (let attempt = 0; attempt < 20 && backend.eventRequests < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(backend.runs.get(runId).streams.size, 1);
  const approval = backend.addApproval(runId, { reason: 'Post-resume edit' });
  const pending = await manager.wait({ runId, cwd, waitMs: 500 });
  assert.equal(pending.status, 'awaiting_approval');
  await manager.decideApproval({ runId, cwd, approvalId: approval.id, decision: 'allow' });
  backend.finishRun(runId, 'resumed result');
  const finished = await manager.wait({ runId, cwd, waitMs: 500 });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.finalAnswer, 'resumed result');
});
