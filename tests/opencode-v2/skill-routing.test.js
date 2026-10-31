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

    results.push(await test('Russian requests activate precise local workflow aliases', () => {
      const queries = [
        ['Сделай таблицу доступной для скринридеров', 'accessibility'],
        ['Почини падающий unit test и добавь регрессионный тест', 'orch-fix-defect'],
        ['Исправь ошибку обработки данных в компоненте', 'orch-fix-defect'],
        ['Настрой сквозные тесты браузера', 'e2e-testing'],
        ['Напиши сообщение для коммита', 'conventional-commit-review'],
        ['Проведи рефакторинг сервиса без изменения поведения', 'orch-refine-code'],
      ];
      for (const [query, skill] of queries) assert.ok(suggest(query).includes(skill), `${query}: ${suggest(query)}`);
      assert.deepStrictEqual(suggest('Сделай таблицу доступной для скринридеров'), ['accessibility']);
    }));

    results.push(await test('Russian aliases support case, normalized characters and mixed technical vocabulary', () => {
      const queries = [
        ['СДЕЛАЙ ЭЛЕМЕНТЫ ДОСТУПНЫМИ ДЛЯ ЭКРАННОГО ДИКТОРА', 'accessibility'],
        ['Добавь регрессионный ТЕСТ для сломанного обработчика', 'orch-fix-defect'],
        ['Подготовь сообщение коммита по завершённым изменениям', 'conventional-commit-review'],
        ['Подготовь сообщение коммита по завершенным изменениям', 'conventional-commit-review'],
        ['Напиши e2e сценарии на Playwright', 'e2e-testing'],
      ];
      for (const [query, skill] of queries) assert.ok(suggest(query).includes(skill), `${query}: ${suggest(query)}`);
    }));

    results.push(await test('Russian aliases retain stack, candidate and result bounds', () => {
      const compact = new Set(skills.map(skill => skill.id).filter(id => id !== 'ecc-guide'));
      assert.ok(router.suggest('Создай компонент формы входа', { candidates: compact }).some(skill => skill.id === 'angular-developer'));
      assert.ok(router.suggest('Замени RxJS на сигналы в Angular сервисе', { candidates: compact }).some(skill => skill.id === 'angular-developer'));
      assert.deepStrictEqual(suggest('Создай компонент формы входа'), []);
      assert.deepStrictEqual(router.suggest('Сделай интерфейс доступным для экранного диктора', { candidates: new Set() }), []);
      assert.ok(router.suggest('Почини ошибку и напиши сообщение коммита, добавь сквозные тесты', { limit: 1 }).length <= 1);
      const pythonRouter = routing.createSkillRouter(repoRoot, skills, new Set(['python']));
      assert.ok(!pythonRouter.suggest('Создай компонент Angular формы').some(skill => skill.id === 'angular-developer'));
    }));

    results.push(await test('Russian aliases preserve explicit IDs and ignore unavailable skills', () => {
      const compact = new Set(skills.map(skill => skill.id).filter(id => id !== 'ecc-guide'));
      assert.strictEqual(router.suggest('Используй e2e-testing и исправь ошибку', { candidates: compact })[0].id, 'e2e-testing');
      assert.ok(router.suggest('Проведи ревью кода и изменений перед PR', { candidates: compact }).some(skill => skill.id === 'verification-loop'));
      assert.ok(router.suggest('Проверь безопасность обработки данных', { candidates: compact }).some(skill => skill.id === 'security-review'));
      assert.ok(router.suggest('Проверь защищённость обработки данных', { candidates: compact }).some(skill => skill.id === 'security-review'));
      assert.ok(router.suggest('Проверь защище\u0308нность обработки данных', { candidates: compact }).some(skill => skill.id === 'security-review'));
      const minimal = routing.createSkillRouter(repoRoot, skills.filter(skill => skill.id === 'ecc-guide'), stack);
      assert.deepStrictEqual(minimal.suggest('Исправь ошибку и напиши сообщение коммита'), []);
    }));

    results.push(await test('Russian greetings and unrelated prose do not activate workflow aliases', () => {
      for (const query of ['Привет', 'Помоги', 'Сделай красиво', 'Сервис доставки доступен завтра', 'Мы обсудили форму облаков', 'Статья о доступных авиабилетах', 'Проверь кодекс поведения']) {
        assert.deepStrictEqual(suggest(query), [], query);
      }
    }));

    results.push(await test('explicitly excluded workflows are not added as Russian aliases', () => {
      for (const query of ['Исправь ошибку в обработчике без рефакторинга', 'Почини баг, но не делай рефакторинг сервиса']) {
        assert.ok(suggest(query).includes('orch-fix-defect'));
        assert.ok(!suggest(query).includes('orch-refine-code'));
      }
      assert.deepStrictEqual(suggest('Не добавляй e2e тесты'), []);
      assert.deepStrictEqual(router.suggest('Не проводи ревью кода'), []);
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
