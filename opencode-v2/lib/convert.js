import { splitFrontmatter, stringifyFrontmatter } from './frontmatter.js';

export const CLAUDE_TOOL_ACTIONS = Object.freeze({
  Bash: 'shell',
  PowerShell: 'shell',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Task: 'subagent',
  Agent: 'subagent',
  AskUserQuestion: 'question',
});

export const GATED_ACTIONS = Object.freeze(['shell', 'edit', 'read', 'grep', 'glob', 'webfetch', 'websearch', 'subagent', 'question']);

export const BUILTIN_AGENT_IDS = Object.freeze(['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary']);
export const BUILTIN_COMMAND_NAMES = Object.freeze(['init', 'review']);

const NAMED_COLORS = Object.freeze({
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#6b7280',
  grey: '#6b7280',
});

const MODEL_TIERS = Object.freeze(['opus', 'sonnet', 'haiku']);

export function parseToolList(value) {
  if (value === undefined || value === null) return null;
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => String(item).trim()).filter(Boolean);
}

export function deniedActionsFor(tools) {
  if (tools === null) return [];
  const granted = new Set(tools.map(tool => CLAUDE_TOOL_ACTIONS[tool]).filter(Boolean));
  return GATED_ACTIONS.filter(action => !granted.has(action));
}

export function resolveModel(model, modelMap = {}) {
  if (typeof model !== 'string' || model.trim() === '' || model === 'inherit') return undefined;
  const tier = model.trim().toLowerCase();
  if (Object.hasOwn(modelMap, tier)) return modelMap[tier];
  if (MODEL_TIERS.includes(tier)) return undefined;
  return model.includes('/') ? model : undefined;
}

export function resolveColor(color) {
  if (typeof color !== 'string') return undefined;
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return NAMED_COLORS[value.toLowerCase()];
}

export function stripNamespace(id) {
  return String(id).trim().replace(/^(?:ecc|everything-claude-code):/, '');
}

export function convertAgent(source, options = {}) {
  const { data, body, present } = splitFrontmatter(source);
  if (!present) throw new Error('Agent file has no frontmatter');
  const tools = parseToolList(data.tools);
  const permissions = deniedActionsFor(tools).map(action => ({ action, resource: '*', effect: 'deny' }));
  const frontmatter = {
    description: typeof data.description === 'string' ? data.description : undefined,
    mode: 'subagent',
    model: resolveModel(data.model, options.modelMap),
    color: resolveColor(data.color),
    permissions: permissions.length > 0 ? permissions : undefined,
  };
  return stringifyFrontmatter(frontmatter) + normalizeBody(body);
}

export function convertCommand(source, options = {}) {
  const { data, body } = splitFrontmatter(source);
  const hint = typeof data['argument-hint'] === 'string' ? data['argument-hint'].trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const agent = typeof data.agent === 'string' ? stripNamespace(data.agent) : undefined;
  const subagent = data.subagent === true || data.subtask === true || data.context === 'fork' ? true : undefined;
  const frontmatter = {
    description: [description, hint ? `Arguments: ${hint}` : ''].filter(Boolean).join(' ') || undefined,
    agent,
    model: resolveModel(data.model, options.modelMap),
    subagent,
  };
  return stringifyFrontmatter(frontmatter) + normalizeBody(body);
}

function normalizeBody(body) {
  const trimmed = body.replace(/^(?:\r?\n)+/, '');
  return `\n${trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`}`;
}
