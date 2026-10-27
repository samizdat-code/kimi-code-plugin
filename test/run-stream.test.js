import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStream } from '../src/run-stream.js';

function sseResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('run stream emits events, advances cursor, ignores heartbeats, and closes on run-finished', async () => {
  const events = [];
  const calls = [];
  const client = {
    openEvents: async (runId, options) => {
      calls.push({ runId, options });
      return sseResponse([
        ': ping\n\nid: 4\nevent: turn\ndata: {"category":"success"}\n\n',
        'id: 5\nevent: run-finished\ndata: {"status":"completed"}\n\n'
      ]);
    }
  };
  const stream = createRunStream({ client, runId: 'run-1', onEvent: event => events.push(event) });
  stream.start();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.since, 0);
  assert.equal(events.length, 2);
  assert.equal(stream.cursor, '5');
  assert.deepEqual(stream.terminal, { status: 'completed' });
  stream.close();
});

test('a disconnected stream reconnects with Last-Event-ID and journal recovery', async () => {
  const calls = [];
  const journalCalls = [];
  const events = [];
  let secondResponse;
  const client = {
    openEvents: async (_runId, options) => {
      calls.push(options);
      if (calls.length === 1) return sseResponse(['id: 8\nevent: turn\ndata: {"n":1}\n\n']);
      secondResponse = new Response(new ReadableStream({ start() {} }), { status: 200 });
      return secondResponse;
    },
    journal: async (runId, since) => {
      journalCalls.push({ runId, since });
      return { events: [{ id: 9, kind: 'turn', data: { n: 2 } }] };
    }
  };
  const stream = createRunStream({
    client,
    runId: 'run-1',
    onEvent: event => events.push(event),
    retryDelayMs: 1
  });
  stream.start();
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(journalCalls, [{ runId: 'run-1', since: '8' }]);
  assert.equal(calls[1].lastEventId, '9');
  assert.equal(stream.terminal, null);
  assert.equal(events.length, 2);
  assert.equal(events[1].id, '9');
  stream.close();
});

test('terminal state is not inferred from a dropped connection', async () => {
  const client = {
    openEvents: async () => sseResponse([]),
    journal: async () => ({ events: [] })
  };
  const stream = createRunStream({ client, runId: 'run-1', retryDelayMs: 1000 });
  stream.start();
  await tick();
  assert.equal(stream.terminal, null);
  stream.close();
});

test('stream failures are reported once and close is idempotent', async () => {
  const errors = [];
  const client = { openEvents: async () => { throw new Error('HTTP 403: denied'); } };
  const stream = createRunStream({
    client,
    runId: 'run-1',
    onError: error => errors.push(error)
  });
  stream.start();
  stream.start();
  await tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /403/);
  stream.close();
  stream.close();
});

test('transient read failures reconnect with the last event ID', async () => {
  const calls = [];
  const errors = [];
  const client = {
    openEvents: async (_runId, options) => {
      calls.push(options);
      if (calls.length === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('id: 8\nevent: turn\ndata: {"n":1}\n\n'));
            setTimeout(() => controller.error(new Error('socket reset')), 1);
          }
        }), { status: 200 });
      }
      return sseResponse(['id: 9\nevent: run-finished\ndata: {"status":"completed"}\n\n']);
    },
    journal: async () => ({ events: [] })
  };
  const stream = createRunStream({
    client,
    runId: 'run-1',
    onError: error => errors.push(error),
    retryDelayMs: 1
  });
  stream.start();
  await tick();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].lastEventId, '8');
  assert.deepEqual(stream.terminal, { status: 'completed' });
  assert.equal(errors.length, 0);
  stream.close();
});

test('stream reports each successful connection for approval reconciliation', async () => {
  let connections = 0;
  const client = {
    openEvents: async () => sseResponse([]),
    journal: async () => ({ events: [] })
  };
  const stream = createRunStream({
    client,
    runId: 'run-1',
    onReady: () => { connections += 1; },
    retryDelayMs: 1
  });
  stream.start();
  await tick();
  await tick();
  stream.close();
  assert.ok(connections >= 2);
});
