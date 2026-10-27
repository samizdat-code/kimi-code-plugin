import http from 'node:http';

export async function createFakeSamizdatServer({ root, token = 'fake-token' } = {}) {
  const runs = new Map();
  const approvals = new Map();
  const streams = new Set();
  const requests = [];
  let nextRun = 1;
  let nextEvent = 1;
  let eventRequests = 0;

  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  async function body(req) {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : {};
  }

  function emit(run, kind, data) {
    const event = { id: nextEvent++, kind, data };
    run.events.push(event);
    for (const stream of run.streams) {
      stream.write(`id: ${event.id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    return event;
  }

  function finishRun(runId, finalAnswer = null, status = 'completed') {
    const run = runs.get(runId);
    run.status = status;
    run.final_answer = finalAnswer;
    emit(run, 'run-finished', { status });
    for (const stream of run.streams) stream.end();
    run.streams.clear();
  }

  function addApproval(runId, approval) {
    const id = approval.id || `approval-${approvals.size + 1}`;
    const record = { id, run_id: runId, status: 'pending', kind: 'permission', ...approval };
    approvals.set(id, record);
    const run = runs.get(runId);
    for (const stream of run.streams) {
      stream.write(`event: approval\ndata: ${JSON.stringify({ id, status: 'pending', kind: record.kind })}\n\n`);
    }
    return record;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: { message: 'unauthorized' } });
    }
    if (url.pathname === '/v1/harness/project') {
      return json(res, 200, { root, project: 'fake', provider: 'fake', provider_name: 'fake', model: 'fake-model' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      const input = await body(req);
      requests.push({ path: url.pathname, body: input });
      const id = `run-${nextRun++}`;
      runs.set(id, {
        id,
        status: 'running',
        final_answer: null,
        provider: input.model || 'fake',
        model: 'fake-model',
        beam_width: input.beam_width || 1,
        max_turns: input.max_turns || 100,
        events: [],
        streams: new Set()
      });
      return json(res, 200, { run_id: id, status: 'running', beam_width: input.beam_width || 1, max_turns: input.max_turns || 100 });
    }

    let match = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (match && req.method === 'GET') {
      const run = runs.get(match[1]);
      if (!run) return json(res, 404, { error: { message: 'missing run' } });
      eventRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
      for (const event of run.events.filter(item => item.id > since)) {
        res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      run.streams.add(res);
      streams.add(res);
      res.on('close', () => { run.streams.delete(res); streams.delete(res); });
      return;
    }

    match = url.pathname.match(/^\/v1\/runs\/([^/]+)\/journal$/);
    if (match) {
      const run = runs.get(match[1]);
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, { events: run.events.filter(item => item.id > since) });
    }

    match = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approvals$/);
    if (match) {
      requests.push({ path: url.pathname, method: 'GET' });
      return json(res, 200, { approvals: [...approvals.values()].filter(item => item.run_id === match[1] && item.status === 'pending') });
    }

    match = url.pathname.match(/^\/v1\/approvals\/([^/]+)$/);
    if (match && req.method === 'POST') {
      const input = await body(req);
      requests.push({ path: url.pathname, body: input });
      const approval = approvals.get(match[1]);
      if (!approval) return json(res, 404, { error: { message: 'missing approval' } });
      approval.status = 'decided';
      approval.response = input;
      return json(res, 200, { status: 'decided' });
    }

    match = url.pathname.match(/^\/v1\/runs\/([^/]+)\/(interventions|interrupt|abort|resume)$/);
    if (match && req.method === 'POST') {
      const run = runs.get(match[1]);
      const action = match[2];
      const input = await body(req);
      requests.push({ path: url.pathname, body: input });
      if (action === 'interrupt' || action === 'abort') {
        finishRun(run.id, null, action === 'abort' ? 'aborted' : 'interrupted');
      } else if (action === 'resume') {
        run.status = 'running';
      }
      return json(res, 200, { run_id: run.id, status: run.status });
    }

    match = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (match) {
      const run = runs.get(match[1]);
      if (!run) return json(res, 404, { error: { message: 'missing run' } });
      const { events, streams: ignored, ...detail } = run;
      return json(res, 200, { run: detail });
    }

    return json(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    runs,
    approvals,
    requests,
    finishRun,
    addApproval,
    get eventRequests() { return eventRequests; },
    async close() {
      for (const stream of streams) stream.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
