export const ALLOWED_ENV = 'ECC_HEADLESS_ALLOWED_TOOLS';
export const DISALLOWED_ENV = 'ECC_HEADLESS_DISALLOWED_TOOLS';

const SHELL_NAMES = new Set(['Bash', 'PowerShell']);
const SHELL_OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')', '{', '}', '$', '`', '#', '@', '*', '?', '[', ']', '!']);
const INVALID_RULE = Object.freeze({ name: null, invalid: true });

export function parseToolRules(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return [];
  const items = splitTopLevel(spec);
  if (!items) return [INVALID_RULE];
  return items.map(item => {
    const match = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(item.trim());
    if (!match) return INVALID_RULE;
    const [, name, pattern] = match;
    if (pattern === undefined) return { name };
    const command = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern;
    if (!command.trim()) return INVALID_RULE;
    return pattern.endsWith(':*') ? { name, prefix: command } : { name, exact: command };
  });
}

function splitTopLevel(spec) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return null;
    if ((ch === ',' || ch === ' ') && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (depth !== 0) return null;
  if (current.trim()) items.push(current.trim());
  return items;
}

function sameTool(ruleName, callName) {
  return ruleName === callName || (SHELL_NAMES.has(ruleName) && SHELL_NAMES.has(callName));
}

function readQuotedLiteral(source, start, shellName) {
  const quote = source[start];
  let text = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === quote) {
      if (shellName === 'PowerShell' && quote === "'" && source[index + 1] === quote) {
        text += quote;
        index += 1;
      } else {
        return { text, end: index };
      }
    } else if (quote === '"' && ch === '\\' && shellName !== 'PowerShell' && ['"', '\\', '$', '`'].includes(source[index + 1])) {
      text += source[index + 1];
      index += 1;
    } else if (quote === '"' && (ch === '$' || ch === '`')) {
      return null;
    } else {
      text += ch;
    }
  }
  return null;
}

function literalShellWords(source, shellName) {
  if (typeof source !== 'string' || [...source].some(ch => {
    const code = ch.codePointAt(0);
    return (code < 32 && code !== 9) || code === 127
      || (shellName === 'PowerShell' && ['\u2018', '\u2019', '\u201c', '\u201d'].includes(ch));
  })) return null;
  const words = [];
  let word = '';
  let started = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (ch === '"' || ch === "'") {
      const quoted = readQuotedLiteral(source, index, shellName);
      if (!quoted) return null;
      word += quoted.text;
      started = true;
      index = quoted.end;
    } else if (ch === '\\' && shellName !== 'PowerShell') {
      if (index + 1 >= source.length) return null;
      word += source[++index];
      started = true;
    } else if (SHELL_OPERATORS.has(ch) || /\s/u.test(ch)) {
      return null;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  if (shellName === 'PowerShell' && words.includes('--%')) return null;
  return words.length > 0 ? words : null;
}

function commandPattern(rule) {
  return rule.prefix ?? rule.exact;
}

function shellRuleMatches(rule, words, shellName) {
  const expected = literalShellWords(commandPattern(rule), shellName);
  if (!expected || !words || (rule.exact !== undefined && words.length !== expected.length)) return false;
  return expected.every((word, index) => shellName === 'PowerShell'
    ? word.toLowerCase() === words[index]?.toLowerCase()
    : word === words[index]);
}

function ruleMatches(rule, call, words) {
  if (!sameTool(rule.name, call.name)) return false;
  if (SHELL_NAMES.has(call.name) && commandPattern(rule) !== undefined) return shellRuleMatches(rule, words, call.name);
  const command = typeof call.input?.command === 'string' ? call.input.command.trim() : '';
  if (rule.prefix !== undefined) return command === rule.prefix || command.startsWith(`${rule.prefix} `);
  if (rule.exact !== undefined) return command === rule.exact;
  return true;
}

export function createHeadlessGuard(env = process.env) {
  const allow = parseToolRules(env[ALLOWED_ENV]);
  const deny = parseToolRules(env[DISALLOWED_ENV]);
  if (allow.length === 0 && deny.length === 0) return null;
  const invalid = [...allow, ...deny].some(rule => rule.invalid);
  return {
    allow,
    deny,
    allows(call) {
      if (invalid) return false;
      let words;
      if (SHELL_NAMES.has(call.name)) {
        const scoped = [...allow, ...deny].filter(rule => sameTool(rule.name, call.name) && commandPattern(rule) !== undefined);
        if (scoped.length > 0) {
          words = literalShellWords(call.input?.command, call.name);
          if (!words || scoped.some(rule => !literalShellWords(commandPattern(rule), call.name))) return false;
        }
      }
      if (deny.some(rule => ruleMatches(rule, call, words))) return false;
      return allow.length === 0 || allow.some(rule => ruleMatches(rule, call, words));
    },
    describe() {
      if (invalid) return 'invalid tool rules; all tools denied';
      return allow.map(rule => rule.prefix !== undefined ? `${rule.name}(${rule.prefix}:*)` : rule.name).join(', ') || 'all but the denied tools';
    },
  };
}
