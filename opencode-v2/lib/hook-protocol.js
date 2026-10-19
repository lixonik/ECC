export const TOOL_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export const PLAIN_STDOUT_CONTEXT_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit']);
export const BLOCKING_EXIT_CODE = 2;

export function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && ['"', '\\', '$', '`'].includes(command[i + 1])) {
        current += command[i + 1];
        i += 1;
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      started = true;
      i += 1;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in hook command`);
  if (started) tokens.push(current);
  return tokens;
}

export function describeHookCommand(argv) {
  const rest = argv[0] === 'node' && argv[1] === '-e' ? argv.slice(3) : argv.slice(1);
  const flagsRunner = rest.findIndex(token => /(?:^|[\\/])run-with-flags\.js$/.test(token));
  if (flagsRunner !== -1 && rest[flagsRunner + 1]) {
    return { hookId: rest[flagsRunner + 1], profiles: rest[flagsRunner + 3] ?? null };
  }
  if (rest.length >= 3 && rest[0].includes(':') && /\.js$/.test(rest[1])) {
    return { hookId: rest[0], profiles: rest[2] ?? null };
  }
  return { hookId: null, profiles: null };
}

export function createMatcher(matcher) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return () => true;
  const pattern = String(matcher);
  if (/^[A-Za-z0-9_|]+$/.test(pattern)) {
    const names = new Set(pattern.split('|').filter(Boolean));
    return name => names.has(name);
  }
  let expression;
  try {
    expression = new RegExp(pattern);
  } catch {
    return () => false;
  }
  return name => expression.test(String(name ?? ''));
}

export function interpretHookResult(eventName, result) {
  const outcome = emptyOutcome();
  const stderr = (result.stderr ?? '').trim();
  const stdout = (result.stdout ?? '').trim();
  if (result.error) {
    outcome.diagnostics.push(`failed to start: ${result.error}`);
    return outcome;
  }
  if (result.timedOut) {
    outcome.diagnostics.push('timed out');
    return outcome;
  }
  if (result.exitCode === BLOCKING_EXIT_CODE) {
    outcome.block = true;
    outcome.reason = stderr || 'Blocked by ECC hook';
    return outcome;
  }
  if (result.exitCode !== 0) {
    outcome.diagnostics.push(`exited with ${result.exitCode}${stderr ? `: ${stderr}` : ''}`);
    return outcome;
  }
  if (stderr) outcome.notices.push(stderr);
  if (!stdout) return outcome;
  const json = parseJsonObject(stdout);
  if (!json) {
    if (PLAIN_STDOUT_CONTEXT_EVENTS.includes(eventName)) outcome.context.push(stdout);
    return outcome;
  }
  applyJsonOutput(outcome, json);
  return outcome;
}

function applyJsonOutput(outcome, json) {
  if (json.continue === false) {
    outcome.stop = true;
    outcome.stopReason = stringOrEmpty(json.stopReason);
  }
  if (json.decision === 'block') {
    outcome.block = true;
    outcome.reason = stringOrEmpty(json.reason) || 'Blocked by ECC hook';
  } else if (json.decision === 'approve') {
    outcome.permission = 'allow';
    outcome.permissionReason = stringOrEmpty(json.reason);
  }
  if (typeof json.systemMessage === 'string' && json.systemMessage.trim()) outcome.notices.push(json.systemMessage.trim());
  const specific = json.hookSpecificOutput;
  if (!specific || typeof specific !== 'object') return;
  if (['allow', 'deny', 'ask'].includes(specific.permissionDecision)) {
    outcome.permission = specific.permissionDecision;
    outcome.permissionReason = stringOrEmpty(specific.permissionDecisionReason);
  }
  if (specific.decision && typeof specific.decision === 'object' && specific.decision.behavior === 'deny') {
    outcome.permission = 'deny';
    outcome.permissionReason = stringOrEmpty(specific.decision.message);
  }
  if (specific.updatedInput && typeof specific.updatedInput === 'object') outcome.updatedInput = specific.updatedInput;
  if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
    outcome.context.push(specific.additionalContext.trim());
  }
}

export function mergeOutcomes(outcomes) {
  const merged = emptyOutcome();
  for (const outcome of outcomes) {
    if (outcome.block) {
      merged.block = true;
      merged.reason = [merged.reason, outcome.reason].filter(Boolean).join('\n');
    }
    if (outcome.stop) {
      merged.stop = true;
      merged.stopReason = [merged.stopReason, outcome.stopReason].filter(Boolean).join('\n');
    }
    merged.permission = strongerPermission(merged.permission, outcome.permission);
    if (outcome.permission && outcome.permission === merged.permission && outcome.permissionReason) {
      merged.permissionReason = [merged.permissionReason, outcome.permissionReason].filter(Boolean).join('\n');
    }
    if (outcome.updatedInput) merged.updatedInput = { ...(merged.updatedInput ?? {}), ...outcome.updatedInput };
    merged.context.push(...outcome.context);
    merged.notices.push(...outcome.notices);
    merged.diagnostics.push(...outcome.diagnostics);
  }
  return merged;
}

const PERMISSION_STRENGTH = Object.freeze({ allow: 1, ask: 2, deny: 3 });

function strongerPermission(left, right) {
  if (!right) return left;
  if (!left) return right;
  return PERMISSION_STRENGTH[right] > PERMISSION_STRENGTH[left] ? right : left;
}

export function emptyOutcome() {
  return {
    block: false,
    reason: '',
    stop: false,
    stopReason: '',
    permission: undefined,
    permissionReason: '',
    updatedInput: undefined,
    context: [],
    notices: [],
    diagnostics: [],
  };
}

function parseJsonObject(text) {
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}
