import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './frontmatter.js';

export function availableRuleSets(root) {
  try {
    return fs.readdirSync(path.join(root, 'rules'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function loadRuleSets(root, sets) {
  const rules = [];
  const missing = [];
  for (const set of sets) {
    const directory = path.join(root, 'rules', set);
    if (!fs.existsSync(directory)) {
      missing.push(set);
      continue;
    }
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.md')).sort()) {
      const { data, body } = splitFrontmatter(fs.readFileSync(path.join(directory, file), 'utf8'));
      const paths = Array.isArray(data.paths) ? data.paths.map(String) : [];
      rules.push({ id: `${set}/${path.basename(file, '.md')}`, paths, matchers: paths.map(globToRegExp), content: body.trim() });
    }
  }
  return { rules, missing };
}

export function globToRegExp(glob) {
  let source = '';
  const pattern = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        source += '\\{';
        continue;
      }
      source += `(?:${pattern.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
      i = end;
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text) {
  return text.replace(/[.+^$()|[\]\\/]/g, '\\$&');
}

export function createRuleTracker(rules, projectDir) {
  const always = rules.filter(rule => rule.paths.length === 0);
  const scoped = rules.filter(rule => rule.paths.length > 0);
  const activeBySession = new Map();

  const candidatesFor = filePath => {
    const absolute = path.resolve(projectDir, filePath).replace(/\\/g, '/');
    const relative = path.relative(projectDir, path.resolve(projectDir, filePath)).replace(/\\/g, '/');
    return [relative, absolute];
  };

  return {
    touch(sessionID, filePaths) {
      const active = activeBySession.get(sessionID) ?? new Set();
      activeBySession.set(sessionID, active);
      const activated = [];
      for (const filePath of filePaths) {
        const candidates = candidatesFor(filePath);
        for (const rule of scoped) {
          if (active.has(rule.id)) continue;
          if (rule.matchers.some(matcher => candidates.some(candidate => matcher.test(candidate)))) {
            active.add(rule.id);
            activated.push(rule.id);
          }
        }
      }
      return activated;
    },
    textFor(sessionID) {
      const active = activeBySession.get(sessionID) ?? new Set();
      const applied = [...always, ...scoped.filter(rule => active.has(rule.id))];
      if (applied.length === 0) return null;
      return [
        'ECC rules that apply to this work (follow them unless the user says otherwise):',
        ...applied.map(rule => `<rule id="${rule.id}">\n${rule.content}\n</rule>`),
      ].join('\n\n');
    },
  };
}
