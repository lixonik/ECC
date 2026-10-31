#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCommand } = require('./review-process');

const MAX_SNAPSHOT_FILES = 10000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const EXCLUDED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.metrics', 'dist', 'build', '.next', '.angular']);
const VALUE_FLAGS = { '--project': 'project', '--python': 'python', '--base': 'base', '--file': 'file', '--test-command-json': 'testCommand', '--max-mutants': 'maxMutants', '--timeout-ms': 'timeoutMs', '--budget-ms': 'budgetMs' };
const USAGE = `Usage: node review.js [options]
  --project <dir>            project directory (default: current directory)
  --python <exe>             dedicated Python executable (or ECC_UB_PYTHON)
  --base <ref>               Git diff base (default: HEAD)
  --file <relative-path>     explicit changed file; repeat to bypass Git discovery
  --test-command-json <argv> noninteractive test command as a JSON argument array
  --max-mutants <count>      mutation limit, 1..200 (default: 20)
  --timeout-ms <ms>          command timeout, 1..120000 (default: 30000)
  --budget-ms <ms>           total budget, 1..1800000 (default: 300000)
  --help                    show help

Without a test command, mutator reports an inventory and an incomplete mutation gate.
Set ECC_UB_TEST_COMMAND to a JSON argument array to configure a local default.
`;

