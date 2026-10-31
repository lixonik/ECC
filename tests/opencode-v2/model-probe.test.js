const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}\n    Error: ${error.message}`);
    return false;
  }
}

async function withProvider(handler, run) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const recorded = { body, headers: request.headers, path: request.url };
    requests.push(recorded);
    await handler(recorded, response, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await run({ baseURL, requests });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function event(delta, finish = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
}

function firstReply(body, response, overrides = {}) {
  const token = /ECC_DOCTOR_TOKEN:([a-zA-Z0-9-]+)/.exec(body.messages[0].content)?.[1];
  assert.ok(token, 'probe prompt must carry a challenge');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(event({ role: 'assistant', reasoning_content: 'Проверяю поток', content: null }));
  response.write(event({ tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: overrides.name ?? 'ecc_doctor_ping', arguments: '{"token":' } }] }));
  response.write(event({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(overrides.token ?? token) + '}' } }] }, 'tool_calls'));
  response.end('data: [DONE]\r\n\r\n');
  return token;
}

async function successfulProvider(request, response, turn) {
  if (turn === 1) {
    const token = /ECC_DOCTOR_TOKEN:([a-zA-Z0-9-]+)/.exec(request.body.messages[0].content)[1];
    const payload = Buffer.from(event({ role: 'assistant', reasoning_content: 'Проверяю поток', content: null })
      + event({ tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'ecc_doctor_', arguments: '{"token":' } }] })
      + event({ tool_calls: [{ index: 0, function: { name: 'ping', arguments: JSON.stringify(token) + '}' } }] }, 'tool_calls')
      + 'data: [DONE]\r\n\r\n');
    const split = payload.indexOf(Buffer.from('П')) + 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(payload.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 20));
    response.end(payload.subarray(split));
  } else {
    const token = JSON.parse(request.body.messages.at(-1).content).token;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': keepalive\n\n');
    response.end(event({ role: 'assistant', content: `ECC_DOCTOR_OK:${token}` }, 'stop') + 'data: [DONE]\n\n');
  }
}

async function main() {
  const { probeModel } = await import(pathToFileURL(path.resolve(__dirname, '../../opencode-v2/lib/model-probe.js')).href);
  const results = [];
  results.push(await test('streams fragmented UTF-8 and tool arguments and replays reasoning for a second round', async () => {
    await withProvider(successfulProvider, async ({ baseURL, requests }) => {
      const result = await probeModel({ baseURL: baseURL + '?tenant=fixture', model: 'local/model', apiKey: 'probe-test-sensitive-value', thinking: 'on', reasoningEffort: 'high', timeoutMs: 3000 });
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(result.reasoningObserved, true);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[0].path, '/v1/chat/completions?tenant=fixture');
      assert.strictEqual(requests[0].headers.authorization, 'Bearer probe-test-sensitive-value');
      assert.strictEqual(requests[0].body.stream, true);
      assert.strictEqual(requests[0].body.tool_choice, 'auto');
      assert.strictEqual(requests[1].body.tool_choice, 'none');
      assert.deepStrictEqual(requests[0].body.thinking, { type: 'enabled' });
      assert.strictEqual(requests[0].body.reasoning_effort, 'high');
      const assistant = requests[1].body.messages.find(message => message.role === 'assistant');
      assert.strictEqual(assistant.reasoning_content, 'Проверяю поток');
      assert.strictEqual(assistant.tool_calls[0].function.name, 'ecc_doctor_ping');
      assert.strictEqual(requests[1].body.messages.at(-1).tool_call_id, 'call_probe');
      assert.notStrictEqual(JSON.parse(assistant.tool_calls[0].function.arguments).token, JSON.parse(requests[1].body.messages.at(-1).content).token);
      assert.ok(result.checks.every(check => check.status === 'pass'));
      assert.ok(!JSON.stringify(result).includes('probe-test-sensitive-value'));
      assert.ok(!JSON.stringify(result).includes(baseURL));
    });
  }));

  results.push(await test('thinking can be disabled without claiming that a server used it', async () => {
    await withProvider((request, response, turn) => {
      if (turn === 1) firstReply(request.body, response);
      else successfulProvider(request, response, turn);
    }, async ({ baseURL, requests }) => {
      const result = await probeModel({ baseURL, model: 'local', thinking: 'off' });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(requests[0].body.thinking, { type: 'disabled' });
      assert.ok(!('reasoning_effort' in requests[0].body));
    });
  }));

  results.push(await test('thinking mode works with a provider that rejects forced named tools', async () => {
    await withProvider(async (request, response, turn) => {
      if (request.body.thinking?.type === 'enabled' && !['auto', 'none'].includes(request.body.tool_choice)) {
        response.writeHead(400);
        response.end('Named tool choice is unsupported with thinking.');
        return;
      }
      await successfulProvider(request, response, turn);
    }, async ({ baseURL, requests }) => {
      const result = await probeModel({ baseURL, model: 'local', thinking: 'on', reasoningEffort: 'high' });
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(requests.length, 2);
    });
  }));

  results.push(await test('an HTTP error exposes only the status code', async () => {
    await withProvider((_request, response) => { response.writeHead(401); response.end('secret body probe-test-sensitive-value'); }, async ({ baseURL }) => {
      const result = await probeModel({ baseURL, model: 'local', apiKey: 'probe-test-sensitive-value' });
      assert.strictEqual(result.ok, false);
      assert.ok(JSON.stringify(result).includes('401'));
      assert.ok(!JSON.stringify(result).includes('probe-test-sensitive-value'));
      assert.ok(!JSON.stringify(result).includes('secret body'));
    });
  }));

  results.push(await test('redirects are refused without forwarding credentials', async () => {
    await withProvider((_request, response) => { response.writeHead(302, { location: '/redirected' }); response.end(); }, async ({ baseURL, requests }) => {
      const result = await probeModel({ baseURL, model: 'local', apiKey: 'fixture' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(requests.length, 1);
      assert.ok(JSON.stringify(result).includes('redirect'));
    });
  }));

  results.push(await test('invalid URLs and options fail before any request', async () => {
    const invalid = [
      { baseURL: 'file:///tmp/test' },
      { baseURL: 'https://user:secret@example.invalid/v1' },
      { baseURL: 'https://example.invalid/v1#fragment' },
      { baseURL: 'not a URL' },
      { model: '' },
      { timeoutMs: 0 },
      { timeoutMs: 1.5 },
      { timeoutMs: 2147483648 },
      { thinking: 'maybe' },
      { reasoningEffort: 'unlimited' },
    ];
    for (const changed of invalid) {
      const result = await probeModel({ baseURL: 'https://example.invalid/v1', model: 'local', ...changed });
      assert.strictEqual(result.ok, false, JSON.stringify(changed));
      assert.strictEqual(result.checks[0].id, 'model.options');
      assert.ok(!JSON.stringify(result).includes('secret'));
    }
  }));

  results.push(await test('an absent event stream and malformed stream data fail clearly', async () => {
    for (const payload of ['not-json', JSON.stringify({ error: { message: 'provider private detail' } })]) {
      await withProvider((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${payload}\n\n`); }, async ({ baseURL }) => {
        const result = await probeModel({ baseURL, model: 'local' });
        assert.strictEqual(result.ok, false);
        assert.ok(!JSON.stringify(result).includes('provider private detail'));
      });
    }
    await withProvider((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); }, async ({ baseURL }) => {
      assert.strictEqual((await probeModel({ baseURL, model: 'local' })).ok, false);
    });
  }));

  results.push(await test('unexpected tools and invalid challenge arguments never execute or trigger a second call', async () => {
    for (const overrides of [{ name: 'shell' }, { token: 'wrong' }]) {
      await withProvider((request, response) => firstReply(request.body, response, overrides), async ({ baseURL, requests }) => {
        const result = await probeModel({ baseURL, model: 'local' });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(requests.length, 1);
        assert.ok(result.checks.some(check => check.id === 'model.tool-call' && check.status === 'fail'));
      });
    }
  }));

  results.push(await test('a text-only response does not pass tool compatibility', async () => {
    await withProvider((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(event({ content: 'hello' }, 'stop') + 'data: [DONE]\n\n'); }, async ({ baseURL }) => {
      const result = await probeModel({ baseURL, model: 'local' });
      assert.strictEqual(result.ok, false);
      assert.ok(result.checks.some(check => check.id === 'model.tool-call' && check.status === 'fail'));
    });
  }));

  results.push(await test('missing final challenge confirmation fails the second round', async () => {
    await withProvider((request, response, turn) => {
      if (turn === 1) firstReply(request.body, response);
      else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(event({ content: 'unrelated' }, 'stop') + 'data: [DONE]\n\n'); }
    }, async ({ baseURL }) => {
      const result = await probeModel({ baseURL, model: 'local' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.checks.at(-1).id, 'model.round-trip');
    });
  }));

  results.push(await test('one deadline bounds headers and stalled event streams', async () => {
    for (const flushHeaders of [false, true]) {
      await withProvider((_request, response) => {
        if (flushHeaders) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); }
      }, async ({ baseURL }) => {
        const started = Date.now();
        const result = await probeModel({ baseURL, model: 'local', timeoutMs: 100 });
        assert.strictEqual(result.ok, false);
        assert.ok(JSON.stringify(result).includes('timeout'));
        assert.ok(Date.now() - started < 3000);
      });
    }
  }));

  results.push(await test('oversized provider output is cancelled without exposing it', async () => {
    await withProvider((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + 'x'.repeat(1024 * 1024 + 32)); }, async ({ baseURL }) => {
      const result = await probeModel({ baseURL, model: 'local' });
      assert.strictEqual(result.ok, false);
      assert.ok(JSON.stringify(result).includes('byte limit'));
      assert.ok(JSON.stringify(result).length < 2000);
    });
  }));

  results.push(await test('non-string tool fields and invalid indices are rejected before a follow-up request', async () => {
    const malformed = [
      { index: 0, id: 123, function: { name: 'ecc_doctor_ping', arguments: '{}' } },
      { index: 0, id: { private: 'provider detail' }, function: { name: 'ecc_doctor_ping', arguments: '{}' } },
      { index: 0, id: 'call', function: { name: 123, arguments: '{}' } },
      { index: 0, id: 'call', function: { name: 'ecc_doctor_ping', arguments: {} } },
      { index: 0, id: 'call', function: 'not an object' },
      { index: '0', id: 'call', function: { name: 'ecc_doctor_ping', arguments: '{}' } },
      { index: 32, id: 'call', function: { name: 'ecc_doctor_ping', arguments: '{}' } },
    ];
    for (const tool of malformed) {
      await withProvider((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(event({ tool_calls: [tool] }, 'tool_calls') + 'data: [DONE]\n\n'); }, async ({ baseURL, requests }) => {
        const result = await probeModel({ baseURL, model: 'local' });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.checks.at(-1).id, 'model.stream');
        assert.strictEqual(requests.length, 1);
        assert.ok(!JSON.stringify(result).includes('provider detail'));
      });
    }
  }));

  results.push(await test('truncated or filtered completion cannot pass either diagnostic round', async () => {
    for (const reason of ['length', 'content_filter', 'unexpected']) {
      for (const failedRound of [1, 2]) {
        await withProvider((request, response, turn) => {
          if (turn === 1 && failedRound === 2) { firstReply(request.body, response); return; }
          const token = turn === 2 ? JSON.parse(request.body.messages.at(-1).content).token : 'unused';
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(event({ content: `ECC_DOCTOR_OK:${token}` }, reason) + 'data: [DONE]\n\n');
        }, async ({ baseURL }) => {
          const result = await probeModel({ baseURL, model: 'local' });
          assert.strictEqual(result.ok, false);
          assert.strictEqual(result.checks.at(-1).id, failedRound === 1 ? 'model.stream' : 'model.round-trip');
          assert.ok(JSON.stringify(result).includes('finish reason'));
        });
      }
    }
  }));

  results.push(await test('API keys with whitespace or control characters fail as safe option errors', async () => {
    for (const apiKey of ['', 'two words', 'line\r\nbreak', 123]) {
      const result = await probeModel({ baseURL: 'https://example.invalid/v1', model: 'local', apiKey });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.checks[0].id, 'model.options');
      assert.ok(!JSON.stringify(result).includes(String(apiKey)) || apiKey === '');
    }
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}\nFailed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
