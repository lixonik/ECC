const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const load = relative => import(pathToFileURL(path.join(repoRoot, 'opencode-v2', relative)).href);

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

const FAKE_OPENCODE = `
const fs = require('fs');
const { spawn } = require('child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const emit = event => process.stdout.write(JSON.stringify({ sessionID: 'ses_fake', timestamp: Date.now(), ...event }) + '\\n');
  if (process.env.FAKE_UNICODE) {
    const payload = Buffer.from(JSON.stringify({ sessionID: 'ses_unicode', type: 'text', part: { messageID: 'm', text: 'Привет \u{1f642}' } }) + '\\n');
    const split = payload.indexOf(Buffer.from('П')) + 1;
    process.stdout.write(payload.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 100));
    process.stdout.write(payload.subarray(split));
    return;
  }
  if (process.env.FAKE_TREE_PID_FILE) {
    const leaf = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.FAKE_TREE_PID_FILE, String(process.pid)); setTimeout(() => process.exit(0), Number(process.env.FAKE_LEAF_LIFETIME || 10000));'], { detached: process.env.FAKE_DETACHED_PARENT_EXIT === '1', stdio: process.env.FAKE_DETACHED_PARENT_EXIT ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true });
    leaf.unref();
    while (!fs.existsSync(process.env.FAKE_TREE_PID_FILE)) await new Promise(resolve => setTimeout(resolve, 20));
    if (process.env.FAKE_DETACHED_PARENT_EXIT) process.exit(0);
  }
  if (process.env.FAKE_INITIAL_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_INITIAL_DELAY)));
  const args = process.argv.slice(2);
  const steps = Number(process.env.FAKE_STEPS || 1);
  for (let step = 0; step < steps; step += 1) {
    emit({ type: 'step_start', part: { type: 'step-start' } });
    emit({ type: 'tool_use', part: { type: 'tool', id: 'call_' + step, tool: 'read', messageID: 'msg_' + step, state: { status: 'completed', input: { path: 'a.txt' }, output: 'file body' } } });
    emit({ type: 'step_finish', part: { type: 'step-finish', cost: 0.5, tokens: { input: 10, output: 2, reasoning: 1 } } });
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_DELAY || 0)));
  }
  emit({ type: 'text', part: { type: 'text', messageID: 'msg_final', text: 'ANSWER len=' + input.length + ' args=' + args.join(' ') + ' allowed=' + (process.env.ECC_HEADLESS_ALLOWED_TOOLS || '-') + ' hooks=' + process.env.ECC_HOOKS_ENABLED + ' depth=' + process.env.ECC_CLAUDE_SHIM_DEPTH } });
  process.exit(Number(process.env.FAKE_EXIT || 0));
});
`;

function capture() {
  let text = '';
  return { write: chunk => { text += chunk; }, get text() { return text; } };
}

function fixtureProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function assertProcessStopped(pid) {
  const deadline = Date.now() + 2000;
  while (fixtureProcessRunning(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(!fixtureProcessRunning(pid), `descendant ${pid} is still running`);
}

function killFixtureProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function main() {
  const shim = await load('claude-shim/claude.js');
  const guardLib = await load('lib/headless-guard.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-shim-'));
  const fake = path.join(dir, 'fake-opencode.cjs');
  fs.writeFileSync(fake, FAKE_OPENCODE);
  const baseEnv = { ...process.env, ECC_OPENCODE_BIN: fake, ECC_CLAUDE_SHIM_MODELS: JSON.stringify({ opus: 'company/flash#max', haiku: 'company/flash#fast' }) };
  delete baseEnv.ECC_CLAUDE_SHIM_DEPTH;
  const run = async (argv, { stdinText = '', env = {} } = {}) => {
    const stdout = capture();
    const stderr = capture();
    const code = await shim.runShim({ argv, stdinText, env: { ...baseEnv, ...env }, cwd: dir, stdout, stderr });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };
  const results = [];

  try {
    results.push(await test('parses the claude invocations ECC actually makes', () => {
      const summary = shim.parseClaudeArgs(['--model', 'haiku', '-p']);
      assert.deepStrictEqual([summary.print, summary.model, summary.positionals], [true, 'haiku', []]);
      const observer = shim.parseClaudeArgs(['--model', 'haiku', '--max-turns', '10', '--print', '--allowedTools', 'Read,Write', '-p', 'analyze this']);
      assert.deepStrictEqual([observer.maxTurns, observer.allowedTools, observer.positionals], [10, 'Read,Write', ['analyze this']]);
      const comply = shim.parseClaudeArgs(['-p', 'scenario', '--model', 'sonnet', '--max-turns', '5', '--allowedTools', 'Read,Bash', '--output-format', 'stream-json', '--verbose']);
      assert.deepStrictEqual([comply.outputFormat, comply.positionals], ['stream-json', ['scenario']]);
      assert.strictEqual(shim.parseClaudeArgs(['--output-format=json', 'hi']).outputFormat, 'json');
    }));

    results.push(await test('maps Claude model names through the tier map', () => {
      const models = { opus: 'c/m#max', sonnet: 'c/m#high', default: 'c/m' };
      assert.strictEqual(shim.resolveShimModel('opus', models), 'c/m#max');
      assert.strictEqual(shim.resolveShimModel('claude-sonnet-5-5', models), 'c/m#high');
      assert.strictEqual(shim.resolveShimModel('haiku', models), 'c/m');
      assert.strictEqual(shim.resolveShimModel('other/model', models), 'other/model');
      assert.strictEqual(shim.resolveShimModel(undefined, {}), undefined);
      assert.strictEqual(shim.resolveShimModel('haiku', { opus: 'c/m#max' }, 'c/m#high'), 'c/m#high', 'unmapped tiers follow the session model');
      assert.strictEqual(shim.resolveShimModel('opus', { opus: 'c/m#max' }, 'c/m#high'), 'c/m#max', 'an explicit tier map wins');
      assert.strictEqual(shim.resolveShimModel(undefined, { default: 'c/m' }, 'c/m#high'), 'c/m#high');
    }));

    results.push(await test('nested runs inherit the reasoning variant of the calling session', async () => {
      const result = await run(['-p', 'go'], { env: { ECC_OPENCODE_MODEL: 'company/flash#high', ECC_CLAUDE_SHIM_MODELS: '{}' } });
      assert.ok(result.stdout.includes('-m company/flash#high'), result.stdout);
    }));

    results.push(await test('text mode passes the prompt on stdin and prints the final answer', async () => {
      const prompt = 'y'.repeat(50000);
      const result = await run(['--model', 'opus', '-p'], { stdinText: prompt });
      assert.strictEqual(result.code, 0);
      assert.ok(result.stdout.startsWith(`ANSWER len=${prompt.length} `), result.stdout.slice(0, 120));
      assert.ok(result.stdout.includes('-m company/flash#max'));
      assert.ok(result.stdout.includes('hooks=false depth=1'));
    }));

    results.push(await test('allowed tools reach the inner OpenCode run', async () => {
      const result = await run(['-p', 'go', '--allowedTools', 'Read,Write']);
      assert.ok(result.stdout.includes('allowed=Read,Write'));
    }));

    results.push(await test('json and stream-json outputs follow the Claude Code shapes', async () => {
      const json = JSON.parse((await run(['-p', 'go', '--output-format', 'json'])).stdout);
      assert.deepStrictEqual([json.type, json.subtype, json.is_error, json.num_turns, json.session_id, json.total_cost_usd], ['result', 'success', false, 1, 'ses_fake', 0.5]);
      assert.deepStrictEqual(json.usage, { input_tokens: 10, output_tokens: 3 });
      const events = (await run(['-p', 'go', '--output-format', 'stream-json'])).stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.strictEqual(events[0].subtype, 'init');
      const toolUse = events.find(event => event.message?.content?.[0]?.type === 'tool_use');
      assert.strictEqual(toolUse.message.content[0].name, 'Read');
      assert.strictEqual(toolUse.message.content[0].input.file_path, path.join(dir, 'a.txt'));
      assert.ok(events.some(event => event.message?.content?.[0]?.type === 'tool_result' && event.message.content[0].content === 'file body'));
      assert.strictEqual(events.at(-1).type, 'result');
    }));

    results.push(await test('max-turns stops the run and reports error_max_turns', async () => {
      const result = await run(['-p', 'go', '--max-turns', '2', '--output-format', 'json'], { env: { FAKE_STEPS: '20', FAKE_DELAY: '150' } });
      const json = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.strictEqual(result.code, 1);
      assert.strictEqual(json.subtype, 'error_max_turns');
      assert.ok(json.num_turns >= 2 && json.num_turns < 20);
    }));

    results.push(await test('UTF-8 characters split between child output chunks stay intact', async () => {
      const result = await run(['-p', 'go'], { env: { FAKE_UNICODE: '1' } });
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, 'Привет \u{1f642}\n');
    }));

    results.push(await test('wall-clock timeout stops a run before its first response', async () => {
      const result = await run(['-p', 'go', '--output-format', 'json'], { env: { ECC_CLAUDE_SHIM_TIMEOUT_MS: '300', FAKE_INITIAL_DELAY: '1500' } });
      assert.strictEqual(result.code, 1);
      const json = JSON.parse(result.stdout.trim());
      assert.strictEqual(json.is_error, true);
      assert.strictEqual(json.subtype, 'error_timeout');
      assert.strictEqual(json.num_turns, 0);
      assert.ok(result.stderr.includes('timeout'), result.stderr);
    }));

    results.push(await test('invalid timeout configuration fails without starting OpenCode', async () => {
      for (const timeout of ['0', '-1', 'garbage', '1.5', '2147483648']) {
        const result = await run(['-p', 'go'], { env: { ECC_CLAUDE_SHIM_TIMEOUT_MS: timeout } });
        assert.strictEqual(result.code, 1, timeout);
        assert.strictEqual(result.stdout, '', timeout);
        assert.ok(result.stderr.includes('ECC_CLAUDE_SHIM_TIMEOUT_MS'), result.stderr);
      }
    }));

    results.push(await test('max-turns terminates descendants before resolving', async () => {
      const pidFile = path.join(dir, 'max-turns-leaf.pid');
      let leafPid;
      try {
        const result = await run(['-p', 'go', '--max-turns', '1', '--output-format', 'json'], { env: { FAKE_TREE_PID_FILE: pidFile, FAKE_STEPS: '20', FAKE_DELAY: '150' } });
        leafPid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.strictEqual(JSON.parse(result.stdout.trim()).subtype, 'error_max_turns');
        await assertProcessStopped(leafPid);
      } finally {
        leafPid ??= fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
        if (leafPid) killFixtureProcess(leafPid);
      }
    }));

    results.push(await test('timeout terminates a running descendant before returning', async () => {
      const pidFile = path.join(dir, 'timeout-leaf.pid');
      let leafPid;
      try {
        const pending = run(['-p', 'go', '--output-format', 'json'], { env: { ECC_CLAUDE_SHIM_TIMEOUT_MS: '5000', FAKE_TREE_PID_FILE: pidFile, FAKE_INITIAL_DELAY: '10000' } });
        const result = await pending;
        leafPid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.strictEqual(result.code, 1);
        assert.strictEqual(JSON.parse(result.stdout.trim()).subtype, 'error_timeout');
        await assertProcessStopped(leafPid);
      } finally {
        leafPid ??= fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
        if (leafPid) killFixtureProcess(leafPid);
      }
    }));

    if (process.platform === 'win32') {
      results.push(await test('timeout reports unconfirmed cleanup after a detached child outlives its parent', async () => {
        const pidFile = path.join(dir, 'orphan-leaf.pid');
        let leafPid;
        try {
          const result = await run(['-p', 'go', '--output-format', 'json'], { env: {
            ECC_CLAUDE_SHIM_TIMEOUT_MS: '5000',
            FAKE_TREE_PID_FILE: pidFile,
            FAKE_DETACHED_PARENT_EXIT: '1',
            FAKE_LEAF_LIFETIME: '60000',
          } });
          leafPid = Number(fs.readFileSync(pidFile, 'utf8'));
          assert.strictEqual(result.code, 1);
          assert.strictEqual(JSON.parse(result.stdout.trim()).subtype, 'error_timeout');
          assert.match(result.stderr, /descendant cleanup|process tree/);
        } finally {
          leafPid ??= fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
          if (leafPid) {
            killFixtureProcess(leafPid);
            await assertProcessStopped(leafPid);
          }
        }
      }));
    }

    results.push(await test('a missing binary emits one structured failure and releases its timeout', async () => {
      const result = await run(['-p', 'go', '--output-format', 'json'], { env: { ECC_OPENCODE_BIN: path.join(dir, 'missing-opencode-binary') } });
      assert.strictEqual(result.code, 1);
      const json = JSON.parse(result.stdout.trim());
      assert.strictEqual(json.subtype, 'error_during_execution');
      assert.strictEqual(json.is_error, true);
      assert.ok(result.stderr.includes('cannot start OpenCode'), result.stderr);
    }));

    results.push(await test('nested calls and empty prompts are refused', async () => {
      assert.strictEqual((await run(['-p', 'go'], { env: { ECC_CLAUDE_SHIM_DEPTH: '1' } })).code, 1);
      const empty = await run(['-p']);
      assert.strictEqual(empty.code, 1);
      assert.ok(empty.stderr.includes('no prompt'));
    }));

    results.push(await test('a failing OpenCode run fails the shim with its stderr', async () => {
      const result = await run(['-p', 'go'], { env: { FAKE_EXIT: '3' } });
      assert.strictEqual(result.code, 1);
    }));

    results.push(await test('headless guard enforces Claude allowedTools semantics', () => {
      const guard = guardLib.createHeadlessGuard({ ECC_HEADLESS_ALLOWED_TOOLS: 'Read,Write,Bash(git diff:*)', ECC_HEADLESS_DISALLOWED_TOOLS: 'Bash(git push:*)' });
      assert.ok(guard.allows({ name: 'Read', input: {} }));
      assert.ok(!guard.allows({ name: 'Edit', input: {} }));
      assert.ok(guard.allows({ name: 'Bash', input: { command: 'git diff --stat' } }));
      assert.ok(guard.allows({ name: 'PowerShell', input: { command: 'git diff' } }));
      assert.ok(!guard.allows({ name: 'Bash', input: { command: 'git push origin main' } }));
      assert.ok(!guard.allows({ name: 'Bash', input: { command: 'rm -rf /' } }));
      assert.strictEqual(guardLib.createHeadlessGuard({}), null);
    }));

    results.push(await test('ECC llm-summary gets a model summary through the shim from a mirrored transcript', async () => {
      const { createTranscriptMirror } = await load('lib/transcript.js');
      const { claudeShimEnv } = await load('plugin/ecc.js');
      const mirrorDir = path.join(dir, 'mirror');
      const mirror = createTranscriptMirror(mirrorDir, { cwd: dir });
      mirror.userPrompt('ses_sum', 'Add a login form with validation');
      mirror.toolUse('ses_sum', { messageID: 'msg_1', model: 'x', callID: 'c1', name: 'Write', input: { file_path: path.join(dir, 'login.ts'), content: 'x' } });
      mirror.toolResult('ses_sum', { callID: 'c1', text: 'written', isError: false });
      mirror.assistantText('ses_sum', { messageID: 'msg_2', model: 'x', text: 'Done: login form added.' });
      const saved = { ...process.env };
      const shimEnv = claudeShimEnv(repoRoot, { claudeShim: true }, process.env);
      Object.assign(process.env, shimEnv, { ECC_OPENCODE_BIN: fake });
      delete process.env.ECC_SKIP_LLM_SUMMARY;
      delete process.env.ECC_CLAUDE_SHIM_DEPTH;
      try {
        const { generateSessionSummary } = require(path.join(repoRoot, 'scripts', 'lib', 'llm-summary.js'));
        const skipped = [];
        const summary = generateSessionSummary(mirror.pathFor('ses_sum'), { onSkip: reason => skipped.push(reason) });
        assert.deepStrictEqual(skipped, []);
        assert.ok(typeof summary === 'string' && summary.startsWith('ANSWER '), String(summary));
        assert.ok(Number(/len=(\d+)/.exec(summary)[1]) > 200, 'the summary prompt with the transcript reached OpenCode on stdin');
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
    }));

    results.push(await test('launchers exist for POSIX shells and Windows', () => {
      const sh = fs.readFileSync(path.join(repoRoot, 'opencode-v2', 'claude-shim', 'claude'), 'utf8');
      const cmd = fs.readFileSync(path.join(repoRoot, 'opencode-v2', 'claude-shim', 'claude.cmd'), 'utf8');
      assert.ok(sh.startsWith('#!/usr/bin/env sh') && sh.includes('claude.js'));
      assert.ok(cmd.includes('%~dp0claude.js'));
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
