const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'skills', 'ub-mode', 'scripts', 'review.js');
const { parseArgs, runReview } = require(runnerPath);
const { runCommand } = require(path.join(path.dirname(runnerPath), 'review-process.js'));
const SOURCE = 'export function greater(left, right) { return left > right; }\n';
const SECOND_FUNCTION = 'export function lesser(left, right) { return left < right; }\n';
const SECRET = 'private-runner-detail-do-not-print';
const originalTestCommand = process.env.ECC_UB_TEST_COMMAND;
delete process.env.ECC_UB_TEST_COMMAND;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`  FAIL ${name}\n    Error: ${error.message}`);
    return false;
  }
}

async function withProject(source, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ub-review-test-'));
  const project = path.join(directory, 'project with spaces');
  const file = path.join(project, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(project, 'package.json'), '{"private":true}\n');
  const original = fs.readFileSync(file);
  try {
    await run({ directory, project, file, original });
    assert.deepStrictEqual(fs.readFileSync(file), original, 'review must preserve the target source');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function optionsFor(project, extra = []) {
  return parseArgs(['--project', project, '--file', 'src/a.ts', ...extra]);
}

function commandResult(exitCode, extra = {}) {
  return { exitCode, stdout: '', stderr: '', timedOut: false, cleanupConfirmed: true, ...extra };
}

function inventory(project, { covered = true, mutatorStatus = 'inventory', crapperStatus = 'pass', dryerStatus = 'pass' } = {}) {
  const source = fs.readFileSync(path.join(project, 'src', 'a.ts'));
  const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
  const sites = ['>', '<'].flatMap(operator => {
    const start = source.indexOf(Buffer.from(` ${operator} `)) + 1;
    return start > 0 ? [{ file: 'src/a.ts', line: 1, start, end: start + 1, original: operator, mutant: `${operator}=`, covered, sourceSha256 }] : [];
  });
  return { schemaVersion: 1, tools: {
    crapper: { status: crapperStatus, findings: [] },
    dryer: { status: dryerStatus, duplicates: [] },
    mutator: { status: mutatorStatus, mode: 'scan', sites },
  } };
}

const TEST_COMMAND = ['fixture-test', '--run-in-band'];
const TEST_FLAGS = ['--test-command-json', JSON.stringify(TEST_COMMAND)];

async function main() {
  const results = [];

  results.push(await test('CLI options preserve argv and enforce diagnostic limits', () => {
    const defaults = parseArgs([]);
    assert.strictEqual(defaults.project, path.resolve(process.cwd()));
    assert.strictEqual(defaults.python, process.env.ECC_UB_PYTHON || 'python');
    assert.strictEqual(defaults.base, 'HEAD');
    assert.strictEqual(defaults.maxMutants, 20);
    const configured = parseArgs(['--project', '.', '--python', 'local-python', '--base', 'main', '--file', 'src/a.ts', '--file', 'src/b.ts', '--max-mutants', '2', '--timeout-ms', '1500', '--budget-ms', '5000', ...TEST_FLAGS]);
    assert.deepStrictEqual(configured.files, ['src/a.ts', 'src/b.ts']);
    assert.deepStrictEqual(configured.testCommand, TEST_COMMAND);
    assert.strictEqual(configured.python, 'local-python');
    assert.strictEqual(configured.timeoutMs, 1500);
    assert.strictEqual(configured.budgetMs, 5000);
    for (const argv of [
      ['--unknown'], ['--project'], ['--max-mutants', '0'], ['--max-mutants', '201'], ['--max-mutants', '1.5'],
      ['--timeout-ms', '0'], ['--timeout-ms', '120001'], ['--budget-ms', '0'], ['--budget-ms', '1800001'],
      ['--test-command-json', '{}'], ['--test-command-json', '[]'], ['--test-command-json', '["node",42]'],
      ['--test-command-json', '[""]'], ['--test-command-json', 'invalid'],
    ]) assert.throws(() => parseArgs(argv), argv.join(' '));
  }));

  results.push(await test('explicit files bypass Git discovery and remain loadable in a project without Git', () => withProject(SOURCE, async ({ project }) => {
    let analyzed = false;
    const report = await runReview(optionsFor(project, ['--file', 'src/a.ts']), {
      analyze: async input => {
        analyzed = true;
        assert.strictEqual(input.project, project);
        assert.deepStrictEqual(input.files, ['src/a.ts']);
        return inventory(input.project);
      },
      runTest: async () => { throw new Error('Scan-only review must not run a test command'); },
    });
    assert.strictEqual(analyzed, true);
    assert.deepStrictEqual(report.scope.files, ['src/a.ts']);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.mode, 'scan');
    assert.strictEqual(report.mutation.status, 'incomplete');
  })));

  results.push(await test('paths outside the requested project are rejected before tool execution', () => withProject(SOURCE, async ({ project }) => {
    for (const relative of ['../outside.ts', path.resolve(project, '..', 'outside.ts')]) {
      let analyzed = false;
      await assert.rejects(async () => runReview(parseArgs(['--project', project, '--file', relative]), {
        analyze: async input => { analyzed = true; return inventory(input.project); },
      }));
      assert.strictEqual(analyzed, false);
    }
  })));

  results.push(await test('Git scope includes staged changes and untracked files without explicit file options', () => withProject(SOURCE, async ({ project }) => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    const base = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: project, input: '', encoding: 'utf8' }).trim();
    execFileSync('git', ['add', 'package.json', 'src/a.ts'], { cwd: project });
    fs.writeFileSync(path.join(project, 'src', 'b.ts'), SECOND_FUNCTION);
    const report = await runReview(parseArgs(['--project', project, '--base', base]), {
      analyze: async input => {
        assert.deepStrictEqual([...input.files].sort(), ['package.json', 'src/a.ts', 'src/b.ts']);
        return inventory(input.project);
      },
    });
    assert.deepStrictEqual([...report.scope.files].sort(), ['package.json', 'src/a.ts', 'src/b.ts']);
  })));

  results.push(await test('unavailable Git scope fails before analysis with an explicit-file recovery', () => withProject(SOURCE, async ({ project }) => {
    let analyzed = false;
    await assert.rejects(() => runReview(parseArgs(['--project', project]), {
      analyze: async input => { analyzed = true; return inventory(input.project); },
    }), /--file/);
    assert.strictEqual(analyzed, false);
  })));

  results.push(await test('a mutation-sensitive test kills a candidate only inside an isolated source snapshot', () => withProject(SOURCE, async ({ project, original }) => {
    const observed = [];
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        assert.notStrictEqual(input.project, project);
        assert.deepStrictEqual(fs.readFileSync(path.join(input.project, 'src', 'a.ts')), original);
        return inventory(input.project);
      },
      runTest: async (argv, context) => {
        assert.deepStrictEqual(argv, TEST_COMMAND);
        assert.notStrictEqual(context.cwd, project);
        assert.ok(context.timeoutMs > 0);
        const source = fs.readFileSync(path.join(context.cwd, 'src', 'a.ts'), 'utf8');
        observed.push(source);
        return commandResult(source === SOURCE ? 0 : 1);
      },
    });
    assert.deepStrictEqual(observed, [SOURCE, SOURCE.replace(' > ', ' >= ')]);
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.mutation.mode, 'full');
    assert.strictEqual(report.mutation.status, 'pass');
    assert.strictEqual(report.mutation.killed, 1);
    assert.strictEqual(report.mutation.survived, 0);
  })));

  results.push(await test('a surviving candidate fails the mutation gate', () => withProject(SOURCE, async ({ project }) => {
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => inventory(input.project),
      runTest: async () => commandResult(0),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.status, 'fail');
    assert.strictEqual(report.mutation.survived, 1);
  })));

  results.push(await test('uncovered candidates are reported without being executed', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => inventory(input.project, { covered: false }),
      runTest: async () => { calls += 1; return commandResult(0); },
    });
    assert.strictEqual(calls, 1, 'only the baseline may run for uncovered candidates');
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.uncovered, 1);
    assert.strictEqual(report.mutation.status, 'incomplete');
  })));

  results.push(await test('a candidate cap preserves the untested verification gap', () => withProject(SOURCE + SECOND_FUNCTION, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, [...TEST_FLAGS, '--max-mutants', '1']), {
      analyze: async input => inventory(input.project),
      runTest: async () => commandResult(calls++ === 0 ? 0 : 1),
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(report.mutation.killed, 1);
    assert.strictEqual(report.mutation.untested, 1);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.status, 'incomplete');
  })));

  results.push(await test('an exhausted review budget leaves candidates untested', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, [...TEST_FLAGS, '--budget-ms', '500']), {
      analyze: async input => {
        await new Promise(resolve => setTimeout(resolve, 650));
        return inventory(input.project);
      },
      runTest: async (_argv, context) => {
        calls += 1;
        assert.strictEqual(fs.readFileSync(path.join(context.cwd, 'src', 'a.ts'), 'utf8'), SOURCE);
        return commandResult(0);
      },
    });
    assert.strictEqual(calls, 1, 'the baseline may run, but the expired budget must prevent mutant execution');
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.status, 'incomplete');
    assert.ok(report.mutation.untested > 0);
  })));

  results.push(await test('an invalid baseline prevents mutation execution', async () => {
    for (const failure of [commandResult(1), commandResult(null, { timedOut: true }), commandResult(0, { cleanupConfirmed: false }), commandResult(0, { outputLimit: true })]) {
      await withProject(SOURCE, async ({ project }) => {
        let calls = 0;
        const report = await runReview(optionsFor(project, TEST_FLAGS), {
          analyze: async input => inventory(input.project),
          runTest: async (_argv, context) => {
            calls += 1;
            assert.strictEqual(fs.readFileSync(path.join(context.cwd, 'src', 'a.ts'), 'utf8'), SOURCE);
            return failure;
          },
        });
        assert.strictEqual(calls, 1);
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.mutation.killed, 0);
        assert.strictEqual(report.mutation.status, 'incomplete');
      });
    }
  }));

  results.push(await test('a timed-out mutant remains untested instead of being counted as killed', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => inventory(input.project),
      runTest: async () => calls++ === 0 ? commandResult(0) : commandResult(null, { timedOut: true }),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.killed, 0);
    assert.strictEqual(report.mutation.untested, 1);
    assert.strictEqual(report.mutation.timedOut, 1);
  })));

  results.push(await test('Unicode before a mutation site preserves byte offsets and all surrounding source', () => withProject('const label = "Привет";\n' + SOURCE, async ({ project, original }) => {
    const originalText = original.toString('utf8');
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => inventory(input.project),
      runTest: async (_argv, context) => {
        const expected = calls++ === 0 ? originalText : originalText.replace(' > ', ' >= ');
        assert.strictEqual(fs.readFileSync(path.join(context.cwd, 'src', 'a.ts'), 'utf8'), expected);
        return commandResult(calls === 1 ? 0 : 1);
      },
    });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
  })));

  results.push(await test('tool and test exceptions never modify the original project', async () => {
    await withProject(SOURCE, async ({ project }) => {
      await assert.rejects(() => runReview(optionsFor(project, TEST_FLAGS), {
        analyze: async () => { throw new Error(SECRET); },
      }));
      let calls = 0;
      await assert.rejects(() => runReview(optionsFor(project, TEST_FLAGS), {
        analyze: async input => inventory(input.project),
        runTest: async () => { if (calls++ === 0) return commandResult(0); throw new Error(SECRET); },
      }));
    });
  }));

  results.push(await test('a stale analyzer source hash prevents applying a candidate mutation', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    await assert.rejects(() => runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        const report = inventory(input.project);
        const sites = report.tools.mutator.sites.map(site => ({ ...site, sourceSha256: '0'.repeat(64) }));
        return { ...report, tools: { ...report.tools, mutator: { ...report.tools.mutator, sites } } };
      },
      runTest: async () => { calls += 1; return commandResult(0); },
    }), /source snapshot/);
    assert.strictEqual(calls, 1, 'a stale candidate must never reach the mutation test command');
  })));

  results.push(await test('static quality failures cannot be overridden by killed mutants', async () => {
    for (const changed of [{ crapperStatus: 'fail' }, { dryerStatus: 'fail' }]) {
      await withProject(SOURCE, async ({ project }) => {
        let calls = 0;
        const report = await runReview(optionsFor(project, TEST_FLAGS), {
          analyze: async input => inventory(input.project, changed),
          runTest: async () => commandResult(calls++ === 0 ? 0 : 1),
        });
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.mutation.killed, 1);
      });
    }
  }));

  results.push(await test('an unavailable mutation tool cannot pass by returning no candidate sites', () => withProject(SOURCE, async ({ project }) => {
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        const report = inventory(input.project, { mutatorStatus: 'unavailable' });
        return { ...report, tools: { ...report.tools, mutator: { ...report.tools.mutator, sites: [] } } };
      },
      runTest: async () => commandResult(0),
    });
    assert.strictEqual(report.ok, false);
    assert.notStrictEqual(report.mutation.status, 'pass');
  })));

  results.push(await test('an empty inventory on applicable source cannot prove mutation testing passed', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        const report = inventory(input.project);
        return { ...report, tools: { ...report.tools, mutator: { ...report.tools.mutator, sites: [] } } };
      },
      runTest: async () => { calls += 1; return commandResult(0); },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.mutation.status, 'incomplete');
  })));

  results.push(await test('a baseline that changes selected source is rejected before analysis', () => withProject(SOURCE, async ({ project }) => {
    let analyzed = false;
    await assert.rejects(() => runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => { analyzed = true; return inventory(input.project); },
      runTest: async (_argv, context) => {
        fs.writeFileSync(path.join(context.cwd, 'src', 'a.ts'), SOURCE.replace(' > ', ' >= '));
        return commandResult(0);
      },
    }));
    assert.strictEqual(analyzed, false);
  })));

  results.push(await test('unsupported source remains a verification gap even when other tools and mutants pass', () => withProject(SOURCE, async ({ project }) => {
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        const report = inventory(input.project);
        return { ...report, tools: { ...report.tools, dryer: { status: 'not-applicable', unsupportedFiles: ['src/a.ts'] } } };
      },
      runTest: async () => commandResult(calls++ === 0 ? 0 : 1),
    });
    assert.strictEqual(report.mutation.killed, 1);
    assert.strictEqual(report.ok, false);
  })));

  results.push(await test('unexpected source changes during a mutant test cannot count as a killed mutant', async () => {
    for (const changed of ['src/a.ts', 'src/b.ts']) {
      await withProject(SOURCE, async ({ project }) => {
        const second = path.join(project, 'src', 'b.ts');
        fs.writeFileSync(second, SECOND_FUNCTION);
        let calls = 0;
        await assert.rejects(() => runReview(optionsFor(project, ['--file', 'src/b.ts', ...TEST_FLAGS]), {
          analyze: async input => inventory(input.project),
          runTest: async (_argv, context) => {
            if (calls++ === 0) return commandResult(0);
            fs.writeFileSync(path.join(context.cwd, changed), 'export const changedByTest = true;\n');
            return commandResult(1);
          },
        }));
        assert.strictEqual(calls, 2);
        assert.strictEqual(fs.readFileSync(second, 'utf8'), SECOND_FUNCTION);
      });
    }
  }));

  results.push(await test('mutation analysis receives coverage generated by the baseline in the isolated snapshot', () => withProject(SOURCE, async ({ project }) => {
    const coverage = 'TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n';
    let calls = 0;
    const report = await runReview(optionsFor(project, TEST_FLAGS), {
      analyze: async input => {
        assert.notStrictEqual(input.project, project);
        assert.strictEqual(fs.readFileSync(path.join(input.project, 'coverage', 'lcov.info'), 'utf8'), coverage);
        return inventory(input.project);
      },
      runTest: async (_argv, context) => {
        const baseline = calls++ === 0;
        if (baseline) {
          fs.mkdirSync(path.join(context.cwd, 'coverage'));
          fs.writeFileSync(path.join(context.cwd, 'coverage', 'lcov.info'), coverage);
        }
        return commandResult(baseline ? 0 : 1);
      },
    });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.mutation.killed, 1);
    assert.strictEqual(calls, 2, 'one baseline and one mutant test must run');
    assert.strictEqual(fs.existsSync(path.join(project, 'coverage')), false);
  })));

  results.push(await test('known mutation tool failures without sites remain visible as incomplete gates', async () => {
    for (const status of ['unavailable', 'error', 'incomplete', 'fail']) {
      await withProject(SOURCE, async ({ project }) => {
        let calls = 0;
        const message = `The local mutation tool reported ${status}`;
        const report = await runReview(optionsFor(project, TEST_FLAGS), {
          analyze: async input => {
            const report = inventory(input.project);
            return { ...report, tools: { ...report.tools, mutator: { status, message, mode: 'scan' } } };
          },
          runTest: async () => { calls += 1; return commandResult(0); },
        });
        assert.strictEqual(report.ok, false);
        assert.strictEqual(report.mutation.status, 'incomplete');
        assert.strictEqual(report.tools.mutator.message, message);
        assert.strictEqual(calls, 1, 'a tool failure must not execute any mutants');
      });
    }
  }));

  results.push(await test('unknown tool statuses and incomplete inventories fail closed', async () => {
    for (const mutator of [{ status: 'unexpected', sites: [] }, { status: 'inventory' }, { status: 'inventory', sites: 'invalid' }]) {
      await withProject(SOURCE, async ({ project }) => {
        await assert.rejects(() => runReview(optionsFor(project), {
          analyze: async input => {
            const report = inventory(input.project);
            return { ...report, tools: { ...report.tools, mutator } };
          },
        }));
      });
    }
  }));

  results.push(await test('documentation-only scope can complete without running tests or mutation tools', () => withProject(SOURCE, async ({ project }) => {
    fs.writeFileSync(path.join(project, 'README.md'), 'Project documentation\n');
    const report = await runReview(parseArgs(['--project', project, '--file', 'README.md']), {
      analyze: async input => {
        assert.deepStrictEqual(input.files, ['README.md']);
        return { schemaVersion: 1, tools: Object.fromEntries(['crapper', 'dryer', 'mutator'].map(tool => [tool, { status: 'not-applicable' }])) };
      },
      runTest: async () => { throw new Error('Documentation-only scans must not run tests'); },
    });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.strictEqual(report.mutation.status, 'not-applicable');
  })));

  results.push(await test('a requested test command cannot pass when its baseline fails on documentation-only scope', () => withProject(SOURCE, async ({ project }) => {
    fs.writeFileSync(path.join(project, 'README.md'), 'Project documentation\n');
    const report = await runReview(parseArgs(['--project', project, '--file', 'README.md', ...TEST_FLAGS]), {
      analyze: async () => ({ schemaVersion: 1, tools: Object.fromEntries(['crapper', 'dryer', 'mutator'].map(tool => [tool, { status: 'not-applicable' }])) }),
      runTest: async () => commandResult(1),
    });
    assert.strictEqual(report.ok, false);
  })));

  results.push(await test('CLI help, invalid args and unavailable tools have explicit redacted outcomes', () => withProject(SOURCE, async ({ directory, project }) => {
    const invoke = args => spawnSync(process.execPath, [runnerPath, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const help = invoke(['--help']);
    assert.strictEqual(help.status, 0, help.stderr);
    assert.ok(help.stdout.includes('--test-command-json'));
    const invalid = invoke(['--max-mutants', '0']);
    assert.strictEqual(invalid.status, 2);
    const missing = invoke(['--project', project, '--file', 'src/a.ts', '--python', path.join(directory, SECRET), '--timeout-ms', '1000']);
    assert.strictEqual(missing.status, 1, missing.stderr);
    const report = JSON.parse(missing.stdout);
    assert.strictEqual(report.ok, false);
    assert.ok(!`${missing.stdout}${missing.stderr}`.includes(SECRET));
  })));

  results.push(await test('child command output preserves fragmented UTF-8 and stdin without shell parsing', async () => {
    const script = 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",part=>input+=part);process.stdin.on("end",()=>{const bytes=Buffer.from(input);process.stdout.write(bytes.subarray(0,1));setTimeout(()=>process.stdout.write(bytes.subarray(1)),10);});';
    const result = await runCommand([process.execPath, '-e', script], { cwd: os.tmpdir(), timeoutMs: 3000, input: 'Привет & literal' });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'Привет & literal');
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.cleanupConfirmed, true);
  }));

  results.push(await test('child command deadlines bound a stalled process', async () => {
    const started = Date.now();
    const result = await runCommand([process.execPath, '-e', 'setInterval(()=>{},1000);'], { cwd: os.tmpdir(), timeoutMs: 100 });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.exitCode, null);
    assert.strictEqual(typeof result.cleanupConfirmed, 'boolean');
    assert.ok(Date.now() - started < 5000);
  }));

  results.push(await test('oversized child output is bounded and cannot look like a successful command', async () => {
    const result = await runCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(5*1024*1024));setInterval(()=>{},1000);'], { cwd: os.tmpdir(), timeoutMs: 3000 });
    assert.strictEqual(result.outputLimit, true);
    assert.strictEqual(result.exitCode, null);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4 * 1024 * 1024);
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}\nFailed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (originalTestCommand === undefined) delete process.env.ECC_UB_TEST_COMMAND;
  else process.env.ECC_UB_TEST_COMMAND = originalTestCommand;
});
