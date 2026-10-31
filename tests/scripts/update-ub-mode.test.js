const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadContextRegistry, loadSkillTriggers } = require('../../scripts/lib/context-pack-registry');
const { digestObject, stableStringify } = require('../../scripts/lib/context-profile-support');
const upstream = require('../../skills/ub-mode/scripts/sync-upstream');
const maintenance = require('../../scripts/update-ub-mode');

const script = path.join(__dirname, '../../scripts/update-ub-mode.js');
const initialCommit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const initialSkill = '---\nname: ub-mode\ndescription: Upstream principles\n---\n\n# ub-mode\n\nKeep behavior clear.\n';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ub-maintenance-'));
  const skillDir = path.join(directory, 'skills/ub-mode');
  const triggerFile = path.join(directory, 'manifests/context-packs/skill-triggers@1.json');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.mkdirSync(path.dirname(triggerFile), { recursive: true });
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: fixture\n');
  fs.writeFileSync(path.join(directory, 'package.json'), json({ name: 'ecc-universal' }));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: ub-mode\ndescription: ECC review adaptation\n---\n\n# Review adaptation\n');
  fs.writeFileSync(path.join(skillDir, 'references/upstream-skill.md'), initialSkill);
  fs.writeFileSync(path.join(skillDir, 'upstream.json'), json({ schemaVersion: 1, repository: 'https://github.com/unclebob/ub-mode', ref: 'master', commit: initialCommit, path: 'SKILL.md', sha256: digest(initialSkill) }));
  fs.writeFileSync(path.join(directory, 'manifests/install-modules.json'), json({ modules: [{ id: 'workflow-quality', paths: ['skills/ub-mode'], targets: ['codex'] }] }));
  fs.writeFileSync(path.join(directory, 'manifests/context-packs/skill-registry@1.json'), json({ schemaVersion: 1, id: 'skill-registry@1', inventory: { source: 'manifests/install-modules.json', skillsRoot: 'skills' }, overrides: [] }));
  const registry = loadContextRegistry({ repoRoot: directory });
  const triggers = { 'skill:ub-mode': ['  Review correctness  ', 'check CRAP', 'check CRAP'] };
  fs.writeFileSync(triggerFile, json({ schemaVersion: 1, id: 'skill-triggers@1', generatedAt: '2026-01-01T00:00:00.000Z', model: { id: 'hand-seeded', source: 'manual-curation' }, coverage: { skills: 1, withTriggers: 1 }, registryDigest: registry.registryDigest, triggers, triggersDigest: digestObject({ 'skill:ub-mode': ['review correctness', 'check crap'] }) }));
  const files = [triggerFile, path.join(skillDir, 'SKILL.md'), path.join(skillDir, 'upstream.json'), path.join(skillDir, 'references/upstream-skill.md')];
  const contents = () => files.map(file => fs.readFileSync(file, 'utf8'));
  try { await action({ directory, skillDir, triggerFile, contents }); }
  finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

function verifiedSync(source = initialSkill, commit = initialCommit) {
  let requests = 0;
  return (options, context) => upstream.run(options, { ...context, fetcher: async () => new globalThis.Response(++requests % 2 === 1 ? JSON.stringify({ sha: commit }) : source) });
}

function checkRegistry(directory, triggerFile) {
  const registry = loadContextRegistry({ repoRoot: directory });
  const { manifest, triggers } = loadSkillTriggers({ repoRoot: directory });
  assert.strictEqual(manifest.registryDigest, registry.registryDigest);
  assert.strictEqual(manifest.triggersDigest, digestObject(triggers));
  assert.strictEqual(manifest.coverage.skills, registry.entries.length);
  assert.strictEqual(manifest.coverage.withTriggers, Object.keys(triggers).length);
  return JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
}

