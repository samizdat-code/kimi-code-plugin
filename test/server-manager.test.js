import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServerManager } from '../src/server-manager.js';

const fakeBinary = fileURLToPath(new URL('./helpers/fake-samizdat-bin.js', import.meta.url));
fsSync.chmodSync(fakeBinary, 0o755);

async function workspace(t, prefix = 'samizdat-manager-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function config(home, overrides = {}) {
  return {
    binary: fakeBinary,
    externalUrl: null,
    token: null,
    requestTimeoutMs: 1000,
    startTimeoutMs: 2000,
    startupTimeoutMs: 3000,
    ...overrides
  };
}

function managedManager(t, home, overrides = {}) {
  const manager = createServerManager({ config: config(home, overrides) });
  t.after(() => manager.close());
  return manager;
}

test('clientFor rejects relative and missing workspaces', async t => {
  const home = await workspace(t);
  const manager = managedManager(t, home);
  await assert.rejects(manager.clientFor('relative/path'), /absolute/);
  await assert.rejects(manager.clientFor(path.join(home, 'missing')), /does not exist/);
});

test('managed servers start with separate ports and reuse per canonical workspace', async t => {
  const home = await workspace(t);
  const project = await workspace(t);
  const manager = managedManager(t, home, { home });
  const [first, second] = await Promise.all([manager.clientFor(project), manager.clientFor(project)]);
  assert.equal(first.baseUrl, second.baseUrl);
  assert.equal(first.managed, true);
  assert.equal(first.cwd, await fs.realpath(project));
  assert.equal((await first.client.project()).model, 'fake-model');
});

test('different workspaces get different managed servers', async t => {
  const home = await workspace(t);
  const one = await workspace(t);
  const two = await workspace(t);
  const manager = managedManager(t, home, { home });
  const first = await manager.clientFor(one);
  const second = await manager.clientFor(two);
  assert.notEqual(first.baseUrl, second.baseUrl);
  assert.notEqual(first.cwd, second.cwd);
});

test('symlinked workspace paths resolve to the same managed server', async t => {
  const home = await workspace(t);
  const project = await workspace(t);
  const link = path.join(home, 'project-link');
  await fs.symlink(project, link);
  const manager = managedManager(t, home, { home });
  const direct = await manager.clientFor(project);
  const linked = await manager.clientFor(link);
  assert.equal(direct.baseUrl, linked.baseUrl);
  assert.equal(linked.cwd, direct.cwd);
});

test('external mode verifies the project root and does not stop the server', async t => {
  const home = await workspace(t);
  const project = await fs.realpath(home);
  const external = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/harness/project') {
      res.end(JSON.stringify({ root: project, provider: 'fake', model: 'external-model' }));
    } else {
      res.end(JSON.stringify({ status: 'ok' }));
    }
  });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const { port } = external.address();
  t.after(() => new Promise(resolve => external.close(resolve)));
  const manager = managedManager(t, home, {
    externalUrl: `http://127.0.0.1:${port}`,
    token: 'external-token'
  });
  const connected = await manager.clientFor(home);
  assert.equal(connected.managed, false);
  assert.equal((await connected.client.project()).model, 'external-model');
  await manager.close();
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
});

test('external mode refuses a mismatched project before starting a run', async t => {
  const home = await workspace(t);
  const other = await workspace(t);
  const external = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ root: other }));
  });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const { port } = external.address();
  t.after(() => new Promise(resolve => external.close(resolve)));
  const manager = managedManager(t, home, { externalUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(manager.clientFor(home), /bound to a different workspace/);
});

test('managed startup failures are concise and allow close without errors', async t => {
  const home = await workspace(t);
  const project = await workspace(t);
  const manager = managedManager(t, home, {
    home,
    binary: path.join(home, 'missing-binary'),
    startupTimeoutMs: 100
  });
  await assert.rejects(manager.clientFor(project), /failed to start|not found|ENOENT/i);
  await manager.close();
});

test('external loopback mode loads its token from the Samizdat token file', async t => {
  const home = await workspace(t);
  const external = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer file-token') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    res.end(JSON.stringify({ root: home, provider: 'fake', model: 'file-authenticated' }));
  });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  const { port } = external.address();
  t.after(() => new Promise(resolve => external.close(resolve)));
  const tokenDir = path.join(home, '.config', 'samizdat', 'http');
  await fs.mkdir(tokenDir, { recursive: true });
  await fs.writeFile(path.join(tokenDir, `${port}.token`), 'file-token', { mode: 0o600 });
  const manager = managedManager(t, home, {
    home,
    externalUrl: `http://127.0.0.1:${port}`,
    token: null
  });
  const connected = await manager.clientFor(home);
  assert.equal((await connected.client.project()).model, 'file-authenticated');
});

test('failed readiness redacts the generated token and terminates the live child', async t => {
  const home = await workspace(t);
  const project = await workspace(t);
  const manager = createServerManager({
    config: config(home, { home, startupTimeoutMs: 500 }),
    spawnImpl: (binary, args, options) => {
      return spawn(binary, args, {
        ...options,
        env: { ...options.env, FAKE_SAMIZDAT_PRINT_TOKEN_AND_STALL: '1' }
      });
    }
  });
  t.after(() => manager.close());
  let failure;
  try {
    await manager.clientFor(project);
    assert.fail('startup should fail');
  } catch (error) {
    failure = error;
  }
  assert.doesNotMatch(failure.message, /fake-samizdat-token/);
  assert.match(failure.message, /\[redacted\]/);
  const tokenDir = path.join(home, '.config', 'samizdat', 'http');
  const files = await fs.readdir(tokenDir);
  assert.deepEqual(files, []);
});
