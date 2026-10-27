import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.name === 'samizdat', 'Plugin manifest name must be samizdat');
assert(typeof manifest.version === 'string' && manifest.version.length > 0, 'Plugin version is required');
assert(manifest.mcpServers?.samizdat?.command === 'node', 'Samizdat MCP server must use node');
assert(JSON.stringify(manifest.mcpServers.samizdat.args) === JSON.stringify(['./src/server.js']), 'Unexpected MCP entry point');
assert(manifest.mcpServers.samizdat.cwd === './', 'MCP cwd must remain inside the plugin root');
assert(manifest.mcpServers.samizdat.toolTimeoutMs >= 150000, 'MCP timeout must cover Samizdat run-start latency');
assert(manifest.systemPrompt.includes('decide_samizdat_approval'), 'Approval triage guidance is required');
assert(pkg.type === 'module', 'Package must use ESM');
assert(pkg.dependencies?.['@modelcontextprotocol/sdk'], 'MCP SDK dependency is required');
assert(pkg.scripts?.test === 'node --test test/*.test.js', 'Unexpected test command');
await fs.access(path.join(root, 'README.md'));

const sourceDir = path.join(root, 'src');
const files = (await fs.readdir(sourceDir)).filter(file => file.endsWith('.js'));
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', path.join(sourceDir, file)], { encoding: 'utf8' });
  assert(checked.status === 0, `Syntax check failed for src/${file}: ${checked.stderr}`);
}

console.log(`Checked manifest, package metadata, README, and ${files.length} source files.`);
