export function successResult(result) {
  const text = typeof result?.finalAnswer === 'string' && result.status !== 'running'
    ? result.finalAnswer
    : JSON.stringify(result, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result
  };
}

export function errorResult(error, token = null) {
  let text = String(error?.message || error);
  if (token) text = text.split(token).join('[redacted]');
  return {
    isError: true,
    content: [{ type: 'text', text }]
  };
}
