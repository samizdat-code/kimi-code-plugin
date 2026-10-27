import os from 'node:os';

function optional(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(env = process.env) {
  const home = env.HOME || os.homedir();
  return {
    binary: optional(env.SAMIZDAT_BIN) || `${home}/bin/samizdat`,
    externalUrl: optional(env.SAMIZDAT_URL)?.replace(/\/+$/, '') || null,
    token: optional(env.SAMIZDAT_TOKEN),
    requestTimeoutMs: 10000,
    startTimeoutMs: 150000,
    startupTimeoutMs: 30000
  };
}
