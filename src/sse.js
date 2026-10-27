export function createSseParser(onEvent) {
  let buffer = '';
  let event = null;

  function dispatch() {
    if (!event) return;
    if (event.dataLines.length > 0) {
      const raw = event.dataLines.join('\n');
      let data = raw;
      try { data = JSON.parse(raw); } catch {}
      onEvent({ id: event.id, event: event.name || 'message', data });
    }
    event = null;
  }

  function line(value) {
    if (!event) event = { id: null, name: null, dataLines: [] };
    if (!value || value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon === -1 ? value : value.slice(0, colon);
    let data = colon === -1 ? '' : value.slice(colon + 1);
    if (data.startsWith(' ')) data = data.slice(1);
    if (field === 'event') event.name = data;
    if (field === 'id' && !data.includes('\0')) event.id = data;
    if (field === 'data') event.dataLines.push(data);
  }

  return {
    push(chunk) {
      buffer += chunk;
      while (true) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) return;
        if (match[0] === '\r' && match.index + 1 === buffer.length) return;
        const current = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (current === '') dispatch();
        else line(current);
      }
    },
    end() {
      buffer = '';
      event = null;
    }
  };
}
