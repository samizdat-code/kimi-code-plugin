import { createRunStream } from './run-stream.js';

export function createRunManager({ servers }) {
  const runs = new Map();
  let closed = false;

  function key(cwd, runId) {
    return `${cwd}\0${runId}`;
  }

  function wake(state) {
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
  }

  function startStream(state, since = 0) {
    state.stream = createRunStream({
      client: state.client,
      runId: state.runId,
      since,
      retryDelayMs: 25,
      onEvent: event => {
        state.events.push(event);
        if (event.event === 'run-finished') state.terminal = event.data;
        wake(state);
      },
      onError: error => {
        state.error = error;
        wake(state);
      }
    });
    state.stream.start();
  }

  async function route(cwd, runId) {
    if (closed) throw new Error('Samizdat run manager is closed');
    const connection = await servers.clientFor(cwd);
    const id = key(connection.cwd, runId);
    let state = runs.get(id);
    if (!state) {
      state = {
        ...connection,
        runId,
        events: [],
        waiters: new Set(),
        stream: null,
        terminal: null,
        error: null,
        started: null
      };
      runs.set(id, state);
      startStream(state);
    }
    return state;
  }

  async function finalResult(state) {
    const detail = await state.client.runDetail(state.runId);
    const run = detail?.run || detail;
    return {
      status: run?.status || state.terminal?.status || 'completed',
      runId: state.runId,
      cwd: state.cwd,
      finalAnswer: run?.final_answer ?? null,
      run
    };
  }

  async function pendingResult(state) {
    const detail = await state.client.approvals(state.runId);
    const approvals = (detail?.approvals || []).filter(item => item.status === 'pending');
    if (approvals.length === 0) return null;
    return { status: 'awaiting_approval', runId: state.runId, cwd: state.cwd, approvals };
  }

  async function waitForEvent(state, ms) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        state.waiters.delete(resolve);
        resolve();
      }, ms);
      state.waiters.add(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function wait({ runId, cwd, waitMs = 1000 }) {
    const state = await route(cwd, runId);
    const deadline = Date.now() + waitMs;
    while (true) {
      const pending = await pendingResult(state);
      if (pending) return pending;
      if (state.terminal) return finalResult(state);
      if (state.error) {
        return { status: 'error', runId, cwd: state.cwd, error: state.error.message };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          status: state.started?.status || 'running',
          runId,
          cwd: state.cwd,
          run: state.started
        };
      }
      await waitForEvent(state, Math.min(remaining, 50));
    }
  }

  async function spawn(input) {
    const connection = await servers.clientFor(input.cwd);
    const started = await connection.client.startRun(input);
    const runId = started.run_id || started.id;
    if (!runId) throw new Error('Samizdat did not return a run ID');
    const state = await route(connection.cwd, runId);
    state.started = started;
    return wait({ runId, cwd: connection.cwd, waitMs: input.waitMs ?? 25 });
  }

  async function status({ runId, cwd }) {
    const state = await route(cwd, runId);
    const pending = await pendingResult(state);
    if (pending) return pending;
    const detail = await state.client.runDetail(runId);
    const run = detail?.run || detail;
    return {
      status: run?.status || state.terminal?.status || 'running',
      runId,
      cwd: state.cwd,
      finalAnswer: run?.final_answer ?? null,
      run
    };
  }

  async function decideApproval(input) {
    const state = await route(input.cwd, input.runId);
    const detail = await state.client.approvals(input.runId);
    const approval = (detail?.approvals || []).find(item => item.id === input.approvalId && item.status === 'pending');
    if (!approval) throw new Error(`Pending approval not found: ${input.approvalId}`);
    const question = approval.kind === 'question';
    const body = { decision: input.decision };

    if (question) {
      if (!['answer', 'deny'].includes(input.decision)) {
        throw new Error('A question approval requires decision answer or deny');
      }
      if (input.always !== undefined) throw new Error('always is only valid for permission approvals');
      if (input.decision === 'answer') {
        if (!Array.isArray(input.answers)) throw new Error('A question answer requires positional answers');
        const expected = approval.questions?.length;
        if (expected !== undefined && input.answers.length !== expected) {
          throw new Error(`Expected ${expected} answers, received ${input.answers.length}`);
        }
        body.answers = input.answers;
      }
    } else {
      if (!['allow', 'deny'].includes(input.decision)) {
        throw new Error('A permission approval requires decision allow or deny');
      }
      if (input.answers !== undefined) throw new Error('answers are only valid for question approvals');
      if (input.always !== undefined) {
        if (typeof input.always !== 'boolean') throw new Error('always must be a boolean');
        body.always = input.always;
      }
    }
    if (input.note !== undefined) body.note = input.note;
    await state.client.decide(input.approvalId, body);
    return status(input);
  }

  async function message({ runId, cwd, text, branchId }) {
    const state = await route(cwd, runId);
    const body = { kind: 'message', payload: text };
    if (branchId !== undefined) body.branch_id = branchId;
    await state.client.post(`/v1/runs/${encodeURIComponent(runId)}/interventions`, body);
    return { status: 'running', runId, cwd: state.cwd };
  }

  async function control(input, action) {
    const state = await route(input.cwd, input.runId);
    const body = {};
    if (action === 'resume') {
      if (input.maxTurns !== undefined) body.max_turns = input.maxTurns;
      if (input.message !== undefined) body.message = input.message;
    }
    const result = await state.client.post(`/v1/runs/${encodeURIComponent(input.runId)}/${action}`, body);
    if (action === 'resume') {
      const journal = await state.client.journal(input.runId, 0);
      const cursor = journal?.events?.at(-1)?.id || state.stream?.cursor || 0;
      state.stream?.close();
      state.terminal = null;
      state.error = null;
      state.started = result;
      startStream(state, cursor);
    }
    return { status: result.status || (action === 'resume' ? 'running' : action), runId: input.runId, cwd: state.cwd };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const state of runs.values()) {
      state.stream?.close();
      wake(state);
    }
    await servers.close();
  }

  return {
    spawn,
    wait,
    status,
    decideApproval,
    message,
    interrupt: input => control(input, 'interrupt'),
    abort: input => control(input, 'abort'),
    resume: input => control(input, 'resume'),
    close
  };
}
