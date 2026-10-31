const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

async function main() {
  const { createHeadlessGuard } = await import(pathToFileURL(path.resolve(__dirname, '../../opencode-v2/lib/headless-guard.js')).href);
  const restricted = createHeadlessGuard({
    ECC_HEADLESS_ALLOWED_TOOLS: 'Read,Write,Bash(git diff:*)',
    ECC_HEADLESS_DISALLOWED_TOOLS: 'Bash(git push:*)',
  });
  const deniedPush = createHeadlessGuard({ ECC_HEADLESS_DISALLOWED_TOOLS: 'Bash(git push:*)' });
  const permits = (guard, command, name = 'Bash') => guard.allows({ name, input: { command } });
  const results = [];

  results.push(await test('restricted commands reject compound execution and redirections', () => {
    const commands = [
      'git diff --stat && git push origin main',
      'git diff --stat; git push origin main',
      'git diff --stat || git push origin main',
      'git diff --stat | git push origin main',
      'git diff --stat & git push origin main',
      'git diff --stat\ngit push origin main',
      'git diff --stat\r\ngit push origin main',
      'git diff --stat > tracked.txt',
      'git diff --stat 2>>tracked.txt',
      'git diff --stat < input.txt',
      'git diff --stat <<< data',
    ];
    for (const command of commands) assert.strictEqual(permits(restricted, command), false, command);
  }));

  results.push(await test('restricted commands reject substitutions and shell language constructs', () => {
    const commands = [
      'git diff $(git push origin main)',
      'git diff "$(git push origin main)"',
      'git diff `git push origin main`',
      'git diff ${PATH}',
      'git diff $HOME',
      'git diff <(git push origin main)',
      'git diff >(git push origin main)',
      'git diff --stat # hidden shell content',
      'git diff --stat { git push origin main; }',
      'git diff --stat (git push origin main)',
      'git diff $\'quoted\'',
      'git diff src/*.js',
      'git diff src/file?.js',
      'git diff src/[ab].js',
      'git diff -- "unterminated',
      'git diff --stat\\',
      'git diff --stat\u0000ignored',
    ];
    for (const command of commands) assert.strictEqual(permits(restricted, command), false, command);
  }));

  results.push(await test('simple literal arguments and quoted paths remain usable', () => {
    const commands = [
      'git diff',
      'git diff --stat',
      'git\tdiff\t--stat',
      '  git diff -- src/a.ts  ',
      'git diff -- "src/file with spaces.ts"',
      "git diff -- 'src/file with spaces.ts'",
      "git diff -- 'src/a;$(literal).ts'",
      'git diff -- "src/a;b.ts"',
      'git diff -- \\;literal',
      "g'it' di\"ff\" --stat",
      '\\git diff --stat',
      'git diff -- "literal\\$name.ts"',
      "git diff -- 'src/*.ts'",
    ];
    for (const command of commands) assert.strictEqual(permits(restricted, command), true, command);
    assert.strictEqual(restricted.allows({ name: 'Read', input: {} }), true);
    assert.strictEqual(restricted.allows({ name: 'Edit', input: {} }), false);
  }));

  results.push(await test('deny-only rules reject hidden commands and normalized denied prefixes', () => {
    const commands = [
      'echo ok; git push origin main',
      'echo $(git push origin main)',
      'echo ok\ngit push origin main',
      "g'it' p'u'sh origin main",
      'git p\\ush origin main',
      'git\tpush\torigin main',
      'git "push" origin main',
    ];
    for (const command of commands) assert.strictEqual(permits(deniedPush, command), false, command);
    assert.strictEqual(permits(deniedPush, 'git status --short'), true);
    assert.strictEqual(permits(deniedPush, 'git push-backup'), true);
    assert.strictEqual(permits(restricted, 'git diff-other'), false);
  }));

  results.push(await test('exact command rules compare literal word boundaries', () => {
    const exact = createHeadlessGuard({ ECC_HEADLESS_ALLOWED_TOOLS: 'Bash(git status)' });
    assert.strictEqual(permits(exact, 'git status'), true);
    assert.strictEqual(permits(exact, 'git\tstatus'), true);
    assert.strictEqual(permits(exact, "'git' 'status'"), true);
    assert.strictEqual(permits(exact, 'git status --short'), false);
    assert.strictEqual(permits(exact, 'git status; echo done'), false);
  }));

  results.push(await test('PowerShell restrictions reject executable syntax and preserve literal Windows paths', () => {
    const commands = [
      'git diff; git push origin main',
      'git diff | Invoke-Expression',
      'git diff $(git push origin main)',
      'git diff "$env:PATH"',
      'git diff `; git push origin main',
      'git diff -- @("src/a.ts")',
      'git diff -- $([IO.File]::ReadAllText("a"))',
      'git diff --stat & git push origin main',
    ];
    for (const command of commands) assert.strictEqual(permits(restricted, command, 'PowerShell'), false, command);
    assert.strictEqual(permits(restricted, 'git diff -- "C:\\source files\\a.ts"', 'PowerShell'), true);
    assert.strictEqual(permits(restricted, "git diff -- 'C:\\source files\\owner''s.ts'", 'PowerShell'), true);
    assert.strictEqual(permits(restricted, 'GIT DIFF --stat', 'PowerShell'), true);
    assert.strictEqual(permits(deniedPush, 'GIT PUSH origin main', 'PowerShell'), false);
    assert.strictEqual(permits(deniedPush, 'git pu`sh origin main', 'PowerShell'), false);
    assert.strictEqual(permits(deniedPush, 'git p\u2018u\u2019sh origin main', 'PowerShell'), false);
    assert.strictEqual(permits(deniedPush, 'git --% push origin main', 'PowerShell'), false);
  }));

  results.push(await test('unrestricted shell rules preserve normal compound commands', () => {
    const unrestricted = createHeadlessGuard({ ECC_HEADLESS_ALLOWED_TOOLS: 'Bash' });
    assert.strictEqual(permits(unrestricted, 'git status && git diff --stat'), true);
    assert.strictEqual(permits(unrestricted, 'echo $(pwd)'), true);
    const deniedRead = createHeadlessGuard({ ECC_HEADLESS_DISALLOWED_TOOLS: 'Read' });
    assert.strictEqual(permits(deniedRead, 'git status && git diff --stat'), true);
    assert.strictEqual(createHeadlessGuard({}), null);
  }));

  results.push(await test('command denies also constrain an otherwise unrestricted shell allow', () => {
    const guard = createHeadlessGuard({ ECC_HEADLESS_ALLOWED_TOOLS: 'Bash', ECC_HEADLESS_DISALLOWED_TOOLS: 'Bash(git push:*)' });
    assert.strictEqual(permits(guard, 'git status'), true);
    assert.strictEqual(permits(guard, 'git status && git push origin main'), false);
    assert.strictEqual(permits(guard, 'git push origin main'), false);
  }));

  results.push(await test('malformed rule specifications cannot silently remove restrictions', () => {
    for (const invalid of ['Bash(git push:*', 'Bash(git push:*))', 'Bash()', 'Bash(:*)', 'Bash(git push:*)invalid']) {
      for (const field of ['ECC_HEADLESS_ALLOWED_TOOLS', 'ECC_HEADLESS_DISALLOWED_TOOLS']) {
        const guard = createHeadlessGuard({ [field]: invalid });
        assert.ok(guard, invalid);
        assert.strictEqual(permits(guard, 'git push origin main'), false, `${field} ${invalid}`);
        assert.strictEqual(guard.allows({ name: 'Read', input: {} }), false, `${field} ${invalid}`);
      }
    }
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
