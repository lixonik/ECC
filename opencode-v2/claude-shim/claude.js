#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toClaudeCalls } from '../lib/tool-translate.js';

export const DEPTH_ENV = 'ECC_CLAUDE_SHIM_DEPTH';
export const MODELS_ENV = 'ECC_CLAUDE_SHIM_MODELS';
export const ALLOWED_ENV = 'ECC_HEADLESS_ALLOWED_TOOLS';
export const DISALLOWED_ENV = 'ECC_HEADLESS_DISALLOWED_TOOLS';

const VALUE_FLAGS = Object.freeze({
  '--model': 'model',
  '--max-turns': 'maxTurns',
  '--output-format': 'outputFormat',
  '--allowedTools': 'allowedTools',
  '--allowed-tools': 'allowedTools',
  '--disallowedTools': 'disallowedTools',
  '--disallowed-tools': 'disallowedTools',
  '--system-prompt': 'systemPrompt',
  '--append-system-prompt': 'appendSystemPrompt',
  '--input-format': 'ignored',
  '--permission-mode': 'ignored',
  '--add-dir': 'ignored',
  '--session-id': 'ignored',
  '--mcp-config': 'ignored',
  '--settings': 'ignored',
  '--fallback-model': 'ignored',
  '--max-budget-usd': 'ignored',
});

export function parseClaudeArgs(argv) {
  const parsed = { print: false, outputFormat: 'text', positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    if (flag === '-p' || flag === '--print') {
      parsed.print = true;
    } else if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = inline ?? argv[++i];
      if (VALUE_FLAGS[flag] !== 'ignored') parsed[VALUE_FLAGS[flag]] = value;
    } else if (flag.startsWith('-') && flag !== '-') {
      continue;
    } else {
      parsed.positionals.push(raw);
    }
  }
  if (parsed.maxTurns !== undefined) parsed.maxTurns = Number(parsed.maxTurns);
  return parsed;
}

export function resolveShimModel(name, models = {}) {
  if (typeof name !== 'string' || !name.trim()) return models.default;
  if (name.includes('/')) return name;
  const tier = ['opus', 'sonnet', 'haiku'].find(candidate => name.toLowerCase().includes(candidate));
  return (tier && models[tier]) ?? models.default;
}

export function composePrompt(parsed, stdinText) {
  const body = parsed.positionals.length > 0 ? parsed.positionals.join(' ') : stdinText;
  const instructions = [parsed.systemPrompt, parsed.appendSystemPrompt].filter(Boolean);
  return instructions.length > 0 ? `${instructions.join('\n\n')}\n\n${body ?? ''}` : body ?? '';
}

export function createEventTranslator({ cwd, model, outputFormat, write }) {
  const state = { sessionID: undefined, steps: 0, cost: 0, input: 0, output: 0, texts: new Map(), lastTextMessage: undefined, initSent: false };
  const env = { projectDir: cwd, shellToolName: () => 'Bash', mcpName: () => null };
  const emit = event => {
    if (outputFormat === 'stream-json') write(`${JSON.stringify({ ...event, session_id: state.sessionID })}\n`);
  };
  const handlers = {
    text: part => {
      if (typeof part.text !== 'string') return;
      state.texts.set(part.messageID, `${state.texts.get(part.messageID) ?? ''}${part.text}`);
      state.lastTextMessage = part.messageID;
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part.text }] } });
    },
    tool_use: part => {
      const toolState = part.state ?? {};
      for (const call of toClaudeCalls(part.tool, toolState.input, env)) {
        emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: part.id, name: call.name, input: call.input }] } });
      }
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: part.id, content: String(toolState.output ?? toolState.error ?? ''), is_error: toolState.status === 'error' }] } });
    },
    step_finish: part => {
      state.steps += 1;
      state.cost += Number(part.cost) || 0;
      state.input += Number(part.tokens?.input) || 0;
      state.output += (Number(part.tokens?.output) || 0) + (Number(part.tokens?.reasoning) || 0);
    },
  };
  return {
    state,
    handle(event) {
      if (!event || typeof event !== 'object') return;
      state.sessionID ??= event.sessionID;
      if (!state.initSent && state.sessionID) {
        state.initSent = true;
        emit({ type: 'system', subtype: 'init', model, cwd });
      }
      handlers[event.type]?.(event.part ?? {});
    },
    finalText() {
      return state.lastTextMessage === undefined ? '' : state.texts.get(state.lastTextMessage) ?? '';
    },
    result({ isError, subtype }) {
      return {
        type: 'result',
        subtype,
        is_error: isError,
        result: this.finalText(),
        num_turns: state.steps,
        session_id: state.sessionID,
        total_cost_usd: state.cost,
        usage: { input_tokens: state.input, output_tokens: state.output },
      };
    },
  };
}

export function runShim({ argv, stdinText, env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr }) {
  const depth = Number(env[DEPTH_ENV] ?? 0);
  if (depth >= 1) {
    stderr.write('claude (ECC OpenCode shim): nested claude calls are not supported\n');
    return Promise.resolve(1);
  }
  const parsed = parseClaudeArgs(argv);
  const prompt = composePrompt(parsed, stdinText);
  if (!prompt.trim()) {
    stderr.write('claude (ECC OpenCode shim): no prompt given (pass it as an argument or on stdin)\n');
    return Promise.resolve(1);
  }
  const models = safeJson(env[MODELS_ENV]) ?? {};
  const model = resolveShimModel(parsed.model, models);
  const bin = env.ECC_OPENCODE_BIN || 'opencode';
  const args = ['run', '--standalone', '--auto', '--format', 'json', ...(model ? ['-m', model] : [])];
  const [command, commandArgs] = /\.(?:m?js|cjs)$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  const translator = createEventTranslator({ cwd, model, outputFormat: parsed.outputFormat, write: text => stdout.write(text) });
  const childEnv = {
    ...env,
    [DEPTH_ENV]: String(depth + 1),
    ECC_HOOKS_ENABLED: 'false',
    PWD: cwd,
    ...(parsed.allowedTools ? { [ALLOWED_ENV]: parsed.allowedTools } : {}),
    ...(parsed.disallowedTools ? { [DISALLOWED_ENV]: parsed.disallowedTools } : {}),
  };
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let stopped = false;
    let errorOutput = '';
    const consume = line => {
      const event = safeJson(line);
      if (!event) return;
      translator.handle(event);
      if (Number.isFinite(parsed.maxTurns) && translator.state.steps >= parsed.maxTurns && !stopped) {
        stopped = true;
        child.kill();
      }
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', chunk => { errorOutput += chunk; });
    child.on('error', error => {
      stderr.write(`claude (ECC OpenCode shim): cannot start OpenCode (${bin}): ${error.message}\n`);
      resolve(1);
    });
    child.on('close', code => {
      if (buffer.trim()) consume(buffer);
      const failed = !stopped && code !== 0;
      if (failed && errorOutput.trim()) stderr.write(errorOutput);
      const subtype = stopped ? 'error_max_turns' : failed ? 'error_during_execution' : 'success';
      const result = translator.result({ isError: stopped || failed, subtype });
      if (parsed.outputFormat === 'json' || parsed.outputFormat === 'stream-json') stdout.write(`${JSON.stringify(result)}\n`);
      else if (result.result) stdout.write(`${result.result}\n`);
      resolve(stopped || failed ? 1 : 0);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function safeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseClaudeArgs(argv);
  const stdinText = parsed.positionals.length > 0 ? '' : await readStdin();
  process.exitCode = await runShim({ argv, stdinText });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
