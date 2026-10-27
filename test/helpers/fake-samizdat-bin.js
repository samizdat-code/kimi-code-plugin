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

const server = http.createServer((req, res) => {
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
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(port, '127.0.0.1');
function stop() {
  server.close(() => {
    fs.rmSync(tokenPath, { force: true });
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
