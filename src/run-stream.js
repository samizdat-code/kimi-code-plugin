const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createRunStream({ client, runId, since = 0, onEvent = () => {}, onError = () => {}, onReady = () => {}, retryDelayMs = 250 }) {
  let controller = null;
  let started = false;
  let closed = false;
  let failed = false;
  let cursor = since ? String(since) : null;
  let terminal = null;

  function emit(event) {
    if (closed) return;
    if (event.id !== null && event.id !== undefined) cursor = String(event.id);
    onEvent(event);
    if (event.event === 'run-finished' || event.kind === 'run-finished') {
      terminal = event.data;
      close();
    }
  }

  async function recover() {
    const journal = await client.journal(runId, cursor || 0);
    for (const row of journal?.events || []) {
      emit({ id: String(row.id), event: row.kind, data: row.data });
      if (closed) return;
    }
  }

  async function pump() {
    while (!closed && !failed) {
      try {
        if (cursor !== null) await recover();
        if (closed) return;
        const response = await client.openEvents(runId, {
          since: cursor || 0,
          lastEventId: cursor || undefined,
          signal: controller.signal
        });
        onReady();
        const parser = (await import('./sse.js')).createSseParser(emit);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.end();
        reader.releaseLock();
        if (!closed) await delay(retryDelayMs);
      } catch (error) {
        if (closed) return;
        if (/HTTP (400|401|403|404|409|410|422)\b/.test(error.message)) {
          failed = true;
          onError(error);
          return;
        }
        await delay(retryDelayMs);
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    controller = new AbortController();
    void pump();
  }

  function close() {
    if (closed) return;
    closed = true;
    controller?.abort();
  }

  return {
    start,
    close,
    get cursor() { return cursor; },
    get terminal() { return terminal; }
  };
}
