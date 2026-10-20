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

function angularProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-oc2-ng-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '^20.0.0', rxjs: '^7.8.0' }, devDependencies: { typescript: '^5.8.0' } }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(dir, 'angular.json'), '{}');
  return dir;
}

async function main() {
  const routing = await load('lib/skill-routing.js');
  const { loadEccSkills } = await load('lib/skills.js');
  const { skills } = loadEccSkills(repoRoot);
  const projectDir = angularProject();
  const results = [];

  try {
    const stack = routing.detectProjectStack(repoRoot, projectDir);
    const catalog = routing.autoCatalog(skills, stack);
    const hidden = new Set(skills.map(skill => skill.id).filter(id => !catalog.includes(id)));
    const router = routing.createSkillRouter(repoRoot, skills, stack);
    const suggest = query => router.suggest(query, { candidates: hidden }).map(skill => skill.id);

    results.push(await test('ECC project detection sees an Angular TypeScript project', () => {
      assert.ok(stack.has('angular') && stack.has('typescript'));
    }));

    results.push(await test('auto catalog describes workflow skills and the project stack only', () => {
      for (const id of routing.CORE_SKILLS) assert.ok(catalog.includes(id), id);
      assert.ok(catalog.includes('angular-developer') && catalog.includes('frontend-patterns'));
      assert.ok(!catalog.includes('django-patterns') && !catalog.includes('kotlin-patterns') && !catalog.includes('react-patterns'));
      assert.ok(catalog.length < 30, `catalog has ${catalog.length} skills`);
    }));

    results.push(await test('skills tied to another stack are never suggested', () => {
      assert.strictEqual(routing.isStackCompatible('fsharp-testing', stack), false);
      assert.strictEqual(routing.isStackCompatible('react-native-patterns', stack), false);
      assert.strictEqual(routing.isStackCompatible('accessibility', stack), true);
      assert.strictEqual(routing.isStackCompatible('django-patterns', new Set()), true, 'unknown stack filters nothing');
      assert.ok(!suggest('Fix the failing unit test and add a regression test').some(id => /^(fsharp|cpp|csharp)-/.test(id)));
    }));

    results.push(await test('suggestions are precise for clear requests', () => {
      assert.deepStrictEqual(suggest('make the table accessible for screen readers'), ['accessibility']);
      assert.ok(suggest('Fix the failing unit test in the multiselect component and add a regression test').includes('orch-fix-defect'));
      assert.ok(suggest('set up e2e tests with playwright').includes('e2e-testing'));
      assert.ok(suggest('write a commit message').includes('conventional-commit-review'));
    }));

    results.push(await test('weak lexical overlap produces no suggestion', () => {
      assert.deepStrictEqual(suggest('Refactor this RxJS service to signals'), []);
      assert.deepStrictEqual(suggest('Создай компонент формы входа'), []);
      assert.deepStrictEqual(suggest(''), []);
    }));

    results.push(await test('suggestion note lists ids with trimmed descriptions', () => {
      const note = routing.suggestionNote([{ id: 'accessibility', description: `${'word '.repeat(80)}end` }]);
      assert.ok(note.startsWith(`<${routing.SUGGESTIONS_TAG}>`) && note.includes('- accessibility: word'));
      assert.ok(note.split('\n')[2].length < 260);
    }));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  const failed = results.filter(ok => !ok).length;
  console.log(`\nPassed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
