import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSamizdatClient } from './samizdat-client.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function canonicalWorkspace(cwd) {
  if (!path.isAbsolute(cwd)) throw new Error('Samizdat workspace cwd must be an absolute path');
  let root;
  try {
    root = await fs.realpath(cwd);
  } catch {
    throw new Error(`Samizdat workspace does not exist: ${cwd}`);
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`Samizdat workspace is not a directory: ${cwd}`);
  return root;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function clientOptions(config, baseUrl, token, home) {
  return {
    baseUrl,
    token,
    tokenProvider: async () => {
      if (token) return token;
      const url = new URL(baseUrl);
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return null;
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      try {
        return (await fs.readFile(path.join(home, '.config', 'samizdat', 'http', `${port}.token`), 'utf8')).trim();
      } catch {
        return null;
      }
    },
    fetchImpl: config.fetchImpl,
    requestTimeoutMs: config.requestTimeoutMs,
    startTimeoutMs: config.startTimeoutMs
  };
}

export function createServerManager({ config, spawnImpl = spawn, fetchImpl = fetch }) {
  const effectiveConfig = { ...config, fetchImpl };
  const home = config.home || process.env.HOME || os.homedir();
  const entries = new Map();
  const starting = new Map();
  let closed = false;

  async function verifyProject(client, cwd) {
    const project = await client.project();
    if (!project?.root) throw new Error('Samizdat did not report its workspace root');
    const actual = await fs.realpath(project.root);
    if (actual !== cwd) {
      throw new Error(`Samizdat is bound to a different workspace: ${project.root}`);
    }
    return project;
  }

  async function stopEntry(entry) {
    const child = entry?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      exited.then(() => true),
      delay(2000).then(() => false)
    ]);
    if (!stopped && child.exitCode === null) child.kill('SIGKILL');
  }

  async function startManaged(cwd) {
    if (closed) throw new Error('Samizdat server manager is closed');
    const httpPort = await freePort();
    const nreplPort = await freePort();
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    let binary = effectiveConfig.binary;
    if (path.isAbsolute(binary)) {
      try {
        await fs.access(binary, (await import('node:fs')).constants.X_OK);
      } catch {
        if (binary === `${home}/bin/samizdat`) binary = 'samizdat';
      }
    }

    const child = spawnImpl(binary, ['--headless'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        HARNESS_PORT: String(httpPort),
        HARNESS_NREPL_PORT: String(nreplPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const entry = { cwd, baseUrl, managed: true, child, client: null, diagnostics: '' };
    const capture = chunk => {
      entry.diagnostics = `${entry.diagnostics}${chunk}`.slice(-4000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    let spawnError = null;
    child.once('error', error => { spawnError = error; });

    const deadline = Date.now() + effectiveConfig.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Samizdat exited with code ${child.exitCode}`);
        try {
          const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) {
            entry.client = createSamizdatClient(clientOptions(effectiveConfig, baseUrl, effectiveConfig.token, home));
            await verifyProject(entry.client, cwd);
            entries.set(cwd, entry);
            return entry;
          }
        } catch (error) {
          if (entry.client) throw error;
        }
        await delay(50);
      }
      throw new Error(`Samizdat did not become ready within ${effectiveConfig.startupTimeoutMs} ms`);
    } catch (error) {
      let generatedToken = null;
      try {
        generatedToken = (await fs.readFile(
          path.join(home, '.config', 'samizdat', 'http', `${httpPort}.token`),
          'utf8'
        )).trim();
      } catch {}
      await stopEntry(entry);
      const suffix = entry.diagnostics.trim() ? `: ${entry.diagnostics.trim().slice(-500)}` : '';
      const safeSuffix = [effectiveConfig.token, generatedToken].filter(Boolean).reduce(
        (text, secret) => text.split(secret).join('[redacted]'),
        suffix
      );
      throw new Error(`Samizdat failed to start: ${error.message}${safeSuffix}`);
    }
  }

  async function clientFor(inputCwd) {
    if (closed) throw new Error('Samizdat server manager is closed');
    const cwd = await canonicalWorkspace(inputCwd);
    if (effectiveConfig.externalUrl) {
      const client = createSamizdatClient(clientOptions(
        effectiveConfig,
        effectiveConfig.externalUrl,
        effectiveConfig.token,
        home
      ));
      await verifyProject(client, cwd);
      return { client, cwd, baseUrl: effectiveConfig.externalUrl, managed: false };
    }

    const existing = entries.get(cwd);
    if (existing) {
      try {
        await verifyProject(existing.client, cwd);
        return existing;
      } catch {
        entries.delete(cwd);
        await stopEntry(existing);
      }
    }

    if (starting.has(cwd)) return starting.get(cwd);
    const promise = startManaged(cwd).finally(() => starting.delete(cwd));
    starting.set(cwd, promise);
    return promise;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...starting.values()]);
    const owned = [...entries.values()];
    entries.clear();
    await Promise.all(owned.map(stopEntry));
  }

  return { clientFor, close };
}
