function hasStem(words, stems) {
  return words.some(word => stems.some(stem => word.startsWith(stem)));
}

function hasRequestedStem(words, stems) {
  return words.some((word, index) => {
    if (!stems.some(stem => word.startsWith(stem))) return false;
    if (['без', 'не'].includes(words[index - 1])) return false;
    const modifier = words[index - 1] ?? '';
    if (words[index - 2] === 'не' && /^(?:дела|выполня|запуска|провод|пиши|писа|добавля|создава|нуж|требу)/.test(modifier)) return false;
    if (words[index + 1] === 'не' && /^(?:нуж|требу)/.test(words[index + 2] ?? '')) return false;
    return true;
  });
}

function accessibilityIntent(has) {
  return has('скринрид', 'screenreader', 'wcag', 'a11y')
    || (has('экранн') && has('диктор', 'читал'))
    || (has('доступн') && has('интерфейс', 'компонент', 'таблиц', 'форм', 'клавиатур', 'aria'));
}

function angularIntent(has, creation, modification, projectStack) {
  if (!projectStack.has('angular') && !has('angular', 'ангуляр')) return false;
  return (creation && has('компонент', 'форм', 'сервис', 'директив'))
    || ((creation || modification) && has('signal', 'сигнал', 'rxjs', 'реактив'));
}

function queryIntent(words, projectStack) {
  const has = (...stems) => hasStem(words, stems);
  const requested = (...stems) => hasRequestedStem(words, stems);
  const creation = requested('созда', 'добав', 'напиш', 'настро', 'подготов', 'сдела', 'реализ');
  const modification = requested('замен', 'перевед', 'перепиш', 'рефактор', 'мигр', 'исправ', 'почин', 'устран', 'refactor');
  const testing = has('тест', 'сценари', 'test');
  const code = has('изменен', 'реализац') || words.some(word => /^код(?:а|е|ом|у)?$/.test(word) || ['diff', 'pull', 'pr'].includes(word));
  const review = requested('проверь', 'провер', 'ревью', 'review', 'оцени', 'аудит');
  return {
    accessibility: accessibilityIntent(has),
    defect: (requested('исправ', 'почин', 'устран') && has('баг', 'ошиб', 'дефект', 'регресс', 'пада', 'сломан', 'сбо', 'failing', 'bug'))
      || (creation && testing && has('регрессион')),
    e2e: testing && (requested('e2e', 'playwright') || (requested('сквозн') && has('браузер', 'интерфейс', 'приложен', 'сценари', 'тест'))),
    commit: has('коммит', 'commit') && has('сообщен', 'описан', 'заголов', 'message'),
    refactor: requested('рефактор', 'refactor') || (modification && has('дублирован') && has('код', 'логик')),
    angular: angularIntent(has, creation, modification, projectStack),
    verification: review && code,
    security: review && has('безопасн', 'уязвим', 'защищен', 'security'),
  };
}

const SKILL_FOR_INTENT = Object.freeze({
  accessibility: 'accessibility',
  defect: 'orch-fix-defect',
  e2e: 'e2e-testing',
  commit: 'conventional-commit-review',
  refactor: 'orch-refine-code',
  angular: 'angular-developer',
  verification: 'verification-loop',
  security: 'security-review',
});

export function russianSkillAliases(query, projectStack = new Set()) {
  if (typeof query !== 'string' || !/\p{Script=Cyrillic}/u.test(query)) return [];
  const words = query.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
  const intents = queryIntent(words, projectStack);
  return Object.entries(SKILL_FOR_INTENT).filter(([intent]) => intents[intent]).map(([, id]) => id);
}
