const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..', '..');
const load = relative => import(pathToFileURL(path.join(root, 'opencode-v2', relative)).href);
const snapshot = entries => ({ available: true, complete: true, files: new Map(entries), diagnostic: '' });

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

async function main() {
  const { createReviewGate } = await load('lib/review-gate.js');
  const projectDir = path.resolve(os.tmpdir(), 'ecc-gate-unit');
  const harness = async (entries = []) => {
    let current = snapshot(entries);
    const gate = createReviewGate({ projectDir, readSnapshot: async () => current });
    await gate.startTurn('session');
    return { gate, update: entries => { current = snapshot(entries); }, fail: diagnostic => { current = { available: true, complete: false, files: new Map(), diagnostic }; } };
  };
  const results = [];

  results.push(await test('an attempted or failed reviewer does not satisfy the gate', async () => {
    const { gate, update } = await harness();
    update([['a.ts', 'changed']]);
    await gate.beginReview('session', 'review-1', 'code-reviewer');
    assert.ok(await gate.claim('session'));
    await gate.completeReview('session', 'review-1', 'error');
    assert.ok(await gate.claim('session'));
  }));

  results.push(await test('only a completed reviewer of the unchanged snapshot satisfies the gate', async () => {
    const { gate, update } = await harness();
    update([['a.ts', 'changed']]);
    await gate.beginReview('session', 'review-1', 'code-reviewer');
    await gate.completeReview('session', 'review-1', 'completed');
    assert.strictEqual(await gate.claim('session'), null);
    update([['a.ts', 'changed-again']]);
    assert.ok(await gate.claim('session'));
  }));

  results.push(await test('review before implementation and changes during review cannot approve new code', async () => {
    const { gate, update } = await harness();
    await gate.beginReview('session', 'review-before', 'code-reviewer');
    await gate.completeReview('session', 'review-before', 'completed');
    update([['a.ts', 'first']]);
    await gate.beginReview('session', 'review-during', 'code-reviewer');
    update([['a.ts', 'second']]);
    await gate.completeReview('session', 'review-during', 'completed');
    assert.ok(await gate.claim('session'));
  }));

  results.push(await test('shell changes are detected and initial dirty files alone need no review', async () => {
    const { gate, update } = await harness([['existing.ts', 'owner-change']]);
    assert.strictEqual(await gate.claim('session'), null);
    update([['existing.ts', 'owner-change'], ['generated.ts', 'new-file']]);
    const message = await gate.claim('session');
    assert.ok(message.includes('generated.ts'));
    assert.ok(!message.includes('- existing.ts'));
    assert.strictEqual(await gate.claim('session'), null);
  }));

  results.push(await test('a reviewer from a previous turn cannot approve the new turn', async () => {
    const { gate, update } = await harness();
    update([['a.ts', 'first']]);
    await gate.beginReview('session', 'old-review', 'code-reviewer');
    await gate.startTurn('session');
    update([['a.ts', 'second']]);
    await gate.completeReview('session', 'old-review', 'completed');
    assert.ok(await gate.claim('session'));
  }));

  results.push(await test('explicit edits are tracked outside Git and failed review can be retried', async () => {
    const gate = createReviewGate({ projectDir, readSnapshot: async () => ({ available: false, complete: true, files: new Map(), diagnostic: '' }) });
    await gate.startTurn('session');
    await gate.recordChanges('session', ['a.ts']);
    assert.ok(await gate.claim('session'));
    await gate.beginReview('session', 'review-1', 'code-reviewer');
    await gate.completeReview('session', 'review-1', 'error');
    assert.ok(await gate.claim('session'));
    await gate.beginReview('session', 'review-2', 'code-reviewer');
    await gate.completeReview('session', 'review-2', 'completed');
    assert.strictEqual(await gate.claim('session'), null);
    await gate.recordChanges('session', ['a.ts']);
    assert.ok(await gate.claim('session'));
  }));

  results.push(await test('incomplete inspection reports a bounded diagnostic and never grants approval', async () => {
    const { gate, fail } = await harness();
    fail('file limit exceeded');
    await gate.beginReview('session', 'review-1', 'code-reviewer');
    await gate.completeReview('session', 'review-1', 'completed');
    const message = await gate.claim('session');
    assert.ok(message.includes('file limit exceeded'));
    assert.strictEqual(await gate.claim('session'), null);
  }));

  results.push(await test('working tree inspection sees tracked edits, untracked files, deletions and ignores generated caches', async () => {
    const { readWorkingTreeSnapshot } = await load('lib/working-tree.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-gate-git-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
      fs.writeFileSync(path.join(dir, 'tracked.ts'), 'first');
      execFileSync('git', ['add', '.'], { cwd: dir });
      const before = await readWorkingTreeSnapshot(dir);
      fs.writeFileSync(path.join(dir, 'tracked.ts'), 'second');
      fs.writeFileSync(path.join(dir, 'new file.ts'), 'new');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'ignored');
      const after = await readWorkingTreeSnapshot(dir);
      assert.strictEqual(after.complete, true);
      assert.notStrictEqual(after.files.get('tracked.ts'), before.files.get('tracked.ts'));
      assert.ok(after.files.has('new file.ts'));
      assert.ok(![...after.files.keys()].some(file => file.startsWith('node_modules')));
      fs.unlinkSync(path.join(dir, 'tracked.ts'));
      const deleted = await readWorkingTreeSnapshot(dir);
      assert.notStrictEqual(deleted.files.get('tracked.ts'), after.files.get('tracked.ts'));
      const limited = await readWorkingTreeSnapshot(dir, { maxFiles: 1 });
      assert.strictEqual(limited.complete, false);
      assert.ok(limited.diagnostic);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await test('committing initial changes does not count as new work but committed shell edits do', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-gate-commit-'));
    const configuredIdentity = (key, fallback) => {
      try {
        return execFileSync('git', ['config', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback;
      } catch {
        return fallback;
      }
    };
    const userName = configuredIdentity('user.name', 'ECC test fixture');
    const userEmail = configuredIdentity('user.email', 'ecc-test@example.invalid');
    const git = args => execFileSync('git', ['-c', `user.name=${userName}`, '-c', `user.email=${userEmail}`, '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(dir, 'no-hooks')}`, ...args], { cwd: dir, stdio: 'pipe' });
    try {
      git(['init', '-q']);
      fs.writeFileSync(path.join(dir, 'owner.ts'), 'owner change');
      git(['add', '.']);
      const gate = createReviewGate({ projectDir: dir });
      await gate.startTurn('session');
      git(['commit', '-qm', 'test: capture initial fixture']);
      assert.strictEqual(await gate.claim('session'), null);
      fs.writeFileSync(path.join(dir, 'owner.ts'), 'agent change');
      git(['add', '.']);
      git(['commit', '-qm', 'test: capture changed fixture']);
      assert.ok((await gate.claim('session')).includes('owner.ts'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}\nFailed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
