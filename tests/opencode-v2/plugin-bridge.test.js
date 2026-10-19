const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-plugin-'));

for (const key of Object.keys(process.env)) {
  if (/^(ECC_|CLAUDE)/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: path.join(sandbox, 'home'),
  USERPROFILE: path.join(sandbox, 'home'),
  XDG_CONFIG_HOME: path.join(sandbox, 'config'),
  XDG_STATE_HOME: path.join(sandbox, 'state'),
  ECC_GATEGUARD: 'off',
});
fs.mkdirSync(process.env.HOME, { recursive: true });

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

function hookifyRule({ name, event, pattern, action, message }) {
  return `---\nname: ${name}\nenabled: true\nevent: ${event}\naction: ${action}\npattern: ${JSON.stringify(pattern)}\n---\n\n${message}\n`;
}

function createProject(name, files = {}) {
  const dir = path.join(sandbox, 'projects', name);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createEventQueue() {
  const pending = [];
  const waiters = [];
  return {
    push(event) {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else pending.push(event);
    },
    async *iterate(signal) {
      while (!signal.aborted) {
        const event = pending.length > 0
          ? pending.shift()
          : await new Promise(resolve => {
            waiters.push(resolve);
            signal.addEventListener('abort', () => resolve(null), { once: true });
          });
        if (event) yield event;
      }
    },
  };
}

function createFakeContext(projectDir, options = {}) {
  const hooks = {};
  const register = domain => async (name, callback) => {
    (hooks[`${domain}.${name}`] ??= []).push(callback);
    return { dispose: async () => {} };
  };
  const events = createEventQueue();
  const synthetic = [];
  const skills = [];
  const asserted = [];
  const ctx = {
    location: { directory: projectDir },
    options,
    tool: { hook: register('tool'), list: async () => [] },
    session: {
      hook: register('session'),
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: Date.now() } }),
      synthetic: async input => { synthetic.push(input); },
    },
    permission: { hook: register('permission'), assert: async input => { asserted.push(input); } },
    shell: { hook: register('shell') },
    skill: {
      transform: async callback => {
        callback({ get: id => skills.find(skill => skill.id === id), add: skill => skills.push(skill) });
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: ({ signal }) => events.iterate(signal) },
  };
  return { ctx, hooks, events, synthetic, skills, asserted };
}

