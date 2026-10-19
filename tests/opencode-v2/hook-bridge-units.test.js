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

async function main() {
  const protocol = await load('lib/hook-protocol.js');
  const manifestLib = await load('lib/hooks-manifest.js');
  const translate = await load('lib/tool-translate.js');
  const { parsePatchOperations } = await load('lib/patch.js');
  const config = await load('lib/opencode-config.js');
  const { loadEccSkills } = await load('lib/skills.js');
  const runner = await load('lib/hook-runner.js');
  const logging = await load('lib/logger.js');
  const transcriptLib = await load('lib/transcript.js');
  const rulesLib = await load('lib/rules.js');
  const results = [];
  const projectDir = path.resolve(os.tmpdir(), 'ecc-project');
  const env = { projectDir, shellToolName: () => 'Bash', mcpName: id => (id === 'context7_query-docs' ? 'mcp__context7__query-docs' : null) };

  results.push(await test('every hooks.json command tokenizes into node -e argv', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8')).hooks;
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          const argv = protocol.tokenizeCommand(hook.command);
          assert.strictEqual(argv[0], 'node');
          assert.strictEqual(argv[1], '-e');
          assert.ok(argv[2].includes('CLAUDE_PLUGIN_ROOT'));
        }
      }
    }
  }));

  results.push(await test('tokenizer follows shell quoting rules', () => {
    assert.deepStrictEqual(protocol.tokenizeCommand(`node -e "a 'b' \\"c\\"" x 'y z' w\\ v`), ['node', '-e', `a 'b' "c"`, 'x', 'y z', 'w v']);
    assert.throws(() => protocol.tokenizeCommand('node "open'), /Unterminated/);
  }));

  results.push(await test('hook manifest exposes ECC hook ids and profiles for prefiltering', () => {
    const manifest = manifestLib.loadHookManifest(repoRoot);
    const ids = Object.values(manifest).flat().flatMap(entry => entry.commands.map(command => command.hookId)).filter(Boolean);
    assert.ok(ids.includes('pre:config-protection'));
    assert.ok(ids.includes('stop:session-end'));
    const config = manifest.PreToolUse.find(entry => entry.id === 'pre:config-protection').commands[0];
    assert.strictEqual(config.profiles, 'standard,strict');
    assert.strictEqual(config.timeoutMs, 5000);
    const selected = manifestLib.selectHookCommands(manifest, 'PreToolUse', 'Edit', hookId => hookId !== 'pre:config-protection');
    assert.ok(!selected.some(command => command.hookId === 'pre:config-protection'));
    assert.ok(selected.some(command => command.hookId === 'pre:edit-write:gateguard-fact-force'));
  }));

  results.push(await test('matchers follow Claude Code semantics', () => {
    const editWrite = protocol.createMatcher('Edit|Write');
    assert.ok(editWrite('Edit') && editWrite('Write'));
    assert.ok(!editWrite('MultiEdit'));
    assert.ok(protocol.createMatcher('^mcp__')('mcp__context7__query-docs'));
    assert.ok(!protocol.createMatcher('^mcp__')('Bash'));
    assert.ok(protocol.createMatcher('.*')(''));
    assert.ok(protocol.createMatcher('*')('anything'));
  }));

  results.push(await test('hook results map to block, permission, context and diagnostics', () => {
    const blocked = protocol.interpretHookResult('PreToolUse', { exitCode: 2, stdout: '', stderr: 'no way\n' });
    assert.strictEqual(blocked.block, true);
    assert.strictEqual(blocked.reason, 'no way');
    const denied = protocol.interpretHookResult('PreToolUse', { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'unsafe' } }), stderr: '' });
    assert.strictEqual(denied.permission, 'deny');
    assert.strictEqual(denied.permissionReason, 'unsafe');
    const context = protocol.interpretHookResult('PostToolUse', { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'note' } }), stderr: 'warn' });
    assert.deepStrictEqual(context.context, ['note']);
    assert.deepStrictEqual(context.notices, ['warn']);
    assert.deepStrictEqual(protocol.interpretHookResult('SessionStart', { exitCode: 0, stdout: 'plain context', stderr: '' }).context, ['plain context']);
    assert.deepStrictEqual(protocol.interpretHookResult('PreToolUse', { exitCode: 0, stdout: 'plain text', stderr: '' }).context, []);
    assert.strictEqual(protocol.interpretHookResult('Stop', { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'keep going' }), stderr: '' }).reason, 'keep going');
    assert.deepStrictEqual(protocol.interpretHookResult('PreToolUse', { exitCode: 1, stdout: '', stderr: 'boom' }).diagnostics, ['exited with 1: boom']);
    assert.strictEqual(protocol.interpretHookResult('PreToolUse', { exitCode: null, timedOut: true }).block, false);
  }));

  results.push(await test('merged outcomes keep the strongest permission and every reason', () => {
    const merged = protocol.mergeOutcomes([
      { ...protocol.emptyOutcome(), permission: 'allow' },
      { ...protocol.emptyOutcome(), permission: 'deny', permissionReason: 'second' },
      { ...protocol.emptyOutcome(), block: true, reason: 'third', context: ['ctx'] },
    ]);
    assert.strictEqual(merged.permission, 'deny');
    assert.strictEqual(merged.permissionReason, 'second');
    assert.strictEqual(merged.block, true);
    assert.deepStrictEqual(merged.context, ['ctx']);
  }));

  results.push(await test('OpenCode tool calls translate to Claude Code tool payloads', () => {
    assert.deepStrictEqual(translate.toClaudeCalls('shell', { command: 'git status', workdir: 'sub', background: true }, env), [
      { name: 'Bash', input: { command: 'git status', run_in_background: true }, cwd: path.join(projectDir, 'sub') },
    ]);
    assert.deepStrictEqual(translate.toClaudeCalls('edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' }, env), [
      { name: 'Edit', input: { file_path: path.join(projectDir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' } },
    ]);
    assert.deepStrictEqual(translate.toClaudeCalls('subagent', { agent: 'planner', description: 'd', prompt: 'p' }, env), [
      { name: 'Task', input: { subagent_type: 'planner', description: 'd', prompt: 'p' } },
    ]);
    assert.deepStrictEqual(translate.toClaudeCalls('skill', { id: 'tdd-workflow' }, env)[0].input.skill, 'tdd-workflow');
    assert.deepStrictEqual(translate.toClaudeCalls('execute', { code: '' }, env), []);
    assert.strictEqual(translate.toClaudeCalls('context7_query-docs', { q: 1 }, env)[0].name, 'mcp__context7__query-docs');
    assert.strictEqual(translate.toClaudeCalls('custom_tool', {}, env)[0].name, 'custom_tool');
  }));

  results.push(await test('patch text becomes MultiEdit and Write payloads', () => {
    const patchText = ['*** Begin Patch', '*** Add File: new.txt', '+hello', '*** Update File: src/app.js', '*** Move to: src/main.js', '@@ fn', ' keep', '-old', '+new', '@@', '-x', '*** Delete File: gone.txt', '*** End Patch'].join('\n');
    assert.deepStrictEqual(parsePatchOperations(patchText).map(op => op.type), ['add', 'update', 'delete']);
    const calls = translate.toClaudeCalls('patch', { patchText }, env);
    assert.deepStrictEqual(calls.map(call => call.name), ['Write', 'MultiEdit']);
    assert.strictEqual(calls[0].input.content, 'hello\n');
    assert.deepStrictEqual(calls[1].input.edits, [
      { old_string: 'keep\nold', new_string: 'keep\nnew', replace_all: false },
      { old_string: 'x', new_string: '', replace_all: false },
    ]);
    assert.strictEqual(calls[1].input.new_file_path, path.join(projectDir, 'src', 'main.js'));
  }));

  results.push(await test('updated hook input maps back onto OpenCode arguments', () => {
    const updated = translate.fromClaudeInput('edit', { path: 'src/a.ts', oldString: 'a', newString: 'b' }, { file_path: path.join(projectDir, 'src', 'a.ts'), new_string: 'c' }, env);
    assert.deepStrictEqual(updated, { path: 'src/a.ts', oldString: 'a', newString: 'c' });
    assert.strictEqual(translate.fromClaudeInput('patch', { patchText: '' }, { edits: [] }, env), null);
    assert.strictEqual(translate.fromClaudeInput('shell', { command: 'ls' }, { command: 'ls -la' }, env).command, 'ls -la');
  }));

  results.push(await test('tool results map to tool_response and tool_output', () => {
    const shell = translate.toClaudeResponse('shell', { status: 'completed', result: { output: { output: 'hi\n', exit: 0, truncated: false }, content: [{ type: 'text', text: 'hi' }] } });
    assert.strictEqual(shell.tool_response.stdout, 'hi\n');
    assert.strictEqual(shell.tool_response.exit_code, 0);
    assert.strictEqual(shell.tool_output.output, 'hi\n');
    const failure = translate.toClaudeResponse('edit', { status: 'error', error: { message: 'nope' } });
    assert.strictEqual(failure.error, 'nope');
  }));

  results.push(await test('JSONC config shell selects the hook tool name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-config-'));
    try {
      fs.mkdirSync(path.join(dir, 'global', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'global', 'opencode', 'opencode.jsonc'), '{\n  // shell for tools\n  "shell": "pwsh", /* trailing */\n}\n');
      const projectEnv = { XDG_CONFIG_HOME: path.join(dir, 'global') };
      assert.strictEqual(config.configuredShell(path.join(dir, 'project'), projectEnv), 'pwsh');
      fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'project', 'opencode.json'), '{"shell":"bash"}');
      assert.strictEqual(config.configuredShell(path.join(dir, 'project'), projectEnv), 'bash');
      assert.strictEqual(config.shellToolNameFor('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'PowerShell');
      assert.strictEqual(config.shellToolNameFor('/usr/bin/bash'), 'Bash');
      assert.strictEqual(config.stripJsonc('{"a":"// not a comment",}'), '{"a":"// not a comment"}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await test('hook timeout kills the whole process tree and never hangs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-timeout-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    try {
      const started = Date.now();
      const result = await runner.runHookProcess({ argv: ['node', '-e', script], input: {}, env: process.env, cwd: dir, timeoutMs: 1500, nodePath: process.execPath });
      assert.strictEqual(result.timedOut, true);
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(grandchildPid);
      assert.strictEqual(alive, false, 'grandchild must be killed with the hook');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await test('hook runner passes stdin JSON and returns exit code and output', async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.word);process.stderr.write('err');process.exit(2)})";
    const result = await runner.runHookProcess({ argv: ['node', '-e', script], input: { word: 'ping' }, env: process.env, cwd: os.tmpdir(), timeoutMs: 10000, nodePath: process.execPath });
    assert.deepStrictEqual({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut }, { exitCode: 2, stdout: 'ping', stderr: 'err', timedOut: false });
  }));

  results.push(await test('bridge log rotates once it passes the size cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-log-'));
    try {
      const file = path.join(dir, 'bridge.log');
      fs.writeFileSync(file, 'x'.repeat(2048));
      const logger = logging.createLogger(file, { maxBytes: 1024 });
      logger.info('fresh line');
      assert.ok(fs.readFileSync(`${file}.1`, 'utf8').startsWith('xxxx'));
      assert.ok(/INFO fresh line\n$/.test(fs.readFileSync(file, 'utf8')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await test('old transcript mirrors are pruned and recent ones kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-mirror-'));
    try {
      const old = path.join(dir, 'ses_old.jsonl');
      const recent = path.join(dir, 'ses_recent.jsonl');
      const other = path.join(dir, 'notes.txt');
      for (const file of [old, recent, other]) fs.writeFileSync(file, '{}\n');
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old, fortyDaysAgo, fortyDaysAgo);
      fs.utimesSync(other, fortyDaysAgo, fortyDaysAgo);
      assert.strictEqual(transcriptLib.pruneTranscripts(dir, 30), 1);
      assert.ok(!fs.existsSync(old) && fs.existsSync(recent) && fs.existsSync(other));
      assert.strictEqual(transcriptLib.pruneTranscripts(path.join(dir, 'missing'), 30), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await test('rule globs follow gitignore-style ** semantics', () => {
    const cases = [
      ['**/*.component.ts', 'src/app/a.component.ts', true],
      ['**/*.component.ts', 'a.component.ts', true],
      ['**/*.component.ts', 'a.component.tsx', false],
      ['**/ohosTest/**', 'entry/src/ohosTest/x/y.ets', true],
      ['**/server/**/*.ts', 'server/api/x.ts', true],
      ['**/server/**/*.ts', 'serverx/x.ts', false],
      ['**/appsettings*.json', 'web/appsettings.Development.json', true],
      ['**/use-*.ts', 'hooks/user.ts', false],
      ['src/*.ts', 'src/a.ts', true],
      ['src/*.ts', 'x/src/a.ts', false],
      ['**/*.{ts,js}', 'a/b.js', true],
    ];
    for (const [glob, file, expected] of cases) assert.strictEqual(rulesLib.globToRegExp(glob).test(file), expected, `${glob} vs ${file}`);
  }));

  results.push(await test('every ECC rule set loads with parseable paths', () => {
    const sets = rulesLib.availableRuleSets(repoRoot);
    assert.ok(sets.includes('common') && sets.includes('angular'));
    const { rules, missing } = rulesLib.loadRuleSets(repoRoot, sets);
    assert.deepStrictEqual(missing, []);
    assert.ok(rules.filter(rule => rule.id.startsWith('common/')).every(rule => rule.paths.length === 0));
    assert.ok(rules.filter(rule => !rule.id.startsWith('common/')).every(rule => rule.paths.length > 0 && rule.content.length > 0));
  }));

  results.push(await test('every ECC skill loads as an OpenCode skill keyed by its directory', () => {
    const { skills, skipped } = loadEccSkills(repoRoot);
    assert.deepStrictEqual(skipped, []);
    const dirs = fs.readdirSync(path.join(repoRoot, 'skills')).filter(d => fs.existsSync(path.join(repoRoot, 'skills', d, 'SKILL.md')));
    assert.strictEqual(skills.length, dirs.length);
    const tdd = skills.find(skill => skill.id === 'tdd-workflow');
    assert.ok(tdd && tdd.description && path.isAbsolute(tdd.path) && !tdd.content.startsWith('---'));
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
