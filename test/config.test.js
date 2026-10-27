import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig uses the installed binary and bounded defaults', () => {
  const config = loadConfig({ HOME: '/home/test' });
  assert.equal(config.binary, '/home/test/bin/samizdat');
  assert.equal(config.externalUrl, null);
  assert.equal(config.token, null);
  assert.equal(config.requestTimeoutMs, 10000);
  assert.equal(config.startTimeoutMs, 150000);
  assert.equal(config.startupTimeoutMs, 30000);
});

test('loadConfig honors Samizdat overrides and normalizes the URL', () => {
  const config = loadConfig({
    HOME: '/home/test',
    SAMIZDAT_BIN: '/opt/samizdat-custom',
    SAMIZDAT_URL: 'http://127.0.0.1:4999/',
    SAMIZDAT_TOKEN: 'secret-token'
  });
  assert.equal(config.binary, '/opt/samizdat-custom');
  assert.equal(config.externalUrl, 'http://127.0.0.1:4999');
  assert.equal(config.token, 'secret-token');
});

test('loadConfig treats blank optional values as absent', () => {
  const config = loadConfig({ HOME: '/home/test', SAMIZDAT_URL: '  ', SAMIZDAT_TOKEN: '' });
  assert.equal(config.externalUrl, null);
  assert.equal(config.token, null);
});
