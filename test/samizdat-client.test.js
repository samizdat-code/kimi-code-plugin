import test from 'node:test';
import assert from 'node:assert/strict';
import { createSamizdatClient } from '../src/samizdat-client.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('project requests use bearer authentication and decode JSON', async () => {
  const calls = [];
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985/',
    token: 'abc123',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ root: '/work/project', provider: 'local', model: 'test-model' });
    }
  });
  const project = await client.project();
  assert.equal(project.root, '/work/project');
  assert.equal(calls[0].url, 'http://127.0.0.1:3985/v1/harness/project');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer abc123');
});

test('health works without a token', async () => {
  let headers;
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return jsonResponse({ status: 'ok' });
    }
  });
  assert.deepEqual(await client.health(), { status: 'ok' });
  assert.equal(headers.Authorization, undefined);
});

test('startRun maps provider to model and emits only supported fields', async () => {
  let request;
  const timeouts = [];
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    token: 'abc123',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return jsonResponse({ run_id: 'run-1', status: 'running', beam_width: 2, max_turns: 20 });
    },
    setTimeoutImpl: (callback, ms) => {
      timeouts.push(ms);
      return timeouts.length;
    },
    clearTimeoutImpl: () => {}
  });
  const result = await client.startRun({
    task: 'Fix the parser',
    provider: 'fast-alias',
    maxTurns: 20,
    beamWidth: 2,
    tokenBudget: 5000,
    ignored: 'not-sent'
  });
  assert.equal(result.run_id, 'run-1');
  assert.deepEqual(request.body, {
    problem: 'Fix the parser',
    model: 'fast-alias',
    max_turns: 20,
    beam_width: 2,
    token_budget: 5000
  });
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(timeouts, [150000]);
});

test('ordinary reads use the shorter request timeout', async () => {
  const timeouts = [];
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    fetchImpl: async () => jsonResponse({ run: { id: 'run-1', status: 'running' } }),
    setTimeoutImpl: (callback, ms) => {
      timeouts.push(ms);
      return timeouts.length;
    },
    clearTimeoutImpl: () => {}
  });
  await client.runDetail('run-1');
  assert.deepEqual(timeouts, [10000]);
});

test('run and approval methods use the documented routes', async () => {
  const calls = [];
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });
  await client.journal('run space', 12);
  await client.approvals('run-1');
  await client.decide('approval-1', { decision: 'allow' });
  assert.equal(calls[0].url, 'http://127.0.0.1:3985/v1/runs/run%20space/journal?since=12&limit=200');
  assert.equal(calls[1].url, 'http://127.0.0.1:3985/v1/runs/run-1/approvals');
  assert.equal(calls[2].url, 'http://127.0.0.1:3985/v1/approvals/approval-1');
  assert.equal(calls[2].options.method, 'POST');
});

test('HTTP errors preserve the server message but redact the configured token', async () => {
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    token: 'abc123',
    fetchImpl: async () => jsonResponse({ error: { message: 'Rejected abc123' } }, 403)
  });
  await assert.rejects(client.project(), error => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /Rejected \[redacted\]/);
    assert.doesNotMatch(error.message, /abc123/);
    return true;
  });
});

test('invalid JSON responses fail clearly', async () => {
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    fetchImpl: async () => new Response('not-json', { status: 200 })
  });
  await assert.rejects(client.health(), /invalid JSON/i);
});

test('a failed start is returned to the caller without a duplicate request', async () => {
  let calls = 0;
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'model unavailable' } }, 503);
    }
  });
  await assert.rejects(client.startRun({ task: 'do work' }), /HTTP 503: model unavailable/);
  assert.equal(calls, 1);
});

test('start timeout covers a response body that stalls after headers', async () => {
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    startTimeoutMs: 10,
    fetchImpl: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      }
    }), { status: 200 })
  });
  await Promise.race([
    assert.rejects(client.startRun({ task: 'slow response' }), /timed out after 10 ms/),
    new Promise((_, reject) => setTimeout(() => reject(new Error('body read escaped the timeout')), 200))
  ]);
});
