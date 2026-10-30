const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-plugin-'));

const originalEnvironment = { ...process.env };

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
  const skillTransforms = [];
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
        skillTransforms.push(callback);
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: ({ signal }) => events.iterate(signal) },
  };
  const applySkillTransforms = () => {
    skills.splice(0, skills.length);
    const editor = { get: id => skills.find(skill => skill.id === id), add: skill => skills.push(skill) };
    for (const callback of skillTransforms) callback(editor);
  };
  return { ctx, hooks, events, synthetic, skills, asserted, applySkillTransforms };
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
    fake.applySkillTransforms();
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

  const runTurn = async (fake, sessionID, { writes = [], reviewer = null, childWrites = [] } = {}) => {
    await trigger(fake.hooks, 'session.prompt', { sessionID, messageID: `m_${Math.random()}`, prompt: { text: 'do the work' }, delivery: 'queue' });
    for (const file of writes) {
      const before = toolEvent('write', { path: file, content: 'x\n' }, { sessionID });
      await trigger(fake.hooks, 'tool.execute.before', before);
      await trigger(fake.hooks, 'tool.execute.after', { ...before, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    for (const file of childWrites) {
      const before = toolEvent('write', { path: file, content: 'x\n' }, { sessionID: `${sessionID}_child` });
      await trigger(fake.hooks, 'tool.execute.after', { ...before, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    if (reviewer) {
      const review = toolEvent('subagent', { agent: reviewer, description: 'review', prompt: 'review' }, { sessionID });
      await trigger(fake.hooks, 'tool.execute.before', review);
      await trigger(fake.hooks, 'tool.execute.after', { ...review, status: 'completed', result: { content: [{ type: 'text', text: 'review completed' }] } });
    }
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID } });
    await new Promise(resolve => setTimeout(resolve, 1500));
  };

  const startGated = async (name, options = {}) => {
    const fake = await start(createProject(name), { hooks: { enabled: true, profile: 'minimal', disabled: ['stop:session-end', 'stop:evaluate-session', 'stop:cost-tracker'] }, reviewGate: true, ...options });
    fake.ctx.session.get = async ({ sessionID }) => (sessionID.endsWith('_child')
      ? { id: sessionID, parentID: sessionID.replace(/_child$/, ''), time: { created: Date.now() } }
      : { id: sessionID, time: { created: Date.now() } });
    return fake;
  };

  results.push(await test('review gate fires once per turn with the changed files', async () => {
    const fake = await startGated('gate-once');
    await runTurn(fake, 'ses_gate', { writes: ['src/a.ts', 'src/b.ts'] });
    assert.strictEqual(fake.synthetic.length, 1);
    assert.ok(fake.synthetic[0].resume === true && fake.synthetic[0].text.includes('Review gate: you changed 2 file(s)'));
    assert.ok(fake.synthetic[0].text.includes('- src/a.ts') && fake.synthetic[0].text.includes('`code-reviewer`'));
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_gate' } });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.strictEqual(fake.synthetic.length, 1, 'the gate does not fire twice in one turn');
    await runTurn(fake, 'ses_gate', { writes: ['src/c.ts'] });
    assert.strictEqual(fake.synthetic.length, 2, 'a new user turn re-arms the gate');
  }));

  results.push(await test('review gate stays quiet without changes or after a reviewer ran', async () => {
    const fake = await startGated('gate-quiet', { reviewGate: { agent: 'typescript-reviewer' } });
    await runTurn(fake, 'ses_none');
    await runTurn(fake, 'ses_reviewed', { writes: ['src/a.ts'], reviewer: 'security-reviewer' });
    assert.strictEqual(fake.synthetic.length, 0);
    await runTurn(fake, 'ses_custom', { writes: ['src/a.ts'] });
    assert.ok(fake.synthetic[0].text.includes('`typescript-reviewer`'));
  }));

  results.push(await test('review gate refuses a failed reviewer and rechecks edits made after a completed review', async () => {
    const fake = await startGated('gate-review-completion');
    const sessionID = 'ses_gate_completion';
    await trigger(fake.hooks, 'session.prompt', { sessionID, messageID: 'm_start', prompt: { text: 'implement' }, delivery: 'queue' });
    const edit = toolEvent('write', { path: 'src/a.ts', content: 'first' }, { sessionID });
    await trigger(fake.hooks, 'tool.execute.after', { ...edit, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    const failedReview = toolEvent('subagent', { agent: 'code-reviewer', prompt: 'review' }, { sessionID });
    await trigger(fake.hooks, 'tool.execute.before', failedReview);
    await trigger(fake.hooks, 'tool.execute.after', { ...failedReview, status: 'error', error: 'review unavailable' });
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID } });
    await waitFor(() => fake.synthetic.length === 1);
    assert.ok(fake.synthetic[0].text.includes('Review gate:'));
    const review = toolEvent('subagent', { agent: 'code-reviewer', prompt: 'review' }, { sessionID });
    await trigger(fake.hooks, 'tool.execute.before', review);
    await trigger(fake.hooks, 'tool.execute.after', { ...review, status: 'completed', result: { content: [{ type: 'text', text: 'review completed' }] } });
    const laterEdit = toolEvent('write', { path: 'src/a.ts', content: 'second' }, { sessionID });
    await trigger(fake.hooks, 'tool.execute.after', { ...laterEdit, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID } });
    await waitFor(() => fake.synthetic.length === 2);
    assert.ok(fake.synthetic[1].text.includes('Review gate:'));
  }));

  results.push(await test('review gate detects shell-generated files in Git without claiming the initial dirty tree', async () => {
    const { execFileSync } = require('child_process');
    const projectDir = createProject('gate-shell', { 'owner.ts': 'owner change' });
    execFileSync('git', ['init', '-q', projectDir]);
    const fake = await start(projectDir, { hooks: { enabled: true, profile: 'minimal', disabled: ['stop:session-end', 'stop:evaluate-session', 'stop:cost-tracker'] }, reviewGate: true });
    await runTurn(fake, 'ses_initial_dirty');
    assert.strictEqual(fake.synthetic.length, 0);
    const sessionID = 'ses_shell_change';
    await trigger(fake.hooks, 'session.prompt', { sessionID, messageID: 'm_shell', prompt: { text: 'generate' }, delivery: 'queue' });
    fs.writeFileSync(path.join(projectDir, 'generated.ts'), 'new code');
    fake.events.push({ type: 'session.execution.succeeded', data: { sessionID } });
    await waitFor(() => fake.synthetic.length === 1);
    assert.ok(fake.synthetic[0].text.includes('- generated.ts'));
    assert.ok(!fake.synthetic[0].text.includes('- owner.ts'));
  }));

  results.push(await test('review gate counts subagent edits toward the parent turn', async () => {
    const fake = await startGated('gate-child');
    await runTurn(fake, 'ses_parent', { childWrites: ['src/child.ts'] });
    assert.strictEqual(fake.synthetic.length, 1);
    assert.ok(fake.synthetic[0].text.includes('- src/child.ts'));
  }));

  results.push(await test('auto catalog follows the project stack and suggests skills per prompt', async () => {
    const projectDir = createProject('auto-catalog', {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' }, devDependencies: { typescript: '^5.8.0' } }),
      'tsconfig.json': '{}',
      'angular.json': '{}',
    });
    const fake = await start(projectDir, { hooks: false, skillCatalog: 'auto' });
    const advertised = fake.skills.filter(skill => skill.autoinvoke !== false).map(skill => skill.id);
    assert.ok(advertised.includes('angular-developer') && advertised.includes('tdd-workflow'));
    assert.ok(!advertised.includes('django-patterns'));
    const english = await trigger(fake.hooks, 'session.prompt', { sessionID: 'ses_auto', messageID: 'm1', prompt: { text: 'make the table accessible for screen readers' }, delivery: 'queue' });
    assert.ok(english.prompt.text.startsWith('make the table accessible for screen readers\n\n<ecc-skill-suggestions>'));
    assert.ok(english.prompt.text.includes('- accessibility:'));
    const russian = await trigger(fake.hooks, 'session.prompt', { sessionID: 'ses_auto', messageID: 'm2', prompt: { text: 'Создай компонент формы входа' }, delivery: 'queue' });
    assert.strictEqual(russian.prompt.text, 'Создай компонент формы входа');
    const full = await start(createProject('full-catalog'), { hooks: false });
    assert.strictEqual(full.hooks['session.prompt'], undefined, 'no suggestions when every skill is already described');
  }));

  results.push(await test('model refs keep the reasoning variant', async () => {
    const { formatModelRef } = await import(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'plugin', 'ecc.js')).href);
    assert.strictEqual(formatModelRef({ providerID: 'company', id: 'deepseek-v4-flash', variant: 'high' }), 'company/deepseek-v4-flash#high');
    assert.strictEqual(formatModelRef({ providerID: 'company', id: 'deepseek-v4-flash' }), 'company/deepseek-v4-flash');
    assert.strictEqual(formatModelRef(undefined), undefined);
  }));

  results.push(await test('ECC rules follow Claude Code paths scoping per session', async () => {
    const projectDir = createProject('rules');
    const fake = await start(projectDir, { hooks: false, rules: ['common', 'angular'] });
    const contextOf = async sessionID => (await trigger(fake.hooks, 'session.context', { sessionID, agent: 'build', system: [], messages: [], tools: {}, options: {} }))
      .system.map(part => part.text).join('\n');
    const before = await contextOf('ses_rules');
    assert.ok(before.includes('<rule id="common/coding-style">'));
    assert.ok(!before.includes('<rule id="angular/'));
    await trigger(fake.hooks, 'tool.execute.before', toolEvent('read', { path: 'src/app/user.component.ts' }, { sessionID: 'ses_rules' }));
    const after = await contextOf('ses_rules');
    assert.ok(after.includes('<rule id="angular/coding-style">'));
    assert.ok(!(await contextOf('ses_other')).includes('<rule id="angular/'), 'activation is per session');
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
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
