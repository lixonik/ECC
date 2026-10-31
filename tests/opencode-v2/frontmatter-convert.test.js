const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
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

function sourceFiles() {
  return [
    ...fs.readdirSync(path.join(repoRoot, 'agents')).filter(f => f.endsWith('.md')).map(f => path.join(repoRoot, 'agents', f)),
    ...fs.readdirSync(path.join(repoRoot, 'commands')).filter(f => f.endsWith('.md')).map(f => path.join(repoRoot, 'commands', f)),
    ...fs.readdirSync(path.join(repoRoot, 'skills'))
      .map(d => path.join(repoRoot, 'skills', d, 'SKILL.md'))
      .filter(f => fs.existsSync(f)),
  ];
}

async function main() {
  const { splitFrontmatter, stringifyFrontmatter } = await load('lib/frontmatter.js');
  const convert = await load('lib/convert.js');
  const results = [];

  results.push(await test('frontmatter parser matches js-yaml on every ECC agent, command and skill', () => {
    const mismatches = [];
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      const raw = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
      if (!raw) continue;
      const expected = yaml.load(raw[1], { schema: yaml.CORE_SCHEMA }) || {};
      const actual = splitFrontmatter(text).data;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(path.relative(repoRoot, file));
    }
    assert.deepStrictEqual(mismatches, []);
  }));

  results.push(await test('frontmatter round-trips the permission list shape', () => {
    const data = {
      description: 'Say "hi": yes',
      mode: 'subagent',
      permissions: [{ action: 'edit', resource: '*', effect: 'deny' }, { action: 'shell', resource: '*', effect: 'deny' }],
    };
    const parsed = splitFrontmatter(`${stringifyFrontmatter(data)}\nbody\n`);
    assert.deepStrictEqual(parsed.data, data);
    assert.strictEqual(parsed.body.trim(), 'body');
    assert.deepStrictEqual(yaml.load(stringifyFrontmatter(data).replace(/^---\n|---\n$/g, '')), data);
  }));

  results.push(await test('read-only planner agent denies shell, edit, web, subagent and question', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'agents', 'planner.md'), 'utf8');
    const { data, body } = splitFrontmatter(convert.convertAgent(source));
    assert.strictEqual(data.mode, 'subagent');
    assert.strictEqual(data.model, undefined);
    const denied = data.permissions.map(rule => rule.action).sort();
    assert.deepStrictEqual(denied, ['edit', 'question', 'shell', 'subagent', 'webfetch', 'websearch']);
    assert.ok(data.permissions.every(rule => rule.effect === 'deny' && rule.resource === '*'));
    assert.ok(body.includes('Prompt Defense Baseline'));
  }));

  results.push(await test('code reviewer conversion retains ub-mode checks and read-only tool permissions', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'agents', 'code-reviewer.md'), 'utf8');
    const original = splitFrontmatter(source);
    assert.ok(convert.parseToolList(original.data.tools).includes('Skill'));
    const { data, body } = splitFrontmatter(convert.convertAgent(source));
    const denied = new Set(data.permissions.map(rule => rule.action));
    assert.ok(denied.has('edit'));
    for (const action of ['read', 'grep', 'glob', 'shell', 'skill']) assert.ok(!denied.has(action), action);
    assert.ok(body.includes('`ub-mode`'));
    assert.ok(body.includes('references/upstream-skill.md'));
    assert.ok(body.includes('scripts/review.js') && body.includes('--project "<project-dir>"'));
    assert.ok(body.includes('--base "<review-base>"') && body.includes('--file "<relative-file>"'));
    assert.ok(body.indexOf('**Load ub-mode**') < body.indexOf('**Gather context**'));
    assert.ok(body.indexOf('**Read surrounding code**') < body.indexOf('**Run ub-mode tools for this scope**'));
    assert.ok(body.includes('committed PR review'));
    assert.ok(body.includes('## Confidence-Based Filtering'));
    assert.ok(body.includes('## Review Checklist'));
    assert.ok(body.includes('## Approval Criteria'));
    assert.ok(body.includes('Do not install or download tools'));
    assert.ok(body.includes('incomplete'));
    assert.ok(body.includes('Do not commit, push'));
  }));

  results.push(await test('ub-mode remains loadable with its local references and runner in a compact skill catalog', async () => {
    const { loadEccSkills, applySkillCatalog } = await load('lib/skills.js');
    const { skills, skipped } = loadEccSkills(repoRoot);
    assert.deepStrictEqual(skipped, []);
    const loaded = skills.find(skill => skill.id === 'ub-mode');
    assert.ok(loaded && loaded.content.includes('references/upstream-skill.md'));
    const directory = path.dirname(loaded.path);
    assert.ok(fs.statSync(path.join(directory, 'references', 'upstream-skill.md')).isFile());
    assert.ok(fs.statSync(path.join(directory, 'scripts', 'review.js')).isFile());
    const compact = applySkillCatalog(skills, 'compact');
    const hidden = compact.skills.find(skill => skill.id === 'ub-mode');
    assert.ok(compact.hidden.includes('ub-mode'));
    assert.strictEqual(hidden.autoinvoke, false);
    assert.strictEqual(hidden.path, loaded.path);
    assert.strictEqual(hidden.content, loaded.content);
  }));

  results.push(await test('agent conversion never grants permissions, only denies', () => {
    for (const file of fs.readdirSync(path.join(repoRoot, 'agents')).filter(f => f.endsWith('.md'))) {
      const { data } = splitFrontmatter(convert.convertAgent(fs.readFileSync(path.join(repoRoot, 'agents', file), 'utf8')));
      for (const rule of data.permissions || []) assert.strictEqual(rule.effect, 'deny', `${file}: ${JSON.stringify(rule)}`);
      assert.ok(!('tools' in data), `${file} must not carry Claude tools`);
    }
  }));

  results.push(await test('model tiers map only through an explicit model map', () => {
    assert.strictEqual(convert.resolveModel('opus'), undefined);
    assert.strictEqual(convert.resolveModel('opus', { opus: 'acme/large' }), 'acme/large');
    assert.strictEqual(convert.resolveModel('inherit', { inherit: 'x/y' }), undefined);
    assert.strictEqual(convert.resolveModel('acme/explicit'), 'acme/explicit');
  }));

  results.push(await test('named agent colors become hex and unknown colors are dropped', () => {
    assert.strictEqual(convert.resolveColor('cyan'), '#06b6d4');
    assert.strictEqual(convert.resolveColor('#ABCDEF'), '#ABCDEF');
    assert.strictEqual(convert.resolveColor('chartreuse'), undefined);
  }));

  results.push(await test('command conversion keeps the template and folds the argument hint', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'commands', 'plan.md'), 'utf8');
    const { data, body } = splitFrontmatter(convert.convertCommand(source));
    assert.ok(data.description.includes('Arguments: [feature description'));
    assert.ok(body.includes('# Plan Command'));
    assert.ok(!('argument-hint' in data));
  }));

  results.push(await test('command agent ids lose the ecc namespace and subtask becomes subagent', () => {
    const converted = convert.convertCommand('---\ndescription: x\nagent: ecc:security-reviewer\nsubtask: true\nmodel: opus\n---\nRun $ARGUMENTS\n');
    const { data, body } = splitFrontmatter(converted);
    assert.strictEqual(data.agent, 'security-reviewer');
    assert.strictEqual(data.subagent, true);
    assert.strictEqual(data.model, undefined);
    assert.ok(body.includes('$ARGUMENTS'));
  }));

  results.push(await test('converted commands never trigger OpenCode shell interpolation by accident', () => {
    const interpolation = /!`([^`]+)`/g;
    for (const file of fs.readdirSync(path.join(repoRoot, 'commands')).filter(f => f.endsWith('.md'))) {
      const source = fs.readFileSync(path.join(repoRoot, 'commands', file), 'utf8');
      const { data } = splitFrontmatter(source);
      if (convert.allowsBash(data['allowed-tools'])) continue;
      assert.deepStrictEqual([...convert.convertCommand(source).matchAll(interpolation)].map(match => match[0]), [], file);
    }
    const kotlin = convert.convertCommand(fs.readFileSync(path.join(repoRoot, 'commands', 'kotlin-review.md'), 'utf8'));
    assert.ok(kotlin.includes('Analyze `!! ` usage'));
  }));

  results.push(await test('intentional interpolation survives only when the command allows Bash', () => {
    const body = 'Status: !`git status`\nInline `!!` and assert_eq!`x`\n';
    assert.strictEqual(convert.guardShellInterpolation(body, ['Bash', 'Read']), 'Status: !`git status`\nInline `!! ` and assert_eq! `x`\n');
    assert.ok(convert.guardShellInterpolation(body, 'Bash(git status:*)').startsWith('Status: !`git status`'));
    assert.ok(convert.guardShellInterpolation(body, ['Read']).startsWith('Status: ! `git status`'));
    assert.ok(!convert.guardShellInterpolation(body, undefined).includes('!`'));
  }));

  results.push(await test('no ECC agent or command collides with OpenCode built-ins', () => {
    const agents = fs.readdirSync(path.join(repoRoot, 'agents')).map(f => path.basename(f, '.md'));
    const commands = fs.readdirSync(path.join(repoRoot, 'commands')).map(f => path.basename(f, '.md'));
    assert.deepStrictEqual(agents.filter(id => convert.BUILTIN_AGENT_IDS.includes(id)), []);
    assert.deepStrictEqual(commands.filter(name => convert.BUILTIN_COMMAND_NAMES.includes(name)), []);
  }));

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
