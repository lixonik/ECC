const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');
const doctorFile = path.join(repoRoot, 'opencode-v2', 'doctor.js');
const load = relative => import(pathToFileURL(path.join(repoRoot, 'opencode-v2', relative)).href);

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function treeContents(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? treeContents(absolute, relative)
      : [[relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]];
  });
}

function commandFixture(overrides = {}) {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const name = path.basename(command).toLowerCase().replace(/\.exe$/, '');
    const override = overrides[name];
    if (typeof override === 'function') return override(command, args, options);
    if (override) return override;
    const versions = { opencode: 'opencode 2.0.32\n', git: 'git version 2.47.1\n', bash: 'GNU bash, version 5.2.26\n', node: 'v22.12.0\n', pwsh: '7.4.6\n', powershell: '5.1.19041\n' };
    return { stdout: versions[name] ?? 'fixture command 1.0.0\n', stderr: '', exitCode: 0 };
  };
  return { calls, runCommand };
}

function check(report, id) {
  const value = report.checks.find(item => item.id === id);
  assert.ok(value, `missing check: ${id}`);
  return value;
}

async function main() {
  const doctor = await load('doctor.js');
  const installer = await load('install.js');
  const results = [];
  const withFixture = async fn => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-doctor-'));
    const project = path.join(directory, 'project with spaces');
    const configDir = path.join(directory, 'config with spaces');
    const configFile = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(project, { recursive: true });
    try {
      installer.install({ ...installer.parseArgs([]), configDir }, { root: repoRoot, log() {} });
      fs.writeFileSync(configFile, JSON.stringify({ shell: 'bash', providers: { company: { settings: { baseURL: 'https://example.invalid/v1', apiKey: 'config-secret-do-not-print' }, models: { 'model-id': {} } } } }));
      const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir, DOCTOR_TEST_API_KEY: 'env-secret-do-not-print' };
      const options = doctor.parseDoctorArgs(['--project', project, '--config-dir', configDir]);
      const commands = commandFixture();
      const run = (extraOptions = {}, context = {}) => doctor.runDoctor({ ...options, ...extraOptions }, { root: repoRoot, env, nodeVersion: '22.12.0', runCommand: commands.runCommand, ...context });
      await fn({ directory, project, configDir, configFile, env, options, commands, run });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };

  results.push(await test('argument defaults and explicit diagnostic options are parsed', () => {
    const defaults = doctor.parseDoctorArgs([]);
    assert.strictEqual(defaults.project, path.resolve(process.cwd()));
    assert.strictEqual(defaults.opencode, 'opencode');
    assert.strictEqual(defaults.json, false);
    assert.strictEqual(defaults.probe, false);
    assert.strictEqual(defaults.timeoutMs, 15000);
    const parsed = doctor.parseDoctorArgs(['--project', '.', '--config-dir', 'config dir', '--opencode', 'custom-opencode', '--json', '--timeout-ms', '5000']);
    assert.strictEqual(parsed.project, path.resolve('.'));
    assert.strictEqual(parsed.configDir, path.resolve('config dir'));
    assert.strictEqual(parsed.opencode, 'custom-opencode');
    assert.strictEqual(parsed.json, true);
    assert.strictEqual(parsed.timeoutMs, 5000);
    const probe = doctor.parseDoctorArgs(['--probe', '--base-url', 'https://example.invalid/v1', '--model', 'model-id', '--api-key-env', 'MODEL_KEY', '--thinking', 'on', '--reasoning-effort', 'high']);
    assert.strictEqual(probe.probe, true);
    assert.strictEqual(probe.baseURL, 'https://example.invalid/v1');
    assert.strictEqual(probe.model, 'model-id');
    assert.strictEqual(probe.apiKeyEnv, 'MODEL_KEY');
    assert.strictEqual(probe.thinking, 'on');
    assert.strictEqual(probe.reasoningEffort, 'high');
    assert.strictEqual(doctor.parseDoctorArgs(['--help']).help, true);
  }));

  results.push(await test('invalid arguments fail before diagnostics or network access', () => {
    for (const args of [
      ['--unknown'], ['--project'], ['--config-dir'], ['--opencode'], ['--probe'],
      ['--probe', '--base-url', 'https://example.invalid'], ['--model', 'model-id'],
      ['--base-url', 'https://example.invalid'], ['--api-key-env', 'MODEL_KEY'],
      ['--thinking', 'on'], ['--reasoning-effort', 'high'],
      ['--timeout-ms', '0'], ['--timeout-ms', '-1'], ['--timeout-ms', '1.5'],
      ['--timeout-ms', '120001'], ['--timeout-ms', 'nope'],
      ['--probe', '--base-url', 'https://example.invalid', '--model', 'm', '--thinking', 'maybe'],
      ['--probe', '--base-url', 'https://example.invalid', '--model', 'm', '--reasoning-effort', 'huge'],
      ['--probe', '--base-url', 'https://example.invalid', '--model', 'm', '--api-key-env', 'BAD-NAME'],
    ]) assert.throws(() => doctor.parseDoctorArgs(args), undefined, args.join(' '));
  }));

  results.push(await test('healthy offline checks are read-only and do not contact a provider', () => withFixture(async ({ directory, commands, run }) => {
    const before = treeContents(directory);
    const originalFetch = global.fetch;
    let requested = false;
    global.fetch = async () => { requested = true; throw new Error('Unexpected network call'); };
    try {
      const report = await run();
      assert.strictEqual(report.ok, true);
      for (const id of ['node', 'opencode', 'git', 'shell', 'hooks', 'skills', 'config', 'installation']) assert.strictEqual(check(report, id).status, 'pass', id);
      assert.strictEqual(report.summary.failed, 0);
      assert.strictEqual(requested, false);
      assert.ok(commands.calls.some(call => path.basename(call.command).replace(/\.exe$/, '') === 'opencode' && call.args.includes('--version')));
      assert.ok(commands.calls.every(call => call.options.timeoutMs > 0 && call.options.timeoutMs <= 15000));
      assert.deepStrictEqual(treeContents(directory), before);
    } finally {
      global.fetch = originalFetch;
    }
  })));

  results.push(await test('unsupported Node and OpenCode versions fail the relevant checks', () => withFixture(async ({ run }) => {
    const oldNode = await run({}, { nodeVersion: '18.20.8' });
    assert.strictEqual(oldNode.ok, false);
    assert.strictEqual(check(oldNode, 'node').status, 'fail');
    for (const version of ['1.18.34', '2.0.31']) {
      const commands = commandFixture({ opencode: { stdout: version, stderr: '', exitCode: 0 } });
      const report = await run({}, { runCommand: commands.runCommand });
      assert.strictEqual(report.ok, false, version);
      assert.strictEqual(check(report, 'opencode').status, 'fail', version);
    }
    const newer = commandFixture({ opencode: { stdout: '2.1.0', stderr: '', exitCode: 0 } });
    assert.notStrictEqual(check(await run({}, { runCommand: newer.runCommand }), 'opencode').status, 'fail');
  })));

  results.push(await test('missing and malformed command responses fail without echoing raw output', () => withFixture(async ({ run }) => {
    const commands = commandFixture({
      opencode: { stdout: 'raw-secret-from-command', stderr: 'raw-secret-from-command', exitCode: 1, error: 'raw-secret-from-command' },
      git: { stdout: '', stderr: '', exitCode: 1, error: 'unavailable' },
      bash: { stdout: '', stderr: '', exitCode: 1, error: 'unavailable' },
    });
    const report = await run({}, { runCommand: commands.runCommand });
    for (const id of ['opencode', 'git', 'shell']) assert.strictEqual(check(report, id).status, 'fail');
    assert.ok(check(report, 'opencode').message.includes('--opencode'));
    assert.strictEqual(report.ok, false);
    assert.ok(!JSON.stringify(report).includes('raw-secret-from-command'));
    const malformed = commandFixture({ opencode: { stdout: 'version unknown', stderr: '', exitCode: 0 } });
    assert.strictEqual(check(await run({}, { runCommand: malformed.runCommand }), 'opencode').status, 'fail');
  })));

  results.push(await test('missing local configuration and installation are warnings', () => withFixture(async ({ configDir, configFile, run }) => {
    fs.unlinkSync(configFile);
    fs.unlinkSync(path.join(configDir, 'ecc-opencode-v2.install.json'));
    const report = await run();
    assert.strictEqual(report.ok, true);
    assert.strictEqual(check(report, 'config').status, 'warn');
    assert.strictEqual(check(report, 'installation').status, 'warn');
    assert.ok(report.summary.warnings >= 2);
  })));

  results.push(await test('invalid JSONC and installation metadata fail safely', () => withFixture(async ({ configDir, configFile, run }) => {
    fs.writeFileSync(configFile, '{ "providers": invalid-config-secret }');
    let report = await run();
    assert.strictEqual(check(report, 'config').status, 'fail');
    assert.ok(!JSON.stringify(report).includes('invalid-config-secret'));
    fs.writeFileSync(configFile, '{ "shell": "bash", }');
    fs.writeFileSync(path.join(configDir, 'ecc-opencode-v2.install.json'), '{ invalid-manifest-secret');
    report = await run();
    assert.strictEqual(check(report, 'installation').status, 'fail');
    assert.ok(!JSON.stringify(report).includes('invalid-manifest-secret'));
  })));

  results.push(await test('config arrays and installation references to another clone are rejected', () => withFixture(async ({ directory, configDir, configFile, run }) => {
    fs.writeFileSync(configFile, '[{"shell":"bash"}]');
    assert.strictEqual(check(await run(), 'config').status, 'fail');
    fs.writeFileSync(configFile, '{ "shell": "bash" }');
    const manifestFile = path.join(configDir, 'ecc-opencode-v2.install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, eccRoot: path.join(directory, 'another clone') }));
    assert.strictEqual(check(await run(), 'installation').status, 'fail');
  })));

  results.push(await test('missing owned files fail while user-edited owned files only warn', () => withFixture(async ({ configDir, run }) => {
    const file = path.join(configDir, 'agents', 'planner.md');
    fs.appendFileSync(file, '\nPersonal instruction\n');
    let report = await run();
    assert.strictEqual(report.ok, true);
    assert.strictEqual(check(report, 'installation').status, 'warn');
    fs.unlinkSync(file);
    report = await run();
    assert.strictEqual(report.ok, false);
    assert.strictEqual(check(report, 'installation').status, 'fail');
  })));

  results.push(await test('manifest paths cannot escape the installation directory', () => withFixture(async ({ directory, configDir, run }) => {
    const outside = path.join(directory, 'outside-secret.txt');
    fs.writeFileSync(outside, 'outside-secret-do-not-print');
    const manifestFile = path.join(configDir, 'ecc-opencode-v2.install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, files: { '../outside-secret.txt': crypto.createHash('sha256').update('outside-secret-do-not-print').digest('hex') } }));
    const report = await run();
    assert.strictEqual(check(report, 'installation').status, 'fail');
    assert.ok(!JSON.stringify(report).includes('outside-secret-do-not-print'));
  })));

  results.push(await test('reports do not include configured provider credentials or private endpoint URLs', () => withFixture(async ({ run }) => {
    const report = await run();
    const encoded = JSON.stringify(report);
    assert.ok(!encoded.includes('config-secret-do-not-print'));
    assert.ok(!encoded.includes('env-secret-do-not-print'));
    assert.ok(!encoded.includes('https://example.invalid/v1'));
    assert.strictEqual(report.summary.passed + report.summary.warnings + report.summary.failed, report.checks.length);
  })));

  results.push(await test('command deadlines are propagated and command exceptions become failed checks', () => withFixture(async ({ run, commands }) => {
    await run({ timeoutMs: 750 });
    assert.ok(commands.calls.every(call => call.options.timeoutMs === 750));
    const throwing = async () => { throw new Error('private-command-exception-secret'); };
    const report = await run({}, { runCommand: throwing });
    assert.strictEqual(report.ok, false);
    for (const id of ['opencode', 'git', 'shell']) assert.strictEqual(check(report, id).status, 'fail');
    assert.ok(!JSON.stringify(report).includes('private-command-exception-secret'));
  })));

  results.push(await test('an explicit probe uses the named credential and reports whether reasoning was observed', () => withFixture(async ({ run }) => {
    const originalFetch = global.fetch;
    try {
      for (const observed of [true, false]) {
        const requests = [];
        global.fetch = async (_url, request) => {
          const body = JSON.parse(request.body);
          requests.push(body);
          assert.strictEqual(request.headers.authorization, 'Bearer env-secret-do-not-print');
          assert.deepStrictEqual(body.thinking, { type: 'enabled' });
          assert.strictEqual(body.reasoning_effort, 'high');
          const token = /ECC_DOCTOR_TOKEN:([a-zA-Z0-9-]+)/.exec(body.messages[0].content)[1];
          const delta = requests.length === 1
            ? { tool_calls: [{ index: 0, id: 'doctor-call', type: 'function', function: { name: 'ecc_doctor_ping', arguments: JSON.stringify({ token }) } }] }
            : { content: `ECC_DOCTOR_OK:${JSON.parse(body.messages.at(-1).content).token}` };
          if (observed) delta.reasoning_content = 'Diagnostic reasoning';
          const completion = { choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] };
          return new Response(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        };
        const report = await run({ probe: true, baseURL: 'https://example.invalid/v1', model: 'model-id', apiKeyEnv: 'DOCTOR_TEST_API_KEY', thinking: 'on', reasoningEffort: 'high' });
        assert.strictEqual(report.ok, true, JSON.stringify(report));
        assert.strictEqual(requests.length, 2);
        assert.strictEqual(check(report, 'model.round-trip').status, 'pass');
        assert.strictEqual(check(report, 'model.reasoning').status, observed ? 'pass' : 'warn');
        assert.ok(!JSON.stringify(report).includes('env-secret-do-not-print'));
        assert.ok(!JSON.stringify(report).includes('example.invalid'));
      }
    } finally {
      global.fetch = originalFetch;
    }
  })));

  results.push(await test('an explicitly named missing API credential fails before provider access', () => withFixture(async ({ run, env }) => {
    const probeEnv = { ...env };
    delete probeEnv.DOCTOR_MISSING_API_KEY;
    const originalFetch = global.fetch;
    let requested = false;
    global.fetch = async () => { requested = true; throw new Error('Unexpected network call'); };
    try {
      const report = await run({ probe: true, baseURL: 'https://example.invalid/v1', model: 'model-id', apiKeyEnv: 'DOCTOR_MISSING_API_KEY' }, { env: probeEnv });
      assert.strictEqual(report.ok, false);
      assert.strictEqual(requested, false);
      assert.ok(report.checks.some(item => item.status === 'fail'));
    } finally {
      global.fetch = originalFetch;
    }
  })));

  results.push(await test('CLI help and usage errors have predictable exit codes', () => {
    const help = spawnSync(process.execPath, [doctorFile, '--help'], { cwd: repoRoot, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('--probe') && help.stdout.includes('--json'));
    const invalid = spawnSync(process.execPath, [doctorFile, '--probe'], { cwd: repoRoot, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.strictEqual(invalid.status, 2, invalid.stderr);
    assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes('env-secret-do-not-print'));
  }));

  results.push(await test('the configured hook Node executable is checked independently of the doctor runtime', () => withFixture(async ({ configDir, env, run }) => {
    const manifestFile = path.join(configDir, 'ecc-opencode-v2.install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, installOptions: { ...manifest.installOptions, node: 'missing-hook-node' } }));
    const commands = commandFixture({ 'missing-hook-node': { exitCode: 1, stdout: '', stderr: '' } });
    const report = await run({}, { runCommand: commands.runCommand });
    assert.strictEqual(check(report, 'node').status, 'pass');
    assert.strictEqual(check(report, 'hook-node').status, 'fail');
    assert.ok(commands.calls.some(call => call.command === 'missing-hook-node'));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const overridden = commandFixture({ 'custom-hook-node': { exitCode: 0, stdout: 'v24.0.0', stderr: '' } });
    const restored = await run({}, { env: { ...env, ECC_NODE: 'custom-hook-node' }, runCommand: overridden.runCommand });
    assert.strictEqual(check(restored, 'hook-node').status, 'pass');
    assert.ok(overridden.calls.some(call => call.command === 'custom-hook-node'));
  })));

  results.push(await test('CLI JSON mode emits one redacted report when a local executable is unavailable', () => withFixture(async ({ directory, project, configDir, configFile, env }) => {
    const fake = path.join(directory, 'opencode version.cjs');
    fs.writeFileSync(fake, "process.stdout.write('2.0.32\\n');\n");
    fs.writeFileSync(configFile, JSON.stringify({ shell: path.join(directory, 'missing-shell'), providers: { company: { settings: { apiKey: 'config-secret-do-not-print', baseURL: 'https://example.invalid/v1' } } } }));
    const result = spawnSync(process.execPath, [doctorFile, '--project', project, '--config-dir', configDir, '--opencode', fake, '--timeout-ms', '1000', '--json'], {
      cwd: repoRoot, env, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.strictEqual(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(check(report, 'opencode').status, 'pass');
    assert.strictEqual(check(report, 'shell').status, 'fail');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('config-secret-do-not-print'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('env-secret-do-not-print'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('https://example.invalid/v1'));
  })));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
