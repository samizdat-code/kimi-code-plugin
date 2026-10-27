function redact(value, token) {
  const text = String(value ?? '');
  return token ? text.split(token).join('[redacted]') : text;
}

export function createSamizdatClient({
  baseUrl,
  token = null,
  fetchImpl = fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  requestTimeoutMs = 10000,
  startTimeoutMs = 150000,
  tokenProvider = null
}) {
  const base = baseUrl.replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, timeoutMs = requestTimeoutMs, headers = {} } = {}) {
    const authToken = token || (tokenProvider ? await tokenProvider() : null);
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    const requestHeaders = { ...headers };
    if (authToken) requestHeaders.Authorization = `Bearer ${authToken}`;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

    let response;
    let text;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Samizdat request timed out after ${timeoutMs} ms`);
      }
      throw new Error(`Samizdat request failed: ${redact(error.message, authToken)}`);
    } finally {
      clearTimeoutImpl(timer);
    }

    let decoded;
    try {
      decoded = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new Error(`Samizdat returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const message = decoded?.error?.message || decoded?.error || text || response.statusText;
      throw new Error(redact(`HTTP ${response.status}: ${message}`, authToken));
    }
    return decoded;
  }

  return {
    health: () => request('/health'),
    project: () => request('/v1/harness/project'),
    get: path => request(path),
    post: (path, body = {}) => request(path, { method: 'POST', body }),
    startRun: input => {
      const body = { problem: input.task };
      if (input.provider !== undefined) body.model = input.provider;
      if (input.maxTurns !== undefined) body.max_turns = input.maxTurns;
      if (input.beamWidth !== undefined) body.beam_width = input.beamWidth;
      if (input.tokenBudget !== undefined) body.token_budget = input.tokenBudget;
      return request('/v1/runs', { method: 'POST', body, timeoutMs: startTimeoutMs });
    },
    openEvents: async (runId, { since = 0, lastEventId, signal } = {}) => {
      const authToken = token || (tokenProvider ? await tokenProvider() : null);
      const headers = { Accept: 'text/event-stream' };
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
      const response = await fetchImpl(
        `${base}/v1/runs/${encodeURIComponent(runId)}/events?since=${encodeURIComponent(since)}`,
        { method: 'GET', headers, signal }
      );
      if (!response.ok) {
        const message = await response.text();
        throw new Error(redact(`HTTP ${response.status}: ${message || response.statusText}`, authToken));
      }
      return response;
    },
    runDetail: runId => request(`/v1/runs/${encodeURIComponent(runId)}`),
    journal: (runId, since = 0) => request(`/v1/runs/${encodeURIComponent(runId)}/journal?since=${encodeURIComponent(since)}&limit=200`),
    approvals: runId => request(`/v1/runs/${encodeURIComponent(runId)}/approvals`),
    decide: (approvalId, body) => request(`/v1/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body })
  };
}
