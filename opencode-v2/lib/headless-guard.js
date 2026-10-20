export const ALLOWED_ENV = 'ECC_HEADLESS_ALLOWED_TOOLS';
export const DISALLOWED_ENV = 'ECC_HEADLESS_DISALLOWED_TOOLS';

const SHELL_NAMES = new Set(['Bash', 'PowerShell']);

export function parseToolRules(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return [];
  return splitTopLevel(spec).map(item => {
    const match = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(item.trim());
    if (!match) return { name: item.trim() };
    const [, name, pattern] = match;
    if (pattern === undefined) return { name };
    return pattern.endsWith(':*') ? { name, prefix: pattern.slice(0, -2) } : { name, exact: pattern };
  }).filter(rule => rule.name);
}

function splitTopLevel(spec) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ' ') && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function sameTool(ruleName, callName) {
  return ruleName === callName || (SHELL_NAMES.has(ruleName) && SHELL_NAMES.has(callName));
}

function ruleMatches(rule, call) {
  if (!sameTool(rule.name, call.name)) return false;
  const command = typeof call.input?.command === 'string' ? call.input.command.trim() : '';
  if (rule.prefix !== undefined) return command === rule.prefix || command.startsWith(`${rule.prefix} `);
  if (rule.exact !== undefined) return command === rule.exact;
  return true;
}

export function createHeadlessGuard(env = process.env) {
  const allow = parseToolRules(env[ALLOWED_ENV]);
  const deny = parseToolRules(env[DISALLOWED_ENV]);
  if (allow.length === 0 && deny.length === 0) return null;
  return {
    allow,
    deny,
    allows(call) {
      if (deny.some(rule => ruleMatches(rule, call))) return false;
      return allow.length === 0 || allow.some(rule => ruleMatches(rule, call));
    },
    describe() {
      return allow.map(rule => rule.prefix !== undefined ? `${rule.name}(${rule.prefix}:*)` : rule.name).join(', ') || 'all but the denied tools';
    },
  };
}