function integerOption(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${name} is outside its supported range`);
  return number;
}

function hasControlCharacter(value) {
  return [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
}

function testCommand(value) {
  if (!value) return undefined;
  let argv;
  try { argv = JSON.parse(value); } catch { throw new Error('Test command must be a JSON argument array'); }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(item => typeof item !== 'string' || !item || hasControlCharacter(item))) throw new Error('Test command must contain nonempty string arguments');
  return argv;
}

function parseArgs(argv) {
  const options = { project: process.cwd(), python: process.env.ECC_UB_PYTHON || 'python', base: 'HEAD', files: [], maxMutants: 20, timeoutMs: 30000, budgetMs: 300000, help: false };
  let command = process.env.ECC_UB_TEST_COMMAND;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') { options.help = true; continue; }
    if (!Object.hasOwn(VALUE_FLAGS, flag)) throw new Error('Unknown option; use --help');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    const key = VALUE_FLAGS[flag];
    if (key === 'file') options.files.push(value);
    else if (key === 'testCommand') command = value;
    else options[key] = value;
  }
  options.project = path.resolve(options.project);
  options.maxMutants = integerOption(options.maxMutants, '--max-mutants', 200);
  options.timeoutMs = integerOption(options.timeoutMs, '--timeout-ms', 120000);
  options.budgetMs = integerOption(options.budgetMs, '--budget-ms', 1800000);
  options.testCommand = testCommand(command);
  if (options.base.startsWith('-') || hasControlCharacter(options.base)) throw new Error('Invalid Git base reference');
  return options;
}

function projectFile(project, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || hasControlCharacter(relative)) throw new Error('Changed files must use relative project paths');
  const file = path.resolve(project, relative);
  const inside = path.relative(project, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Changed file is outside the project');
  let current = project;
  for (const segment of inside.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Changed files cannot pass through symbolic links');
  }
  return file;
}

async function changedFiles(options, remaining) {
  if (options.files.length) return [...new Set(options.files.map(file => path.relative(options.project, projectFile(options.project, file)).split(path.sep).join('/')))];
  const responses = await Promise.all([
    runCommand(['git', '-c', 'core.fsmonitor=false', 'diff', '--name-only', '-z', '--diff-filter=ACMRTUB', options.base, '--'], { cwd: options.project, timeoutMs: Math.min(options.timeoutMs, remaining()) }),
    runCommand(['git', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: options.project, timeoutMs: Math.min(options.timeoutMs, remaining()) }),
  ]);
  if (responses.some(response => response.exitCode !== 0 || response.outputLimit || response.timedOut)) throw new Error('Git scope could not be read; supply explicit --file options');
  return [...new Set(responses.flatMap(response => response.stdout.split('\0').filter(Boolean)))].filter(relative => fs.existsSync(projectFile(options.project, relative)));
}

function snapshotProject(project, destination, remaining) {
  let files = 0;
  let bytes = 0;
  const copy = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (remaining() <= 0) throw new Error('Review budget expired while copying sources');
      if (EXCLUDED.has(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) copy(from, to);
      else if (entry.isFile()) {
        const stat = fs.statSync(from);
        files += 1;
        bytes += stat.size;
        if (files > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) throw new Error('Source snapshot exceeds its file or byte limit');
        fs.copyFileSync(from, to);
      }
    }
  };
  copy(project, destination);
  const dependencies = path.join(project, 'node_modules');
  if (fs.existsSync(dependencies)) fs.symlinkSync(fs.realpathSync(dependencies), path.join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

async function analyzeProject({ project, files, python, timeoutMs }) {
  const result = await runCommand([python, '-I', '-B', '-X', 'utf8', path.join(__dirname, 'analyze.py')], { cwd: project, timeoutMs, input: JSON.stringify({ project, files }) });
  if (result.exitCode !== 0 || result.outputLimit || result.timedOut || !result.cleanupConfirmed) throw new Error('Local quality tools could not complete; check the Python environment and tool requirements');
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('Local quality tools returned an invalid report'); }
  return normalizeReport(report);
}

function normalizeReport(report) {
  const statuses = new Set(['pass', 'fail', 'incomplete', 'not-applicable', 'unavailable', 'error', 'inventory']);
  if (report?.schemaVersion !== 1 || ['crapper', 'dryer', 'mutator'].some(tool => !statuses.has(report.tools?.[tool]?.status))) throw new Error('Local quality report is incomplete');
  const mutator = report.tools.mutator;
  if (mutator.status === 'inventory' && !Array.isArray(mutator.sites)) throw new Error('Mutation inventory is incomplete');
  if (mutator.sites !== undefined && !Array.isArray(mutator.sites)) throw new Error('Mutation inventory is invalid');
  return { ...report, tools: { ...report.tools, mutator: { ...mutator, sites: mutator.sites ?? [] } } };
}

function mutationBytes(project, site) {
  const file = projectFile(project, site.file);
  const original = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  if (hash !== site.sourceSha256 || !Number.isInteger(site.start) || !Number.isInteger(site.end) || site.start < 0 || site.end < site.start || site.end > original.length || typeof site.original !== 'string' || typeof site.mutant !== 'string' || original.subarray(site.start, site.end).toString('utf8') !== site.original) throw new Error('Mutation site does not match the source snapshot');
  return { file, original, mutated: Buffer.concat([original.subarray(0, site.start), Buffer.from(site.mutant), original.subarray(site.end)]) };
}

function testCompleted(result) {
  return Number.isInteger(result.exitCode) && !result.timedOut && !result.outputLimit && result.cleanupConfirmed !== false;
}

function sourceHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceFingerprints(project, files) {
  return new Map(files.map(relative => {
    const file = projectFile(project, relative);
    return [process.platform === 'win32' ? file.toLowerCase() : file, sourceHash(file)];
  }));
}

function assertSourcesUnchanged(expected) {
  if ([...expected].some(([file, hash]) => sourceHash(file) !== hash)) throw new Error('The test command changed selected sources; review requires a stable source snapshot');
}

async function runBaseline(options, project, files, runTest, remaining) {
  const before = sourceFingerprints(project, files);
  const result = await runTest(options.testCommand, { cwd: project, timeoutMs: Math.min(options.timeoutMs, remaining()) });
  assertSourcesUnchanged(before);
  return result;
}

async function executeMutations(options, project, sites, runTest, remaining, { baseline, files }) {
  const covered = sites.filter(site => site.covered === true);
  const mutation = { mode: 'full', status: 'incomplete', killed: 0, survived: 0, uncovered: sites.length - covered.length, untested: covered.length, timedOut: 0, results: [] };
  if (!testCompleted(baseline) || baseline.exitCode !== 0) return { ...mutation, message: 'The baseline test command did not pass; no mutants were executed' };
  if (sites.length === 0) return { ...mutation, message: 'No mutation sites were produced; mutation testing remains unverified' };
  const sources = sourceFingerprints(project, files);
  for (const site of covered.slice(0, options.maxMutants)) {
    if (remaining() <= 0) break;
    const { file, original, mutated } = mutationBytes(project, site);
    let result;
    try {
      fs.writeFileSync(file, mutated);
      result = await runTest(options.testCommand, { cwd: project, timeoutMs: Math.min(options.timeoutMs, remaining()) });
      const expected = new Map(sources);
      expected.set(process.platform === 'win32' ? file.toLowerCase() : file, crypto.createHash('sha256').update(mutated).digest('hex'));
      assertSourcesUnchanged(expected);
    } finally {
      fs.writeFileSync(file, original);
    }
    if (!testCompleted(result)) {
      mutation.timedOut += Number(Boolean(result.timedOut));
      mutation.results.push({ file: site.file, line: site.line, status: 'incomplete' });
      break;
    }
    const status = result.exitCode === 0 ? 'survived' : 'killed';
    mutation[status] += 1;
    mutation.untested -= 1;
    mutation.results.push({ file: site.file, line: site.line, status });
  }
  mutation.status = mutation.survived ? 'fail' : mutation.uncovered || mutation.untested ? 'incomplete' : 'pass';
  return mutation;
}

async function runReview(options, { analyze = analyzeProject, runTest = runCommand } = {}) {
  const deadline = Date.now() + options.budgetMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const files = await changedFiles(options, remaining);
  let sandbox;
  try {
    let project = options.project;
    let baseline;
    if (options.testCommand) {
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ub-review-'));
      project = path.join(sandbox, 'project');
      snapshotProject(options.project, project, remaining);
      baseline = await runBaseline(options, project, files, runTest, remaining);
    }
    if (remaining() <= 0) throw new Error('Review budget expired while preparing the source snapshot');
    const report = normalizeReport(await analyze({ project, files, python: options.python, timeoutMs: Math.min(options.timeoutMs, remaining()) }));
    const sites = report.tools.mutator.sites;
    let mutation = { mode: 'scan', status: 'incomplete', killed: 0, survived: 0, uncovered: sites.filter(site => site.covered !== true).length, untested: sites.length, message: 'Mutation inventory only; configure a noninteractive test command for mutation testing' };
    if (report.tools.mutator.status === 'not-applicable') mutation = { ...mutation, status: 'not-applicable', message: 'No applicable mutation sites in the selected source files' };
    else if (report.tools.mutator.status !== 'inventory') mutation = { ...mutation, status: 'incomplete', message: 'Mutation analysis did not complete; inspect the tool report' };
    else if (options.testCommand && remaining() > 0) mutation = await executeMutations(options, project, sites, runTest, remaining, { baseline, files });
    const tools = { ...report.tools, mutator: { ...report.tools.mutator, status: mutation.status, mode: mutation.mode } };
    const acceptable = tool => tool.status === 'pass' || (tool.status === 'not-applicable' && !tool.unsupportedFiles?.length);
    const baselinePassed = !options.testCommand || (testCompleted(baseline) && baseline.exitCode === 0);
    return {
      ok: baselinePassed && acceptable(tools.crapper) && acceptable(tools.dryer) && acceptable(tools.mutator),
      tools, scope: { files }, mutation,
      ...(options.testCommand ? { baseline: { status: baselinePassed ? 'pass' : 'incomplete', exitCode: baseline.exitCode } } : {}),
    };
  } finally {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  try {
    const report = await runReview(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ ok: false, status: 'incomplete', message: 'Review could not complete; inspect project scope, Python tools, test command and snapshot limits' }));
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, runReview };
if (require.main === module) main();
