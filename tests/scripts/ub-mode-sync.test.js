const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const script = path.join(__dirname, '../../skills/ub-mode/scripts/sync-upstream.js');
const sync = require(script);
const initialCommit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const initialSkill = '---\nname: ub-mode\ndescription: Fixture principles\n---\n\n# ub-mode\n\nKeep behavior clear.\n';
const changedSkill = initialSkill + '\nFix root causes.\n';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function test(name, action) {
  try {
    await action();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}\n    Error: ${error.message}`);
    return false;
  }
}

async function withFixture(action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ub-sync-'));
  const snapshot = path.join(directory, 'references/upstream-skill.md');
  const manifest = path.join(directory, 'upstream.json');
  const wrapper = path.join(directory, 'SKILL.md');
  fs.mkdirSync(path.dirname(snapshot));
  fs.writeFileSync(snapshot, initialSkill);
  fs.writeFileSync(wrapper, 'Keep this ECC review adaptation.\n');
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, repository: 'https://github.com/unclebob/ub-mode', ref: 'master', commit: initialCommit, path: 'SKILL.md', sha256: digest(initialSkill) }, null, 2) + '\n');
  const contents = () => [snapshot, manifest, wrapper].map(file => fs.readFileSync(file, 'utf8'));
  try {
    await action({ directory, snapshot, manifest, wrapper, contents });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function provider(commit = nextCommit, source = changedSkill) {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    return new globalThis.Response(requests.length % 2 === 1 ? JSON.stringify({ sha: commit }) : source);
  };
  return { fetcher, requests };
}

async function main() {
  const results = [];
  results.push(await test('CLI defaults to an offline check and validates explicit update flags', () => {
    assert.deepStrictEqual(sync.parseArgs([]), { action: 'check', timeoutMs: 15000, json: false, help: false });
    assert.deepStrictEqual(sync.parseArgs(['--update', '--ref', 'feature/principles', '--timeout-ms', '5000', '--json']), { action: 'update', ref: 'feature/principles', timeoutMs: 5000, json: true, help: false });
    assert.strictEqual(sync.parseArgs(['--check']).action, 'check');
    assert.strictEqual(sync.parseArgs(['--help']).help, true);
    for (const args of [['--update', '--check'], ['--ref', 'master'], ['--update', '--ref'], ['--timeout-ms', '0'], ['--timeout-ms', '120001'], ['--unknown'], ['--update', '--ref', 'bad\nref']]) assert.throws(() => sync.parseArgs(args));
  }));

  results.push(await test('checking provenance and snapshot integrity stays offline and read-only', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    let requested = false;
    const report = await sync.run({ action: 'check' }, { skillDir: directory, fetcher: async () => { requested = true; throw new Error('Unexpected request'); } });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.commit, initialCommit);
    assert.strictEqual(report.updated, false);
    assert.strictEqual(requested, false);
    assert.deepStrictEqual(contents(), before);
  })));

  results.push(await test('Git add and checkout preserve upstream LF and CRLF bytes with automatic line-ending conversion enabled', () => {
    const attributes = fs.readFileSync(path.join(__dirname, '../../.gitattributes'));
    const relative = 'skills/ub-mode/references/upstream-skill.md';
    for (const source of [initialSkill, initialSkill.replace(/\n/g, '\r\n')]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ub-git-eol-'));
      const snapshot = path.join(directory, relative);
      const bytes = Buffer.from(source);
      const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false', ...args], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        fs.mkdirSync(path.dirname(snapshot), { recursive: true });
        fs.writeFileSync(path.join(directory, '.gitattributes'), attributes);
        fs.writeFileSync(snapshot, bytes);
        git('init', '-q');
        git('add', '--', '.gitattributes', relative);
        const staged = git('show', `:${relative}`);
        fs.writeFileSync(snapshot, 'Replace this file from the Git index.\n');
        git('checkout-index', '-f', '--', relative);
        const restored = fs.readFileSync(snapshot);
        assert.deepStrictEqual(staged, bytes);
        assert.deepStrictEqual(restored, bytes);
        assert.strictEqual(digest(restored), digest(bytes));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }));

  results.push(await test('updates resolve a ref before fetching an immutable revision and preserve the ECC wrapper', () => withFixture(async ({ directory, snapshot, manifest, wrapper }) => {
    const server = provider();
    const report = await sync.run({ action: 'update', ref: 'topic/next principles' }, { skillDir: directory, fetcher: server.fetcher });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.updated, true);
    assert.strictEqual(report.commit, nextCommit);
    assert.strictEqual(server.requests.length, 2);
    assert.strictEqual(server.requests[0].url, 'https://api.github.com/repos/unclebob/ub-mode/commits/topic%2Fnext%20principles');
    assert.strictEqual(server.requests[1].url, `https://raw.githubusercontent.com/unclebob/ub-mode/${nextCommit}/SKILL.md`);
    assert.ok(server.requests.every(request => request.options.redirect === 'error' && request.options.signal));
    assert.strictEqual(fs.readFileSync(snapshot, 'utf8'), changedSkill);
    const pinned = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.strictEqual(pinned.sha256, digest(changedSkill));
    assert.strictEqual(pinned.ref, 'topic/next principles');
    assert.strictEqual(fs.readFileSync(wrapper, 'utf8'), 'Keep this ECC review adaptation.\n');
  })));

  results.push(await test('default updates follow the pinned branch and unchanged updates do not rewrite files', () => withFixture(async ({ directory, snapshot, manifest, contents }) => {
    const times = [snapshot, manifest].map(file => fs.statSync(file, { bigint: true }).mtimeNs);
    const before = contents();
    const server = provider(initialCommit, initialSkill);
    const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: server.fetcher });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.updated, false);
    assert.ok(server.requests[0].url.endsWith('/master'));
    assert.deepStrictEqual(contents(), before);
    assert.deepStrictEqual([snapshot, manifest].map(file => fs.statSync(file, { bigint: true }).mtimeNs), times);
  })));

  results.push(await test('local snapshot edits and invalid provenance fail before network access', () => withFixture(async ({ directory, snapshot, manifest }) => {
    const original = fs.readFileSync(manifest, 'utf8');
    const variants = [
      '{',
      JSON.stringify({ ...JSON.parse(original), repository: 'https://private.invalid/secret' }),
      JSON.stringify({ ...JSON.parse(original), path: '../SKILL.md' }),
      JSON.stringify({ ...JSON.parse(original), commit: 'not-a-commit' }),
      JSON.stringify({ ...JSON.parse(original), sha256: 'not-a-hash' }),
    ];
    const fetcher = async () => { throw new Error('Network must not be used'); };
    for (const manifestText of variants) {
      fs.writeFileSync(manifest, manifestText);
      const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher });
      assert.strictEqual(report.ok, false);
      assert.ok(!JSON.stringify(report).includes('private.invalid'));
    }
    fs.writeFileSync(manifest, original);
    fs.writeFileSync(snapshot, initialSkill + 'local edit');
    const report = await sync.run({ action: 'check' }, { skillDir: directory, fetcher });
    assert.strictEqual(report.ok, false);
    assert.ok(report.error.includes('checksum'));
  })));

  results.push(await test('HTTP failures and malformed commit responses preserve both owned files', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    for (const response of [new globalThis.Response('private provider body', { status: 503 }), new globalThis.Response('invalid JSON secret'), new globalThis.Response(JSON.stringify({ sha: 'bad' }))]) {
      const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: async () => response });
      assert.strictEqual(report.ok, false);
      assert.ok(!JSON.stringify(report).includes('private provider body'));
      assert.ok(!JSON.stringify(report).includes('JSON secret'));
      assert.deepStrictEqual(contents(), before);
    }
  })));

  results.push(await test('invalid or oversized upstream documents are rejected without changing provenance', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    for (const source of ['not a skill', '---\nname: ub-mode\n---\n', initialSkill.replace('name: ub-mode', 'name: another-skill') + '\nname: ub-mode\n', initialSkill + '\u0000', initialSkill + '\u2014', '\ufeff' + initialSkill, Buffer.from([255]), initialSkill + 'x'.repeat(160 * 1024)]) {
      const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: provider(nextCommit, source).fetcher });
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(contents(), before);
    }
  })));

  results.push(await test('a linked references directory is rejected instead of updating another tree', () => withFixture(async ({ directory, manifest }) => {
    const references = path.join(directory, 'references');
    const preserved = path.join(directory, 'preserved-references');
    const before = fs.readFileSync(manifest, 'utf8');
    fs.renameSync(references, preserved);
    fs.symlinkSync(preserved, references, process.platform === 'win32' ? 'junction' : 'dir');
    const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: provider().fetcher });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(fs.readFileSync(path.join(preserved, 'upstream-skill.md'), 'utf8'), initialSkill);
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), before);
  })));

  results.push(await test('a stalled response body obeys the deadline and redirect responses are refused', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    const stalled = await sync.run({ action: 'update', timeoutMs: 25 }, { skillDir: directory, fetcher: async () => new globalThis.Response(new globalThis.ReadableStream()) });
    assert.strictEqual(stalled.ok, false);
    assert.ok(stalled.error.includes('timed out'));
    const redirected = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: async () => new globalThis.Response(null, { status: 302, headers: { location: 'https://private.invalid/location' } }) });
    assert.strictEqual(redirected.ok, false);
    assert.ok(redirected.error.includes('302'));
    assert.ok(!JSON.stringify(redirected).includes('private.invalid'));
    assert.deepStrictEqual(contents(), before);
  })));

  results.push(await test('an upstream update does not overwrite local edits made while the network request is pending', () => withFixture(async ({ directory, snapshot, manifest }) => {
    const originalManifest = fs.readFileSync(manifest, 'utf8');
    const server = provider();
    const fetcher = async (...args) => {
      const response = await server.fetcher(...args);
      if (server.requests.length === 2) fs.writeFileSync(snapshot, initialSkill + 'Owner edit while fetching.\n');
      return response;
    };
    const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher });
    assert.strictEqual(report.ok, false);
    assert.ok(report.error.includes('changed'));
    assert.strictEqual(fs.readFileSync(snapshot, 'utf8'), initialSkill + 'Owner edit while fetching.\n');
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), originalManifest);
  })));

  results.push(await test('one deadline bounds both requests and cancels a stalled response', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    let aborted = false;
    const fetcher = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('private connection error')); }, { once: true });
    });
    const started = Date.now();
    const report = await sync.run({ action: 'update', timeoutMs: 25 }, { skillDir: directory, fetcher });
    assert.strictEqual(report.ok, false);
    assert.ok(report.error.includes('timed out'));
    assert.ok(!JSON.stringify(report).includes('private connection error'));
    assert.strictEqual(aborted, true);
    assert.ok(Date.now() - started < 2000);
    assert.deepStrictEqual(contents(), before);
  })));

  results.push(await test('an interrupted pair replacement restores the previous snapshot and metadata', () => withFixture(async ({ directory, snapshot, manifest, contents }) => {
    const before = contents();
    let failed = false;
    const fileSystem = { ...fs, renameSync(from, to) {
      if (to === manifest && !failed) { failed = true; throw new Error('private filesystem failure'); }
      fs.renameSync(from, to);
    } };
    const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: provider().fetcher, fileSystem });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(failed, true);
    assert.strictEqual(fs.readFileSync(snapshot, 'utf8'), initialSkill);
    assert.deepStrictEqual(contents(), before);
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), ['SKILL.md', 'references', 'upstream.json']);
  })));

  results.push(await test('missing owned files and network exceptions return concise diagnostics', () => withFixture(async ({ directory, snapshot, contents }) => {
    const before = contents();
    const report = await sync.run({ action: 'update' }, { skillDir: directory, fetcher: async () => { throw new Error('https://private.invalid/private-value'); } });
    assert.strictEqual(report.ok, false);
    assert.ok(!JSON.stringify(report).includes('private.invalid'));
    assert.deepStrictEqual(contents(), before);
    fs.rmSync(snapshot);
    assert.strictEqual((await sync.run({ action: 'check' }, { skillDir: directory })).ok, false);
  })));

  results.push(await test('CLI help and invalid arguments return predictable exit codes', () => {
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('--update') && help.stdout.includes('--check'));
    const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(invalid.status, 2);
  }));

  const failed = results.filter(result => !result).length;
  console.log(`\nPassed: ${results.length - failed}, Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
