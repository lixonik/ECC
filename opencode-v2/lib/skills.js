import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './frontmatter.js';

export function loadEccSkills(root) {
  const skillsDir = path.join(root, 'skills');
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const skills = [];
  const skipped = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      skills.push(toSkillInfo(entry.name, file, fs.readFileSync(file, 'utf8')));
    } catch (error) {
      skipped.push({ id: entry.name, reason: error.message });
    }
  }
  return { skills, skipped };
}

export function toSkillInfo(id, file, source) {
  const { data, body, present } = splitFrontmatter(source);
  if (!present) throw new Error('missing frontmatter');
  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
  const autoinvoke = typeof metadata['opencode/autoinvoke'] === 'boolean'
    ? metadata['opencode/autoinvoke']
    : data['disable-model-invocation'] === true ? false : undefined;
  return {
    id,
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id,
    ...(typeof data.description === 'string' ? { description: data.description } : {}),
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
    path: path.resolve(file),
    content: body,
  };
}
