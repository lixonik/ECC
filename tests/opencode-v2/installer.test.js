const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.join(__dirname, '..', '..');

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
  const installer = await import(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'install.js')).href);
  const results = [];
  const quiet = { log: () => {} };
  const withTarget = async fn => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-install-'));
    try {
      await fn(configDir, extra => ({ ...installer.parseArgs([]), configDir, ...extra }));
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  };
  const agentCount = fs.readdirSync(path.join(repoRoot, 'agents')).filter(f => f.endsWith('.md')).length;
  const commandCount = fs.readdirSync(path.join(repoRoot, 'commands')).filter(f => f.endsWith('.md')).length;

  results.push(await test('argument parsing validates values', () => {
    const options = installer.parseArgs(['install', '--scope', 'project', '--profile', 'strict', '--disable-hook', 'a,b', '--model-map', 'opus=x/big,haiku=x/small', '--skills', 'tdd-workflow']);
    assert.strictEqual(options.scope, 'project');
    assert.deepStrictEqual(options.disabledHooks, ['a', 'b']);
    assert.deepStrictEqual(options.modelMap, { opus: 'x/big', haiku: 'x/small' });
    assert.deepStrictEqual(options.skills, ['tdd-workflow']);
    assert.throws(() => installer.parseArgs(['--profile', 'loud']), /--profile/);
    assert.throws(() => installer.parseArgs(['--model-map', 'opus=big']), /model-map/);
    assert.throws(() => installer.parseArgs(['--bogus']), /Unknown option/);
  }));

  results.push(await test('install writes agents, commands and the plugin entry', () => withTarget(async (configDir, options) => {
    const report = installer.install(options({ profile: 'minimal' }), quiet);
    assert.strictEqual(report.created, agentCount + commandCount + 2);
    assert.strictEqual(fs.readdirSync(path.join(configDir, 'agents')).length, agentCount);
    assert.strictEqual(fs.readdirSync(path.join(configDir, 'commands')).length, commandCount);
    const entry = fs.readFileSync(path.join(configDir, 'plugins', 'ecc', 'index.js'), 'utf8');
    assert.ok(entry.includes(pathToFileURL(path.join(repoRoot, 'opencode-v2', 'plugin', 'ecc.js')).href));
    assert.ok(entry.includes('"profile": "minimal"'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'ecc', 'package.json'), 'utf8')).type, 'module');
  })));

  results.push(await test('reinstall is idempotent', () => withTarget(async (configDir, options) => {
    installer.install(options(), quiet);
    const again = installer.install(options(), quiet);
    assert.strictEqual(again.created + again.updated + again.removed, 0);
    assert.strictEqual(again.unchanged, agentCount + commandCount + 2);
  })));

  results.push(await test('files changed by the user or not owned by ECC are never overwritten', () => withTarget(async (configDir, options) => {
    fs.mkdirSync(path.join(configDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'commands', 'plan.md'), 'my own plan\n');
    installer.install(options(), quiet);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'commands', 'plan.md'), 'utf8'), 'my own plan\n');
    fs.writeFileSync(path.join(configDir, 'agents', 'planner.md'), 'customized\n');
    const report = installer.install(options({ profile: 'strict' }), quiet);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'agents', 'planner.md'), 'utf8'), 'customized\n');
    assert.ok(report.skipped.some(line => line.includes('planner.md')));
    assert.ok(fs.readFileSync(path.join(configDir, 'plugins', 'ecc', 'index.js'), 'utf8').includes('"profile": "strict"'));
  })));

  results.push(await test('uninstall removes only unmodified ECC files', () => withTarget(async (configDir, options) => {
    fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'agents', 'mine.md'), 'mine\n');
    installer.install(options(), quiet);
    fs.writeFileSync(path.join(configDir, 'agents', 'architect.md'), 'edited\n');
    const report = installer.uninstall(options(), quiet);
    assert.strictEqual(report.removed, agentCount + commandCount + 1);
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'agents', 'mine.md'), 'utf8'), 'mine\n');
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'agents', 'architect.md'), 'utf8'), 'edited\n');
    assert.ok(fs.existsSync(path.join(configDir, 'ecc-opencode-v2.install.json')), 'manifest stays while modified files remain');
    installer.uninstall(options({ force: true }), quiet);
    assert.ok(!fs.existsSync(path.join(configDir, 'agents', 'architect.md')));
    assert.ok(!fs.existsSync(path.join(configDir, 'ecc-opencode-v2.install.json')));
    assert.ok(!fs.existsSync(path.join(configDir, 'plugins', 'ecc')));
  })));

  results.push(await test('dry run writes nothing', () => withTarget(async (configDir, options) => {
    const report = installer.install(options({ dryRun: true }), quiet);
    assert.strictEqual(report.created, agentCount + commandCount + 2);
    assert.deepStrictEqual(fs.readdirSync(configDir), []);
  })));

  results.push(await test('plugin options carry hooks, shell and skills selection', () => {
    const options = installer.pluginOptionsFrom(installer.parseArgs(['--hooks', 'off', '--shell', 'PowerShell', '--skills', 'a,b', '--no-context']));
    assert.strictEqual(options.hooks, false);
    assert.strictEqual(options.shell, 'PowerShell');
    assert.deepStrictEqual(options.skills, ['a', 'b']);
    assert.strictEqual(options.context, false);
    assert.strictEqual(installer.pluginOptionsFrom(installer.parseArgs(['--shell', 'auto'])).shell, undefined);
  }));

  results.push(await test('project scope targets <project>/.opencode', () => {
    const target = installer.resolveTargetDir({ scope: 'project', project: path.join(os.tmpdir(), 'demo') });
    assert.strictEqual(target, path.join(os.tmpdir(), 'demo', '.opencode'));
    assert.strictEqual(installer.resolveTargetDir({ scope: 'global' }, { OPENCODE_CONFIG_DIR: path.join(os.tmpdir(), 'oc') }), path.join(os.tmpdir(), 'oc'));
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
