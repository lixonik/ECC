import http from 'node:http';

const SCENARIO_MARKER = /\[\[scenario:([a-z0-9-]+)\]\]/;
const COMPACTION_SUMMARY = [
  '## Objective', '- Answer the smoke prompt.', '',
  '## Requirements', '- (none)', '',
  '## Decisions', '- (none)', '',
  '## Work State', '### Completed', '- Answered the prompt.', '', '### Active', '- (none)', '', '### Blocked', '- (none)', '',
  '## Next Move', '1. (none)', '',
  '## Relevant Files', '- (none)', '',
  '## Important Context', '- (none)',
].join('\n');

export function startMockProvider(scenarios) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = safeJson(body);
      const record = { path: request.url, method: request.method, body: parsed };
      requests.push(record);
      if (request.method === 'GET' && /\/models$/.test(request.url)) {
        respondJson(response, { object: 'list', data: [{ id: 'scripted', object: 'model', owned_by: 'mock' }] });
        return;
      }
      if (!/\/chat\/completions$/.test(request.url) || !parsed) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `mock provider does not serve ${request.url}` } }));
        return;
      }
      const step = nextStep(parsed, scenarios);
      record.step = step;
      if (parsed.stream) streamCompletion(response, step);
      else respondJson(response, completion(step));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

export function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  }
  return '';
}

function nextStep(body, scenarios) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter(message => message.role === 'system').map(messageText).join('\n');
  if (/title generator/i.test(system)) return { text: 'Smoke session' };
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  if (lastUser && /structured summary/i.test(messageText(lastUser)) && messageText(lastUser).includes('## Objective')) {
    return { text: COMPACTION_SUMMARY };
  }
  const anchorIndex = findLastIndex(messages, message => message.role === 'user' && SCENARIO_MARKER.test(messageText(message)));
  if (anchorIndex === -1) return { text: 'No scenario marker found.' };
  const name = SCENARIO_MARKER.exec(messageText(messages[anchorIndex]))[1];
  const steps = scenarios[name];
  if (!steps) return { text: `Unknown scenario ${name}.` };
  const turns = messages.slice(anchorIndex + 1).filter(message => message.role === 'assistant').length;
  const step = steps[Math.min(turns, steps.length - 1)];
  return typeof step === 'function' ? step({ messages, system, body }) : step;
}

function completion(step) {
  const message = step.tool
    ? { role: 'assistant', content: step.text ?? null, tool_calls: [toolCall(step)] }
    : { role: 'assistant', content: step.text };
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'scripted',
    choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function streamCompletion(response, step) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'scripted' };
  const send = payload => response.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`);
  if (step.tool) {
    if (step.text) send({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall(step) }] }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  response.end('data: [DONE]\n\n');
}

function toolCall(step) {
  return { id: `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } };
}

function respondJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i])) return i;
  return -1;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
