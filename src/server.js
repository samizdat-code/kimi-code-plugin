#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { createServerManager } from './server-manager.js';
import { createRunManager } from './runs.js';
import { errorResult, successResult } from './result.js';

const runProperties = {
  runId: { type: 'string', description: 'Samizdat run ID returned by spawn' },
  cwd: { type: 'string', description: 'Absolute workspace directory bound to the Samizdat server' }
};
const runRequired = ['runId', 'cwd'];
const approvalTriaging = 'If this returns pending approvals, triage them immediately like regular Kimi permissions, surface them to the user when needed, call decide_samizdat_approval, then wait again. Do not leave the run parked.';

const tools = [
  {
    name: 'spawn_samizdat_agent',
    description: `Start an isolated Samizdat coding agent with complete task context. ${approvalTriaging}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete self-contained task and relevant context' },
        cwd: runProperties.cwd,
        provider: { type: 'string', description: 'Optional Samizdat-configured provider alias' },
        maxTurns: { type: 'integer', minimum: 1 },
        beamWidth: { type: 'integer', minimum: 1 },
        tokenBudget: { type: 'integer', minimum: 1 },
        waitMs: { type: 'integer', minimum: 0, maximum: 30000 }
      },
      required: ['task', 'cwd'],
      additionalProperties: false
    }
  },
  {
    name: 'wait_samizdat_agent',
    description: `Wait for a Samizdat run, returning promptly for approvals or completion. ${approvalTriaging}`,
    inputSchema: {
      type: 'object',
      properties: { ...runProperties, waitMs: { type: 'integer', minimum: 0, maximum: 30000 } },
      required: runRequired,
      additionalProperties: false
    }
  },
  {
    name: 'get_samizdat_run',
    description: 'Inspect current Samizdat run metadata, final answer, and pending approvals without advancing its event cursor.',
    inputSchema: { type: 'object', properties: runProperties, required: runRequired, additionalProperties: false }
  },
  {
    name: 'decide_samizdat_approval',
    description: 'Submit Kimi-triaged permission decisions or user answers, then call wait_samizdat_agent to continue the run.',
    inputSchema: {
      type: 'object',
      properties: {
        ...runProperties,
        approvalId: { type: 'string' },
        decision: { type: 'string', enum: ['allow', 'deny', 'answer'] },
        answers: { type: 'array', description: 'Positional answers for an ask_human questionnaire' },
        note: { type: 'string' },
        always: { type: 'boolean', description: 'Remember an allowed permission for this Samizdat session' }
      },
      required: [...runRequired, 'approvalId', 'decision'],
      additionalProperties: false
    }
  },
  {
    name: 'message_samizdat_agent',
    description: 'Steer a running Samizdat agent with a text intervention, optionally for one branch.',
    inputSchema: {
      type: 'object',
      properties: { ...runProperties, text: { type: 'string' }, branchId: { type: 'string' } },
      required: [...runRequired, 'text'],
      additionalProperties: false
    }
  },
  ...['interrupt', 'abort'].map(action => ({
    name: `${action}_samizdat_agent`,
    description: `${action === 'interrupt' ? 'Interrupt a run and leave it resumable' : 'Abort a Samizdat run'}.`,
    inputSchema: { type: 'object', properties: runProperties, required: runRequired, additionalProperties: false }
  })),
  {
    name: 'resume_samizdat_agent',
    description: 'Resume an interrupted or exhausted Samizdat run and reopen approval attendance.',
    inputSchema: {
      type: 'object',
      properties: { ...runProperties, maxTurns: { type: 'integer', minimum: 1 }, message: { type: 'string' } },
      required: runRequired,
      additionalProperties: false
    }
  }
];

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function validateRun(args) {
  requiredString(args.runId, 'runId');
  requiredString(args.cwd, 'cwd');
  if (!path.isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path');
}

function validateWait(args) {
  if (args.waitMs !== undefined && (!Number.isInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 30000)) {
    throw new Error('waitMs must be an integer between 0 and 30000');
  }
}

function validatePositive(args, name) {
  if (args[name] !== undefined && (!Number.isInteger(args[name]) || args[name] < 1)) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function createMcpServer({ runs, token = null }) {
  const server = new Server(
    { name: 'samizdat', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments || {};
    try {
      let result;
      switch (request.params.name) {
        case 'spawn_samizdat_agent':
          requiredString(args.task, 'task');
          requiredString(args.cwd, 'cwd');
          if (!path.isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path');
          if (args.provider !== undefined) requiredString(args.provider, 'provider');
          validatePositive(args, 'maxTurns');
          validatePositive(args, 'beamWidth');
          validatePositive(args, 'tokenBudget');
          validateWait(args);
          result = await runs.spawn(args);
          break;
        case 'wait_samizdat_agent':
          validateRun(args);
          validateWait(args);
          result = await runs.wait(args);
          break;
        case 'get_samizdat_run':
          validateRun(args);
          result = await runs.status(args);
          break;
        case 'decide_samizdat_approval':
          validateRun(args);
          requiredString(args.approvalId, 'approvalId');
          if (!['allow', 'deny', 'answer'].includes(args.decision)) throw new Error('decision must be allow, deny, or answer');
          result = await runs.decideApproval(args);
          break;
        case 'message_samizdat_agent':
          validateRun(args);
          requiredString(args.text, 'text');
          if (args.branchId !== undefined) requiredString(args.branchId, 'branchId');
          result = await runs.message(args);
          break;
        case 'interrupt_samizdat_agent':
          validateRun(args);
          result = await runs.interrupt(args);
          break;
        case 'abort_samizdat_agent':
          validateRun(args);
          result = await runs.abort(args);
          break;
        case 'resume_samizdat_agent':
          validateRun(args);
          validatePositive(args, 'maxTurns');
          if (args.message !== undefined) requiredString(args.message, 'message');
          result = await runs.resume(args);
          break;
        default:
          throw new Error(`Unknown Samizdat tool: ${request.params.name}`);
      }
      return successResult(result);
    } catch (error) {
      return errorResult(error, token);
    }
  });
  return server;
}

async function main() {
  const config = loadConfig();
  const servers = createServerManager({ config });
  const runs = createRunManager({ servers });
  const server = createMcpServer({ runs, token: config.token });
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runs.close();
  };
  transport.onclose = close;
  process.on('SIGTERM', () => void close().then(() => process.exit(0)));
  process.on('SIGINT', () => void close().then(() => process.exit(0)));
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