async function main() {
  const results = [];
  results.push(await test('a successful upstream update refreshes real registry digests and preserves curated triggers and ECC instructions', () => withFixture(async ({ directory, skillDir, triggerFile }) => {
    const before = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    const wrapper = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const report = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: verifiedSync(initialSkill + '\nCover uncovered branches.\n', nextCommit) });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.updated, true);
    assert.strictEqual(report.registryUpdated, true);
    const after = checkRegistry(directory, triggerFile);
    assert.notStrictEqual(after.registryDigest, before.registryDigest);
    assert.deepStrictEqual(after.triggers, before.triggers);
    assert.deepStrictEqual(after.model, before.model);
    assert.strictEqual(after.generatedAt, before.generatedAt);
    assert.strictEqual(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), wrapper);
  })));

  results.push(await test('unchanged updates and offline checks are idempotent', () => withFixture(async ({ directory, triggerFile, contents }) => {
    const before = contents();
    const timestamp = fs.statSync(triggerFile, { bigint: true }).mtimeNs;
    const checked = await maintenance.run({ action: 'check' }, { repoRoot: directory, sync: async (options, context) => {
      assert.strictEqual(options.action, 'check');
      return upstream.run(options, { ...context, fetcher: async () => { throw new Error('Unexpected network access'); } });
    } });
    assert.strictEqual(checked.ok, true, JSON.stringify(checked));
    assert.strictEqual(checked.registryUpdated, false);
    const updated = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: verifiedSync() });
    assert.strictEqual(updated.ok, true, JSON.stringify(updated));
    assert.strictEqual(updated.updated, false);
    assert.strictEqual(updated.registryUpdated, false);
    assert.deepStrictEqual(contents(), before);
    assert.strictEqual(fs.statSync(triggerFile, { bigint: true }).mtimeNs, timestamp);
  })));

  results.push(await test('failed upstream fetches leave registry metadata and the skill tree unchanged', () => withFixture(async ({ directory, contents }) => {
    const before = contents();
    const report = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: (options, context) => upstream.run(options, { ...context, fetcher: async () => new globalThis.Response('Private response detail', { status: 503 }) }) });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.registryUpdated, false);
    assert.ok(!JSON.stringify(report).includes('Private response detail'));
    assert.deepStrictEqual(contents(), before);
  })));

  results.push(await test('offline checks report stale registry metadata without rewriting it', () => withFixture(async ({ directory, triggerFile, contents }) => {
    const manifest = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    fs.writeFileSync(triggerFile, json({ ...manifest, registryDigest: 'stale', coverage: { skills: 300, withTriggers: 0 } }));
    const before = contents();
    const report = await maintenance.run({ action: 'check' }, { repoRoot: directory, sync: verifiedSync() });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.registryUpdated, false);
    assert.ok(report.error.includes('stale'));
    assert.deepStrictEqual(contents(), before);
  })));

  results.push(await test('successful updates repair stale coverage counts even if upstream did not change', () => withFixture(async ({ directory, triggerFile }) => {
    const manifest = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    fs.writeFileSync(triggerFile, json({ ...manifest, registryDigest: 'stale', triggersDigest: 'stale', coverage: { skills: 300, withTriggers: 0 } }));
    const report = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: verifiedSync() });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.updated, false);
    assert.strictEqual(report.registryUpdated, true);
    checkRegistry(directory, triggerFile);
  })));

  results.push(await test('a non-checkout or malformed trigger manifest fails before upstream requests', () => withFixture(async ({ directory, triggerFile }) => {
    let invoked = false;
    const sync = async () => { invoked = true; throw new Error('Unexpected updater call'); };
    fs.rmSync(path.join(directory, '.git'));
    const missing = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync });
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.error.includes('checkout'));
    assert.strictEqual(invoked, false);
    fs.writeFileSync(path.join(directory, '.git'), 'gitdir: fixture\n');
    fs.writeFileSync(triggerFile, '{');
    assert.strictEqual((await maintenance.run({ action: 'update' }, { repoRoot: directory, sync })).ok, false);
    assert.strictEqual(invoked, false);
  })));

  results.push(await test('unknown trigger IDs are not silently retained under a refreshed digest', () => withFixture(async ({ directory, triggerFile }) => {
    const manifest = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    fs.writeFileSync(triggerFile, json({ ...manifest, triggers: { ...manifest.triggers, 'skill:missing-skill': ['unknown'] } }));
    const before = fs.readFileSync(triggerFile, 'utf8');
    let invoked = false;
    const report = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: async () => { invoked = true; return { ok: true }; } });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(invoked, false);
    assert.strictEqual(fs.readFileSync(triggerFile, 'utf8'), before);
  })));

  results.push(await test('metadata replacement failure is reported without losing curated triggers', () => withFixture(async ({ directory, triggerFile }) => {
    const manifest = JSON.parse(fs.readFileSync(triggerFile, 'utf8'));
    fs.writeFileSync(triggerFile, json({ ...manifest, registryDigest: 'stale' }));
    const before = fs.readFileSync(triggerFile, 'utf8');
    const fileSystem = { ...fs, renameSync() { throw new Error('Private filesystem detail'); } };
    const report = await maintenance.run({ action: 'update' }, { repoRoot: directory, sync: verifiedSync(), fileSystem });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.registryUpdated, false);
    assert.ok(!JSON.stringify(report).includes('Private filesystem detail'));
    assert.strictEqual(fs.readFileSync(triggerFile, 'utf8'), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(triggerFile)).sort(), ['skill-registry@1.json', 'skill-triggers@1.json']);
  })));

  results.push(await test('CLI help explains clone maintenance and installed-skill updates without running either', () => {
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('npm run ub-mode:update') && help.stdout.includes('sync-upstream.js'));
    const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(invalid.status, 2);
    assert.strictEqual(stableStringify({ a: 1 }), '{"a":1}');
  }));

  const failed = results.filter(result => !result).length;
  console.log(`\nPassed: ${results.length - failed}, Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
