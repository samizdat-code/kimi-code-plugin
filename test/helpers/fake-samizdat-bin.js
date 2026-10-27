#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.HARNESS_PORT);
const token = 'fake-samizdat-token';
const tokenDir = path.join(process.env.HOME, '.config', 'samizdat', 'http');
fs.mkdirSync(tokenDir, { recursive: true });
const tokenPath = path.join(tokenDir, `${port}.token`);
fs.writeFileSync(tokenPath, token, { mode: 0o600 });

const activeStreams = new Set();
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
    return;
  }
  if (req.url === '/v1/harness/project') {
    res.end(JSON.stringify({
      project: path.basename(process.cwd()),
      root: process.cwd(),
      branch: null,
      provider: 'fake',
      provider_name: 'fake',
      model: 'fake-model'
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/runs') {
    for await (const _chunk of req) {}
    res.end(JSON.stringify({ run_id: 'run-1', status: 'running', beam_width: 1, max_turns: 100 }));
    return;
  }
  if (req.url === '/v1/runs/run-1/approvals') {
    res.end(JSON.stringify({ approvals: [] }));
    return;
  }
  if (req.url === '/v1/runs/run-1') {
    res.end(JSON.stringify({ run: { id: 'run-1', status: 'running', final_answer: null } }));
    return;
  }
  if (req.url.startsWith('/v1/runs/run-1/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    activeStreams.add(res);
    res.on('close', () => {
      activeStreams.delete(res);
      if (process.env.FAKE_SAMIZDAT_STREAM_CLOSED_FILE) {
        fs.writeFileSync(process.env.FAKE_SAMIZDAT_STREAM_CLOSED_FILE, 'closed');
      }
    });
    return;
  }
  if (req.url.startsWith('/v1/runs/run-1/journal')) {
    res.end(JSON.stringify({ events: [] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

if (process.env.FAKE_SAMIZDAT_PRINT_TOKEN_AND_STALL === '1') {
  console.log(`startup token: ${token}`);
  setInterval(() => {}, 1000);
} else {
  server.listen(port, '127.0.0.1');
}
function stop() {
  server.close(() => {
    fs.rmSync(tokenPath, { force: true });
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
