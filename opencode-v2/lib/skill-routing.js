import path from 'node:path';
import { createRequire } from 'node:module';

export const CORE_SKILLS = Object.freeze([
  'ecc-guide', 'tdd-workflow', 'verification-loop', 'security-review', 'coding-standards', 'search-first', 'git-workflow',
]);
export const SUGGESTION_LIMIT = 3;
const DENSE_EVIDENCE = 0.35;
const RELATIVE_BM25_FLOOR = 0.5;
const WEAK_TERMS = new Set([
  'this', 'that', 'these', 'those', 'make', 'up', 'add', 'use', 'using', 'new', 'get', 'set', 'js', 'ts', 'all', 'any',
  'some', 'before', 'after', 'into', 'out', 'about', 'can', 'should', 'would', 'will', 'do', 'does', 'need', 'want', 'just',
]);

export function hasRelevanceEvidence(result, topBm25) {
  if (result.exact || result.dense >= DENSE_EVIDENCE) return true;
  const strongTerms = result.matchedTerms.filter(term => !WEAK_TERMS.has(term));
  return strongTerms.length >= 2 && result.bm25 >= RELATIVE_BM25_FLOOR * topBm25;
}
export const SUGGESTIONS_TAG = 'ecc-skill-suggestions';

const FRONTEND = Object.freeze(['angular', 'react', 'vue', 'svelte', 'nextjs', 'nuxt', 'astro', 'remix']);

const STACK_PREFIXES = Object.freeze({
  angular: ['angular'],
  react: ['react', 'nextjs', 'remix'],
  'react-native': ['react'],
  nextjs: ['nextjs', 'react'],
  vue: ['vue', 'nuxt'],
  nuxt4: ['nuxt', 'vue'],
  frontend: FRONTEND,
  nestjs: ['nestjs'],
  bun: ['typescript', 'javascript'],
  vite: ['typescript', 'javascript'],
  python: ['python'],
  django: ['django', 'python'],
  fastapi: ['fastapi', 'python'],
  pytorch: ['python'],
  golang: ['golang'],
  rust: ['rust'],
  cpp: ['c'],
  csharp: ['csharp'],
  dotnet: ['csharp', 'fsharp'],
  fsharp: ['fsharp'],
  java: ['java'],
  springboot: ['spring', 'java'],
  quarkus: ['java'],
  jpa: ['java'],
  mybatis: ['java'],
  kotlin: ['kotlin'],
  android: ['kotlin', 'java'],
  compose: ['kotlin'],
  swift: ['swift'],
  swiftui: ['swift'],
  laravel: ['laravel', 'php'],
  perl: ['perl'],
  rails: ['rails', 'ruby'],
  dart: ['dart', 'flutter'],
  flutter: ['flutter', 'dart'],
});

export function skillStackTags(id) {
  const segments = String(id).split('-');
  return STACK_PREFIXES[`${segments[0]}-${segments[1]}`] ?? STACK_PREFIXES[segments[0]] ?? null;
}

export function isStackCompatible(id, projectStack) {
  const tags = skillStackTags(id);
  if (!tags || projectStack.size === 0) return true;
  return tags.some(tag => projectStack.has(tag));
}

export function detectProjectStack(root, projectDir) {
  try {
    const require = createRequire(path.join(root, 'package.json'));
    const { detectProjectType } = require('./scripts/lib/project-detect.js');
    const { languages, frameworks } = detectProjectType(projectDir);
    return new Set([...languages, ...frameworks]);
  } catch {
    return new Set();
  }
}

export function autoCatalog(skills, projectStack) {
  const ids = new Set(skills.map(skill => skill.id));
  const stackSkills = skills
    .filter(skill => (skillStackTags(skill.id) ?? []).some(tag => projectStack.has(tag)))
    .map(skill => skill.id);
  return [...new Set([...CORE_SKILLS.filter(id => ids.has(id)), ...stackSkills])];
}

export function createSkillRouter(root, skills, projectStack) {
  const require = createRequire(path.join(root, 'package.json'));
  const { buildRetrievalIndex, searchRetrieval } = require('./scripts/lib/context-retrieval.js');
  const byId = new Map(skills.map(skill => [skill.id, skill]));
  const index = buildRetrievalIndex(skills.map(skill => ({ id: `skill:${skill.id}`, name: skill.name, description: skill.description ?? '' })));
  return {
    suggest(query, { candidates, limit = SUGGESTION_LIMIT } = {}) {
      if (typeof query !== 'string' || !query.trim()) return [];
      const results = searchRetrieval(index, query, { limit: 24 });
      const topBm25 = Math.max(0, ...results.map(result => result.bm25));
      return results
        .filter(result => hasRelevanceEvidence(result, topBm25))
        .map(result => result.id.slice('skill:'.length))
        .filter(id => (!candidates || candidates.has(id)) && isStackCompatible(id, projectStack))
        .slice(0, limit)
        .map(id => byId.get(id));
    },
  };
}

export function suggestionNote(skills) {
  const lines = skills.map(skill => `- ${skill.id}: ${truncate(skill.description ?? '', 240)}`);
  return [
    `<${SUGGESTIONS_TAG}>`,
    'ECC skills that may help with this request. Load one with the `skill` tool by id before starting if it fits:',
    ...lines,
    `</${SUGGESTIONS_TAG}>`,
  ].join('\n');
}

function truncate(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}
