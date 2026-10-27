import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/sse.js';

function parse(chunks) {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return events;
}

test('parser handles LF, CRLF, comments, IDs, and JSON data', () => {
  const events = parse([
    ': ping\r\n\r\nid: 7\r\nevent: turn\r\ndata: {"category":"success"}\r\n\r\n',
    'event: note\ndata: plain\n\n'
  ]);
  assert.deepEqual(events, [
    { id: '7', event: 'turn', data: { category: 'success' } },
    { id: null, event: 'note', data: 'plain' }
  ]);
});

test('multiline data is joined with newlines', () => {
  assert.deepEqual(parse(['data: first\ndata: second\n\n']), [
    { id: null, event: 'message', data: 'first\nsecond' }
  ]);
});

test('arbitrary chunk boundaries do not change events', () => {
  const wire = 'id: 9\r\nevent: run-finished\r\ndata: {"status":"completed"}\r\n\r\n';
  const whole = parse([wire]);
  const fragmented = parse([...wire]);
  assert.deepEqual(fragmented, whole);
  assert.deepEqual(whole[0].data, { status: 'completed' });
});

test('malformed JSON remains text', () => {
  assert.deepEqual(parse(['data: {not-json}\n\n'])[0].data, '{not-json}');
});

test('an incomplete final event is not dispatched at end', () => {
  assert.deepEqual(parse(['event: turn\ndata: {"partial":true}']), []);
});

test('empty fields and CRLF split across chunks are supported', () => {
  const events = parse(['data:\r', '\n\r', '\n']);
  assert.deepEqual(events, [{ id: null, event: 'message', data: '' }]);
});
