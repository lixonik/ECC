import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOOL_NAME = 'ecc_doctor_ping';

class ProbeFailure extends Error {}

function hasControlCharacter(value) {
  return [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
}

function normalizedEndpoint(baseURL) {
  let endpoint;
  try {
    endpoint = new URL(baseURL);
  } catch {
    throw new ProbeFailure('Provide a valid HTTP or HTTPS base URL.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new ProbeFailure('The base URL must use HTTP or HTTPS without embedded credentials or fragments.');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
  return endpoint;
}

function validatedModel(model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 512 || hasControlCharacter(model)) {
    throw new ProbeFailure('Provide a nonempty model identifier without control characters.');
  }
  return model;
}

function validatedTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ProbeFailure(`Probe timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return timeoutMs;
}

function normalizedThinking(value) {
  const thinking = value === true ? 'on' : value === false ? 'off' : value;
  if (thinking !== undefined && !['on', 'off'].includes(thinking)) throw new ProbeFailure('Thinking must be on or off.');
  return thinking;
}

function validateCredential(apiKey) {
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || hasControlCharacter(apiKey) || /\s/u.test(apiKey))) {
    throw new ProbeFailure('The API key must be a nonempty value without whitespace or control characters.');
  }
}

function normalizeOptions(options) {
  const endpoint = normalizedEndpoint(options.baseURL);
  const model = validatedModel(options.model);
  const timeoutMs = validatedTimeout(options.timeoutMs);
  const thinking = normalizedThinking(options.thinking);
  if (options.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(options.reasoningEffort)) {
    throw new ProbeFailure('Reasoning effort must be low, high or max.');
  }
  validateCredential(options.apiKey);
  return { ...options, endpoint, model, thinking, timeoutMs };
}

function probeBody(options, messages, toolChoice) {
  return {
    model: options.model,
    stream: true,
    max_tokens: 1024,
    messages,
    tools: [{ type: 'function', function: {
      name: TOOL_NAME,
      description: 'Return a fresh confirmation token for this diagnostic challenge without performing any external operation.',
      parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
    } }],
    tool_choice: toolChoice,
    ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking === 'on' ? 'enabled' : 'disabled' } }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  };
}

function validateStringFields(value, fields) {
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new ProbeFailure('The stream contains an invalid tool-call field.');
  }
}

function validateToolDelta(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new ProbeFailure('The stream contains an invalid tool-call delta.');
  if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index > 31) throw new ProbeFailure('The stream contains an invalid tool-call index.');
  validateStringFields(delta, ['id', 'type']);
  if (delta.function !== undefined) {
    if (!delta.function || typeof delta.function !== 'object' || Array.isArray(delta.function)) throw new ProbeFailure('The stream contains an invalid function delta.');
    validateStringFields(delta.function, ['name', 'arguments']);
  }
}

function mergeToolDelta(tools, delta) {
  validateToolDelta(delta);
  const previous = tools.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
  const fn = delta.function ?? {};
  const value = { id: previous.id + (delta.id ?? ''), type: delta.type ?? previous.type, function: {
    name: previous.function.name + (fn.name ?? ''),
    arguments: previous.function.arguments + (fn.arguments ?? ''),
  } };
  tools.set(delta.index, value);
}

function mergeCompletion(state, payload) {
  if (payload.error || !Array.isArray(payload.choices)) throw new ProbeFailure('The provider returned an invalid completion event.');
  const choice = payload.choices.find(item => item.index === 0);
  if (!choice) return;
  const delta = choice.delta;
  if (!delta || typeof delta !== 'object' || (delta.role !== undefined && delta.role !== 'assistant')) {
    throw new ProbeFailure('The provider returned an invalid assistant delta.');
  }
  state.received = true;
  for (const field of ['content', 'reasoning_content']) {
    if (delta[field] !== undefined && delta[field] !== null) {
      if (typeof delta[field] !== 'string') throw new ProbeFailure('The provider returned invalid streamed text.');
      state[field] += delta[field];
      if (field === 'reasoning_content') state.hasReasoning = true;
    }
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) throw new ProbeFailure('The provider returned invalid tool-call data.');
    for (const tool of delta.tool_calls) mergeToolDelta(state.tools, tool);
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new ProbeFailure('The provider response ended with an unsupported or truncated finish reason.');
    state.finished = true;
  }
}

function completionParser() {
  const state = { content: '', reasoning_content: '', hasReasoning: false, tools: new Map(), received: false, finished: false, done: false };
  let buffer = '';
  let data = [];
  const dispatch = () => {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    if (text.trim() === '[DONE]') { state.done = true; return; }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProbeFailure('The provider returned malformed JSON in the event stream.');
    }
    if (!payload || typeof payload !== 'object') throw new ProbeFailure('The provider returned an invalid event stream.');
    mergeCompletion(state, payload);
  };
  const line = value => {
    if (value === '') { dispatch(); return; }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  return {
    state,
    push(text) {
      buffer += text;
      let newline;
      while (!state.done && (newline = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
      }
    },
    finish() {
      if (!state.done) {
        if (buffer) line(buffer.replace(/\r$/, ''));
        dispatch();
      }
      if (!state.received || (!state.done && !state.finished)) throw new ProbeFailure('The event stream ended without a completed assistant response.');
      return { content: state.content, reasoning_content: state.reasoning_content, hasReasoning: state.hasReasoning,
        tool_calls: [...state.tools].sort((left, right) => left[0] - right[0]).map(([, tool]) => tool) };
    },
  };
}

async function readCompletion(response, budget) {
  if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    throw new ProbeFailure('The provider did not return a text/event-stream response.');
  }
  const parser = completionParser();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = response.body.getReader();
  try {
    while (!parser.state.done) {
      const { value, done } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_RESPONSE_BYTES) throw new ProbeFailure('The provider response exceeded the diagnostic byte limit.');
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    return parser.finish();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestCompletion(options, body, controller, budget) {
  const response = await fetch(options.endpoint, {
    method: 'POST', redirect: 'manual', signal: controller.signal,
    headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  try {
    if (response.status >= 300 && response.status < 400) throw new ProbeFailure('The provider returned a redirect; redirects are not followed.');
    if (!response.ok) throw new ProbeFailure(`The provider returned HTTP ${response.status}.`);
    return await readCompletion(response, budget);
  } finally {
    if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

function validateToolCall(completion, token) {
  const tools = completion.tool_calls;
  if (tools.length !== 1 || tools[0].type !== 'function' || tools[0].function.name !== TOOL_NAME || !tools[0].id) {
    throw new ProbeFailure('The model did not return the requested diagnostic tool call.');
  }
  let args;
  try { args = JSON.parse(tools[0].function.arguments); } catch { throw new ProbeFailure('The diagnostic tool arguments are not valid JSON.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || args.token !== token) {
    throw new ProbeFailure('The diagnostic tool arguments did not preserve the challenge token.');
  }
  return tools[0];
}

function replayAssistant(completion) {
  return { role: 'assistant', content: completion.content || null, tool_calls: completion.tool_calls,
    ...(completion.hasReasoning ? { reasoning_content: completion.reasoning_content } : {}) };
}

export async function probeModel(input = {}) {
  const checks = [];
  let options;
  try {
    options = normalizeOptions(input);
  } catch (error) {
    return { ok: false, checks: [{ id: 'model.options', status: 'fail', message: error instanceof ProbeFailure ? error.message : 'Invalid model probe options.' }], reasoningObserved: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const budget = { bytes: 0 };
  let current = 'model.stream';
  let reasoningObserved = false;
  try {
    const token = randomUUID();
    const messages = [{ role: 'user', content: `ECC_DOCTOR_TOKEN:${token}\nCall ${TOOL_NAME} exactly once with this token. After the tool result, reply with ECC_DOCTOR_OK: followed by the token received in that tool result.` }];
    const first = await requestCompletion(options, probeBody(options, messages, 'auto'), controller, budget);
    reasoningObserved = first.reasoning_content.length > 0;
    checks.push({ id: current, status: 'pass', message: 'The provider returned a completed streamed assistant response.' });
    current = 'model.tool-call';
    const tool = validateToolCall(first, token);
    checks.push({ id: current, status: 'pass', message: 'The model preserved the diagnostic tool name, arguments and call ID.' });
    current = 'model.round-trip';
    const confirmation = randomUUID();
    const secondMessages = [...messages, replayAssistant(first), { role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ token: confirmation, status: 'ok' }) }];
    const second = await requestCompletion(options, probeBody(options, secondMessages, 'none'), controller, budget);
    reasoningObserved ||= second.reasoning_content.length > 0;
    if (second.tool_calls.length !== 0 || !second.content.includes(`ECC_DOCTOR_OK:${confirmation}`)) {
      throw new ProbeFailure('The model did not confirm the diagnostic tool result in its final response.');
    }
    checks.push({ id: current, status: 'pass', message: 'The second streamed response confirmed the local tool result.' });
    return { ok: true, checks, reasoningObserved };
  } catch (error) {
    const message = controller.signal.aborted ? `Model probe timeout after ${options.timeoutMs} milliseconds.`
      : error instanceof ProbeFailure ? error.message : 'The model probe request failed; check endpoint connectivity, TLS and stream encoding.';
    return { ok: false, checks: [...checks, { id: current, status: 'fail', message }], reasoningObserved };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
