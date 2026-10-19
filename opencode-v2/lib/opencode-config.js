import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_NAMES = Object.freeze(['opencode.json', 'opencode.jsonc']);

export function globalConfigDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

export function configuredShell(projectDir, env = process.env) {
  const candidates = [
    globalConfigDir(env),
    projectDir,
    projectDir ? path.join(projectDir, '.opencode') : null,
  ].filter(Boolean).flatMap(directory => CONFIG_NAMES.map(name => path.join(directory, name)));
  let shell;
  for (const file of candidates) {
    const config = readJsonc(file);
    if (config && typeof config.shell === 'string' && config.shell.trim()) shell = config.shell.trim();
  }
  return shell;
}

export function shellToolNameFor(shell) {
  if (typeof shell !== 'string' || !shell) return undefined;
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell) ? 'PowerShell' : 'Bash';
}

export function readJsonc(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
}

export function stripJsonc(text) {
  let output = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      output += ch;
      if (ch === '\\') {
        output += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      output += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      output += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      output += ch;
    }
  }
  return output.replace(/,(\s*[}\]])/g, '$1').replace(/^\uFEFF/, '');
}
