import test from 'node:test';
import assert from 'node:assert/strict';
import { createSamizdatClient } from '../src/samizdat-client.js';

test('openEvents authenticates, resumes from Last-Event-ID, and returns the raw stream', async () => {
  let call;
  const client = createSamizdatClient({
    baseUrl: 'http://127.0.0.1:3985',
    token: 'secret',
    fetchImpl: async (url, options) => {
      call = { url, options };
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    }
  });
  const controller = new AbortController();
  const response = await client.openEvents('run 1', { since: 12, lastEventId: '12', signal: controller.signal });
  assert.equal(call.url, 'http://127.0.0.1:3985/v1/runs/run%201/events?since=12');
  assert.equal(call.options.headers.Authorization, 'Bearer secret');
  assert.equal(call.options.headers['Last-Event-ID'], '12');
  assert.equal(call.options.signal, controller.signal);
  assert.equal(response.status, 200);
});