async function trigger(hooks, key, event) {
  for (const callback of hooks[key] ?? []) await callback(event);
  return event;
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

function toolEvent(tool, input, extra = {}) {
  return { tool, input, sessionID: 'ses_test', agent: 'build', messageID: 'msg_1', id: `call_${Math.random().toString(36).slice(2)}`, ...extra };
}

async function main() {
  const { setupEcc, eccNote } = await import(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'plugin', 'ecc.js')).href);
  const results = [];
  const cleanups = [];
  const start = async (projectDir, options = {}) => {
    const fake = createFakeContext(projectDir, options);
    const cleanup = await setupEcc(fake.ctx, { root: repoRoot, shell: 'Bash', ...options });
    if (cleanup) cleanups.push(cleanup);
    return fake;
  };

  results.push(await test('setup registers ECC skills, shell env and the ECC note', async () => {
    const fake = await start(createProject('basics'));
    assert.ok(fake.skills.length > 300);
    const shell = await trigger(fake.hooks, 'shell.create.before', { command: 'ls', cwd: '.', timeout: 1, shell: '/bin/bash', env: {} });
    assert.strictEqual(shell.env.CLAUDE_PLUGIN_ROOT, path.resolve(repoRoot));
    const context = await trigger(fake.hooks, 'session.context', { sessionID: 'ses_test', agent: 'build', system: [], messages: [], tools: {}, options: {} });
    assert.ok(context.system.some(part => part.text === eccNote(path.resolve(repoRoot))));
  }));

  results.push(await test('config-protection blocks an edit of an existing lint config', async () => {
    const projectDir = createProject('config', { '.eslintrc.json': '{}\n' });
    const fake = await start(projectDir);
    await assert.rejects(
      trigger(fake.hooks, 'tool.execute.before', toolEvent('edit', { path: '.eslintrc.json', oldString: '{}', newString: '{"rules":{}}' })),
      /ECC hook blocked this Edit call[\s\S]*Modifying \.eslintrc\.json is not allowed/
    );
  }));

  results.push(await test('hookify prompt rules add context to the user prompt', async () => {
    const projectDir = createProject('prompt', { '.claude/hookify.warn-prompt.local.md': hookifyRule({ name: 'warn-prompt', event: 'prompt', pattern: 'marker-123', action: 'warn', message: 'PROMPT-NOTE' }) });
    const fake = await start(projectDir);
    const event = await trigger(fake.hooks, 'session.prompt', { sessionID: 'ses_prompt', messageID: 'msg_1', prompt: { text: 'please marker-123' }, delivery: 'queue' });
    assert.ok(event.prompt.text.startsWith('please marker-123'));
    assert.ok(event.prompt.text.includes('PROMPT-NOTE'));
  }));

  results.push(await test('hook warnings for a file write are appended to the tool result', async () => {
    const projectDir = createProject('file', { '.claude/hookify.warn-console.local.md': hookifyRule({ name: 'warn-console', event: 'file', pattern: 'console\\.log', action: 'warn', message: 'FILE-NOTE' }) });
    const fake = await start(projectDir);
    const before = toolEvent('write', { path: 'debug.js', content: 'console.log(1)\n' });
    await trigger(fake.hooks, 'tool.execute.before', before);
    const after = await trigger(fake.hooks, 'tool.execute.after', { ...before, status: 'completed', result: { content: [{ type: 'text', text: 'written' }] } });
    assert.strictEqual(after.result.content[0].text, 'written');
    assert.ok(after.result.content.some(part => part.text.includes('FILE-NOTE') && part.text.includes('<ecc-hook-feedback>')));
  }));

  results.push(await test('a blocking Stop hook resumes the session once with feedback', async () => {
    const projectDir = createProject('stop', { '.claude/hookify.require-check.local.md': hookifyRule({ name: 'require-check', event: 'stop', pattern: '.*', action: 'block', message: 'STOP-NOTE' }) });
    const fake = await start(projectDir);
    await trigger(fake.hooks, 'session.prompt', { sessionID: 'ses_stop', messageID: 'msg_1', prompt: { text: 'hi' }, delivery: 'queue' });
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_stop' } });
    await waitFor(() => fake.synthetic.length === 1);
    assert.strictEqual(fake.synthetic[0].resume, true);
    assert.ok(fake.synthetic[0].text.includes('STOP-NOTE'));
    await trigger(fake.hooks, 'session.prompt', { sessionID: 'ses_stop', messageID: 'msg_2', prompt: { text: fake.synthetic[0].text }, delivery: 'queue' });
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_stop' } });
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.strictEqual(fake.synthetic.length, 1, 'stop_hook_active must suppress a second continuation');
  }));

  results.push(await test('ecc_hook permission requests always prompt and hook allows lift asks', async () => {
    const fake = await start(createProject('permission'));
    const forced = await trigger(fake.hooks, 'permission.evaluate', { sessionID: 's', action: 'ecc_hook', resources: ['Bash'], effect: 'allow', metadata: { reason: 'confirm' } });
    assert.strictEqual(forced.effect, 'ask');
    const denied = await trigger(fake.hooks, 'permission.evaluate', { sessionID: 's', action: 'ecc_hook', resources: ['Bash'], effect: 'deny' });
    assert.strictEqual(denied.effect, 'deny');
    const untouched = await trigger(fake.hooks, 'permission.evaluate', { sessionID: 's', action: 'shell', resources: ['ls'], effect: 'ask', source: { type: 'tool', messageID: 'm', id: 'unknown' } });
    assert.strictEqual(untouched.effect, 'ask');
  }));

  results.push(await test('disabled hooks register no tool hooks but keep skills and the note', async () => {
    const fake = await start(createProject('disabled'), { hooks: false });
    assert.strictEqual(fake.hooks['tool.execute.before'], undefined);
    assert.ok(fake.skills.length > 300);
    assert.ok(fake.hooks['session.context']);
  }));

  results.push(await test('ECC_HOOKS_ENABLED=false in the environment wins over plugin options', async () => {
    process.env.ECC_HOOKS_ENABLED = 'false';
    try {
      const fake = await start(createProject('env-disabled'), { hooks: { enabled: true } });
      assert.strictEqual(fake.hooks['tool.execute.before'], undefined);
    } finally {
      delete process.env.ECC_HOOKS_ENABLED;
    }
  }));

  results.push(await test('skill selection limits registered skills', async () => {
    const fake = await start(createProject('skills'), { hooks: false, skills: ['tdd-workflow', 'security-review'] });
    assert.deepStrictEqual(fake.skills.map(skill => skill.id).sort(), ['security-review', 'tdd-workflow']);
  }));

  results.push(await test('compact skill catalog keeps every skill loadable but describes only ecc-guide', async () => {
    const fake = await start(createProject('compact-catalog'), { hooks: false, skillCatalog: 'compact' });
    assert.ok(fake.skills.length > 300);
    const advertised = fake.skills.filter(skill => skill.autoinvoke !== false && skill.description).map(skill => skill.id);
    assert.deepStrictEqual(advertised, ['ecc-guide']);
    const context = await trigger(fake.hooks, 'session.context', { sessionID: 'ses_compact', agent: 'build', system: [], messages: [], tools: {}, options: {} });
    const note = context.system.map(part => part.text).find(text => text.startsWith('More ECC skills are installed'));
    assert.ok(note && note.includes('tdd-workflow') && !note.includes('ecc-guide'));
    assert.ok(context.system.reduce((size, part) => size + part.text.length, 0) < 15000);
  }));

  results.push(await test('explicit skill catalog describes the listed skills', async () => {
    const fake = await start(createProject('listed-catalog'), { hooks: false, skillCatalog: ['tdd-workflow', 'angular-developer'] });
    const advertised = fake.skills.filter(skill => skill.autoinvoke !== false).map(skill => skill.id).sort();
    assert.deepStrictEqual(advertised.filter(id => ['angular-developer', 'tdd-workflow'].includes(id)), ['angular-developer', 'tdd-workflow']);
    assert.ok(!advertised.includes('security-review'));
  }));

  results.push(await test('plugin startup syncs the install it was loaded from', async () => {
    const installer = await import(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'install.js')).href);
    const { scheduleInstallSync } = await import(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'plugin', 'ecc.js')).href);
    const configDir = path.join(sandbox, 'synced-config');
    installer.install({ ...installer.parseArgs([]), configDir }, { log: () => {} });
    fs.rmSync(path.join(configDir, 'ecc-opencode-v2.install.json'));
    fs.writeFileSync(path.join(configDir, 'ecc-opencode-v2.install.json'), JSON.stringify({ files: {}, installOptions: {} }));
    fs.rmSync(path.join(configDir, 'agents', 'planner.md'));
    await start(createProject('sync'), { hooks: false, installDir: configDir });
    const report = await scheduleInstallSync(path.resolve(repoRoot), path.resolve(configDir), { info: () => {}, warn: () => {} });
    assert.ok(report && report.created >= 1, 'missing generated agent is recreated when the manifest does not record it');
    assert.ok(fs.existsSync(path.join(configDir, 'agents', 'planner.md')));
  }));

  for (const cleanup of cleanups) await cleanup();
  fs.rmSync(sandbox, { recursive: true, force: true });
  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
