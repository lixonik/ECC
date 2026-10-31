#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../install.js';
import { messageText, startMockProvider } from './mock-provider.js';

const ECC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_TIMEOUT_MS = 180000;
const SHELL_PROBE = 'node -e "console.log(\'ecc-shell-ok\')"';
const GATEGUARD_OFF = Object.freeze({ ECC_GATEGUARD: 'off', ECC_OPENCODE_DEBUG: process.env.ECC_OPENCODE_DEBUG ?? '' });
const UB_MODE_DIR = path.join(ECC_ROOT, 'skills', 'ub-mode').split(path.sep).join('/');

const SCENARIOS = {
  'shell-ok': {
    prompt: 'Run the smoke shell command.',
    env: GATEGUARD_OFF,
    steps: [
      { tool: 'shell', args: { command: SHELL_PROBE } },
      { text: 'Shell step finished.' },
    ],
    check: ({ requests, transcripts, log, manifestUnchanged }) => {
      expect(requests.some(request => systemOf(request).includes('ECC (Everything Claude Code) is active')), 'ECC note reaches the system prompt');
      expect(toolResults(requests).some(text => text.includes('ecc-shell-ok')), 'shell output reaches the model');
      expect(transcripts.some(line => line.message?.content?.[0]?.type === 'tool_use'), 'transcript mirror records the tool call');
      expect(log.includes('ECC hook bridge active'), 'bridge reports activation in its log');
      expect(log.includes('SessionStart session:start'), 'SessionStart hooks ran');
      expect(requests.some(request => systemOf(request).includes('<id>tdd-workflow</id>')), 'ECC skills are offered to the model');
      expect(manifestUnchanged && !log.includes('auto-sync refreshed'), 'startup auto-sync writes nothing when sources are unchanged');
    },
  },
  'compact-catalog': {
    env: GATEGUARD_OFF,
    install: { skillCatalog: 'compact' },
    prompt: 'Load the TDD skill by id.',
    steps: [
      { tool: 'skill', args: { id: 'tdd-workflow' } },
      { text: 'Compact catalog step finished.' },
    ],
    check: ({ requests }) => {
      const main = requests.find(request => toolNames(request).includes('skill'));
      const system = main ? systemOf(main) : '';
      expect(main && !system.includes('<id>tdd-workflow</id>') && system.includes('<id>ecc-guide</id>'), 'compact catalog describes only ecc-guide');
      expect(system.includes('More ECC skills are installed') && system.includes('tdd-workflow'), 'other skills are listed by id');
      expect(system.length < 60000, `system prompt shrinks (${system.length} characters)`);
      expect(toolResults(requests).some(text => /test-driven|TDD/i.test(text)), 'a skill outside the catalog still loads by id');
    },
  },
  'rules-angular': {
    env: GATEGUARD_OFF,
    install: { rules: ['common', 'angular'] },
    prompt: 'Read the component.',
    files: { 'src/app/user.component.ts': 'export class UserComponent {}\n' },
    steps: [
      { tool: 'read', args: { path: 'src/app/user.component.ts' } },
      { text: 'Rules step finished.' },
    ],
    check: ({ requests }) => {
      const main = requests.filter(request => toolNames(request).length > 0);
      expect(main.length >= 2, 'two main-loop requests were made');
      expect(main[0] && systemOf(main[0]).includes('<rule id="common/coding-style">') && !systemOf(main[0]).includes('<rule id="angular/'), 'common rules apply from the start, Angular rules wait');
      expect(main[1] && systemOf(main[1]).includes('<rule id="angular/coding-style">'), 'reading a component activates the Angular rules');
    },
  },
  'russian-suggestions': {
    env: GATEGUARD_OFF,
    install: { skillCatalog: 'compact' },
    prompt: 'Сделай таблицу доступной для скринридеров',
    steps: [
      { tool: 'skill', args: { id: 'accessibility' } },
      { text: 'Russian suggestion step finished.' },
    ],
    check: ({ requests }) => {
      const main = requests.find(request => toolNames(request).includes('skill'));
      const prompt = main ? userTexts(main).join('\n') : '';
      expect(prompt.includes('Сделай таблицу доступной для скринридеров'), 'Russian request reaches the model unchanged');
      expect(prompt.includes('<ecc-skill-suggestions>') && prompt.includes('- accessibility:'), 'Russian intent selects the accessibility skill');
      expect(main && !systemOf(main).includes('<id>accessibility</id>'), 'the suggested skill is outside the compact catalog');
      expect(toolResults(requests).some(text => /WCAG|accessibility/i.test(text)), 'the Russian suggestion loads through the real skill tool');
    },
  },
  'command-kotlin': {
    env: GATEGUARD_OFF,
    steps: [{ text: 'Kotlin command step finished.' }],
    server: async ({ call, waitForRequests }) => {
      await call('POST', '/api/session/:id/command', { name: 'kotlin-review', text: '[[scenario:command-kotlin]] src/Main.kt' });
      await waitForRequests(requests => requests.some(request => toolNames(request).length > 0));
    },
    check: ({ requests }) => {
      const text = requests.flatMap(userTexts).find(item => item.includes('[[scenario:command-kotlin]]')) ?? '';
      expect(text.includes('Null Safety Review') && text.includes('platform type handling'), '/kotlin-review expands without running its prose as shell');
    },
  },
  'gateguard-flow': {
    prompt: 'Run the smoke shell command under GateGuard.',
    steps: [
      { tool: 'shell', args: { command: SHELL_PROBE } },
      { text: 'Facts: the user asked to run the smoke probe; this command prints a fixed marker to verify the shell works.', tool: 'shell', args: { command: SHELL_PROBE } },
      { text: 'GateGuard step finished.' },
    ],
    check: ({ requests }) => {
      const results = toolResults(requests);
      expect(results.some(text => text.includes('Fact-Forcing Gate')), 'GateGuard gates the first shell call');
      expect(results.some(text => text.includes('ecc-shell-ok')), 'retry after presenting facts runs the command');
    },
  },
  'config-protect': {
    prompt: 'Relax the lint config.',
    env: GATEGUARD_OFF,
    files: { '.eslintrc.json': '{}\n' },
    steps: [
      { tool: 'edit', args: { path: '.eslintrc.json', oldString: '{}', newString: '{"rules":{}}' } },
      { text: 'Edit step finished.' },
    ],
    check: ({ requests, projectDir }) => {
      expect(toolResults(requests).some(text => text.includes('ECC hook blocked this Edit call') && text.includes('Modifying .eslintrc.json is not allowed')), 'config-protection block reaches the model');
      expect(fs.readFileSync(path.join(projectDir, '.eslintrc.json'), 'utf8') === '{}\n', 'protected config stays unchanged');
    },
  },
  'hookify-bash-block': {
    env: GATEGUARD_OFF,
    prompt: 'Run the forbidden command.',
    files: { '.claude/hookify.block-forbidden.local.md': hookifyRule({ name: 'block-forbidden', event: 'bash', pattern: 'ecc-forbidden', action: 'block', message: 'HOOKIFY-BASH-BLOCKED' }) },
    steps: [
      { tool: 'shell', args: { command: 'echo ecc-forbidden' } },
      { text: 'Blocked step finished.' },
    ],
    check: ({ requests }) => {
      expect(toolResults(requests).some(text => text.includes('HOOKIFY-BASH-BLOCKED')), 'hookify bash block reaches the model');
      expect(!toolResults(requests).some(text => /^ecc-forbidden\s*$/m.test(text)), 'blocked command did not run');
    },
  },
  'hookify-prompt-warn': {
    env: GATEGUARD_OFF,
    prompt: 'Please handle ecc-prompt-marker today.',
    files: { '.claude/hookify.warn-prompt.local.md': hookifyRule({ name: 'warn-prompt', event: 'prompt', pattern: 'ecc-prompt-marker', action: 'warn', message: 'HOOKIFY-PROMPT-WARNED' }) },
    steps: [{ text: 'Prompt step finished.' }],
    check: ({ requests }) => {
      expect(requests.some(request => userTexts(request).some(text => text.includes('HOOKIFY-PROMPT-WARNED'))), 'UserPromptSubmit context reaches the model');
    },
  },
  'hookify-file-warn': {
    env: GATEGUARD_OFF,
    prompt: 'Create the debug file.',
    files: { '.claude/hookify.warn-console.local.md': hookifyRule({ name: 'warn-console', event: 'file', pattern: 'console\\.log', action: 'warn', message: 'HOOKIFY-FILE-WARNED' }) },
    steps: [
      { tool: 'write', args: { path: 'debug.js', content: 'console.log("x");\n' } },
      { text: 'Write step finished.' },
    ],
    check: ({ requests, projectDir }) => {
      expect(fs.existsSync(path.join(projectDir, 'debug.js')), 'warned write still happens');
      expect(toolResults(requests).some(text => text.includes('HOOKIFY-FILE-WARNED')), 'hook warning is attached to the tool result');
    },
  },
  'hookify-stop-block': {
    env: GATEGUARD_OFF,
    files: { '.claude/hookify.require-check.local.md': hookifyRule({ name: 'require-check', event: 'stop', pattern: '.*', action: 'block', message: 'HOOKIFY-STOP-BLOCKED' }) },
    steps: [{ text: 'First answer.' }, { text: 'Answer after stop feedback.' }],
    server: async ({ call, waitForRequests }) => {
      await call('POST', '/api/session/:id/prompt', { text: '[[scenario:hookify-stop-block]] Finish quickly.' });
      await waitForRequests(requests => requests.some(request => allTexts(request).some(text => text.includes('HOOKIFY-STOP-BLOCKED'))));
      await call('DELETE', '/api/session/:id');
    },
    check: ({ requests, log }) => {
      expect(requests.some(request => allTexts(request).some(text => text.includes('HOOKIFY-STOP-BLOCKED'))), 'Stop block continues the session with feedback');
      expect(requests.filter(request => allTexts(request).some(text => text.includes('HOOKIFY-STOP-BLOCKED'))).length === 1, 'stop_hook_active prevents a second continuation');
      expect(log.includes('SessionEnd session:end:marker'), 'SessionEnd hooks run when the session is deleted');
    },
  },
  'patch-protect': {
    env: GATEGUARD_OFF,
    model: 'mock/gpt-mock',
    prompt: 'Patch the lint config and add a note.',
    files: { '.eslintrc.json': '{}\n' },
    steps: [
      { tool: 'patch', args: { patchText: ['*** Begin Patch', '*** Update File: .eslintrc.json', '@@', '-{}', '+{"rules":{}}', '*** Add File: NOTE.txt', '+patched', '*** End Patch'].join('\n') } },
      { tool: 'patch', args: { patchText: ['*** Begin Patch', '*** Add File: NOTE.txt', '+patched', '*** End Patch'].join('\n') } },
      { text: 'Patch step finished.' },
    ],
    check: ({ requests, projectDir, transcripts }) => {
      expect(requests.some(request => toolNames(request).includes('patch')), 'gpt-style model receives the patch tool');
      expect(toolResults(requests).some(text => text.includes('ECC hook blocked this MultiEdit call') && text.includes('Modifying .eslintrc.json is not allowed')), 'patch update is checked as MultiEdit and blocked');
      expect(fs.readFileSync(path.join(projectDir, '.eslintrc.json'), 'utf8') === '{}\n', 'blocked patch leaves the protected config unchanged');
      expect(fs.existsSync(path.join(projectDir, 'NOTE.txt')), 'allowed patch applies');
      expect(transcripts.some(line => line.message?.content?.[0]?.name === 'Write' && String(line.message.content[0].input?.file_path).endsWith('NOTE.txt')), 'patch add is mirrored as Write');
    },
  },
  'compact': {
    env: GATEGUARD_OFF,
    steps: [{ text: 'First answer.' }, { text: 'Summary: the user asked for a smoke answer.' }, { text: 'After compaction.' }],
    server: async ({ call, waitIdle }) => {
      await call('POST', '/api/session/:id/prompt', { text: '[[scenario:compact]] Say something.' });
      await waitIdle();
      await call('POST', '/api/session/:id/compact', {});
      await waitIdle();
    },
    check: ({ log, transcripts }) => {
      expect(log.includes('PreCompact pre:compact'), 'PreCompact hooks run before compaction');
      expect(transcripts.some(line => line.subtype === 'compact_boundary'), 'transcript mirror records the compaction boundary');
      expect((log.match(/SessionStart session:start/g) ?? []).length >= 2, 'SessionStart re-runs with source compact');
    },
  },
  'subagent-planner': {
    env: GATEGUARD_OFF,
    prompt: 'Delegate planning.',
    steps: [
      { tool: 'subagent', args: { agent: 'planner', description: 'Plan the change', prompt: '[[scenario:child-plan]] Plan a tiny change.' } },
      { text: 'Parent step finished.' },
    ],
    check: ({ requests }) => {
      const child = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:child-plan]]')));
      expect(child, 'planner subagent receives its prompt');
      expect(child && systemOf(child).includes('Prompt Defense Baseline'), 'planner system prompt comes from the ECC agent');
      const tools = child ? toolNames(child) : [];
      expect(child && !tools.includes('shell') && !tools.includes('edit') && !tools.includes('write'), `planner is read-only (tools: ${tools.join(', ')})`);
      expect(toolResults(requests).some(text => text.includes('PLAN-OK')), 'subagent result returns to the parent');
    },
  },
  'tier-variant': {
    env: GATEGUARD_OFF,
    install: { modelMap: { opus: 'mock/scripted#max', haiku: 'mock/scripted#fast' } },
    prompt: 'Delegate planning to the deep-thinking planner.',
    steps: [
      { tool: 'subagent', args: { agent: 'planner', description: 'Plan deeply', prompt: '[[scenario:child-plan]] Plan with maximum reasoning.' } },
      { text: 'Tier step finished.' },
    ],
    check: ({ requests }) => {
      const child = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:child-plan]]')));
      const parent = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:tier-variant]]')));
      expect(child && child.body.reasoning_effort === 'max' && child.body.thinking?.type === 'enabled', 'opus-tier ECC agent runs with the max reasoning variant');
      expect(parent && parent.body.reasoning_effort === undefined, 'the main agent keeps the session model settings');
    },
  },
  'variant-inherit': {
    env: GATEGUARD_OFF,
    model: 'mock/scripted#max',
    prompt: 'Delegate planning while the session runs a reasoning variant.',
    steps: [
      { tool: 'subagent', args: { agent: 'planner', description: 'Plan', prompt: '[[scenario:child-plan]] Plan under the session variant.' } },
      { text: 'Inherit step finished.' },
    ],
    check: ({ requests }) => {
      const parent = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:variant-inherit]]')));
      const child = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:child-plan]]')));
      expect(parent && parent.body.reasoning_effort === 'max', 'the session runs with the selected variant');
      expect(child && child.body.reasoning_effort === 'max', `an ECC subagent without a tier map inherits the session variant (got ${child?.body?.reasoning_effort ?? 'none'})`);
    },
  },
  'review-gate': {
    env: GATEGUARD_OFF,
    install: { reviewGate: true },
    steps: [
      { tool: 'write', args: { path: 'feature.ts', content: 'export const answer = 42;\n' } },
      { text: 'Feature written.' },
      { tool: 'subagent', args: { agent: 'code-reviewer', description: 'Review changes', prompt: '[[scenario:child-review]] Review feature.ts' } },
      { text: 'Review addressed.' },
    ],
    server: async ({ call, waitForRequests }) => {
      await call('POST', '/api/session/:id/prompt', { text: '[[scenario:review-gate]] Add the feature.' });
      await waitForRequests(requests => requests.some(request => toolResults([request]).some(text => text.includes('REVIEW-OK'))));
    },
    check: ({ requests }) => {
      const gateRequests = requests.filter(request => allTexts(request).some(text => text.includes('Review gate: you changed 1 file(s)')));
      expect(gateRequests.length > 0 && allTexts(gateRequests[0]).some(text => text.includes('- feature.ts')), 'review gate names the changed file');
      const child = requests.find(request => userTexts(request).some(text => text.includes('[[scenario:child-review]]')));
      expect(child && systemOf(child).includes('code review'), 'the code-reviewer subagent runs');
      const last = requests[requests.length - 1];
      expect(allTexts(last).filter(text => text.includes('Review gate:')).length === 1, 'the gate fires only once in the turn');
    },
  },
  'reviewer-ub-mode': {
    env: GATEGUARD_OFF,
    install: { skillCatalog: 'compact' },
    prompt: 'Delegate a review of feature.ts and preserve verification gaps.',
    files: { 'feature.ts': 'export const reviewed = true;\n' },
    steps: [
      { tool: 'subagent', args: { agent: 'code-reviewer', description: 'Review with ub-mode', prompt: '[[scenario:child-ub-review]] Review feature.ts with ub-mode and report unavailable local quality tools as an incomplete gate.' } },
      { text: 'The reviewer reported its verification gap.' },
    ],
    check: ({ requests, projectDir }) => {
      const children = requests.filter(request => userTexts(request).some(text => text.includes('[[scenario:child-ub-review]]')));
      const child = children[0];
      const tools = child ? toolNames(child) : [];
      const results = toolResults(children);
      expect(child && systemOf(child).includes('Load ub-mode') && systemOf(child).includes('scripts/review.js') && systemOf(child).includes('Security (CRITICAL)'), 'the reviewer receives ub-mode instructions alongside the existing security checklist');
      expect(tools.includes('skill') && tools.includes('read') && tools.includes('shell') && !tools.some(name => ['edit', 'write', 'patch'].includes(name)), 'the reviewer can load skills and run local tools while source editing stays disabled');
      expect(child && !systemOf(child).includes('<id>ub-mode</id>'), 'ub-mode remains loadable outside the compact catalog');
      expect(results.some(text => text.includes('# ub-mode for ECC Review')), 'the reviewer loads the actual ub-mode skill');
      expect(results.some(text => text.includes('# First Make it Work') && text.includes('Use the crapper tool')), 'the reviewer reads the pinned upstream principles');
      expect(results.some(text => /"ok"\s*:\s*false/.test(text) && /"status"\s*:\s*"incomplete"/.test(text)), 'the actual runner reports unavailable tooling as an incomplete gate');
      expect(toolResults(requests).some(text => text.includes('UB-REVIEW-INCOMPLETE')), 'the reviewer returns the verification gap to the parent');
      expect(fs.readFileSync(path.join(projectDir, 'feature.ts'), 'utf8') === 'export const reviewed = true;\n', 'the review preserves the target source');
    },
  },
  'claude-shim': {
    env: GATEGUARD_OFF,
    install: { claudeShim: true },
    model: 'mock/scripted#max',
    prompt: 'Ask the claude CLI for a one-line answer.',
    steps: [
      { tool: 'shell', args: { command: 'claude -p "[[scenario:shim-inner]] Reply with the marker" --allowedTools Read' } },
      { text: 'Shim step finished.' },
    ],
    check: ({ requests }) => {
      expect(toolResults(requests).some(text => text.includes('SHIM-INNER-OK')), 'claude -p inside OpenCode answers through the shim');
      const inner = requests.filter(request => userTexts(request).some(text => text.includes('[[scenario:shim-inner]]')));
      expect(inner.length > 0, 'the shim runs a nested OpenCode session against the same model');
      expect(inner.some(request => toolResults([request]).some(text => text.includes('is not allowed in this headless run'))), '--allowedTools Read blocks the nested shell call');
      expect(inner.length > 0 && inner.every(request => request.body.reasoning_effort === 'max'), 'the nested run inherits the session reasoning variant');
    },
  },
  'claude-shim-compound': {
    env: GATEGUARD_OFF,
    install: { claudeShim: true },
    prompt: 'Check the restricted claude CLI shell.',
    steps: [
      { tool: 'shell', args: { command: 'claude -p "[[scenario:shim-compound-inner]] Run the shell probes" --allowedTools "Bash(echo:*)"' } },
      { text: 'Restricted shim step finished.' },
    ],
    check: ({ requests }) => {
      const inner = requests.filter(request => userTexts(request).some(text => text.includes('[[scenario:shim-compound-inner]]')));
      const results = toolResults(inner);
      expect(results.some(text => text.includes('is not allowed in this headless run')), 'the shim rejects compound commands under a prefix allow rule');
      expect(results.some(text => /^ecc-allowed\s*$/m.test(text)), 'the shim still runs a permitted literal command');
      expect(!results.some(text => /^ecc-unexpected\s*$/m.test(text)), 'the rejected second command never executes');
      expect(toolResults(requests).some(text => text.includes('SHIM-COMPOUND-OK')), 'the restricted shim returns its final answer');
    },
  },
  'skill-load': {
    env: GATEGUARD_OFF,
    prompt: 'Load the TDD skill.',
    steps: [
      { tool: 'skill', args: { id: 'tdd-workflow' } },
      { text: 'Skill step finished.' },
    ],
    check: ({ requests }) => {
      expect(toolResults(requests).some(text => /test-driven|TDD/i.test(text)), 'ECC skill content loads through the skill tool');
    },
  },
  'command-plan': {
    env: GATEGUARD_OFF,
    steps: [{ text: 'Command step finished.' }],
    server: async ({ call, waitForRequests }) => {
      await call('POST', '/api/session/:id/command', { name: 'plan', text: '[[scenario:command-plan]] add a login form' });
      await waitForRequests(requests => requests.some(request => toolNames(request).length > 0));
    },
    check: ({ requests }) => {
      expect(requests.some(request => userTexts(request).some(text => text.includes('# Plan Command') && text.includes('add a login form'))), 'ECC /plan command template expands with arguments');
    },
  },
};

const CHILD_SCENARIOS = {
  'child-plan': [{ text: 'PLAN-OK' }],
  'child-review': [{ text: 'REVIEW-OK: no CRITICAL or HIGH issues.' }],
  'child-ub-review': [
    { tool: 'skill', args: { id: 'ub-mode' } },
    { tool: 'read', args: { path: `${UB_MODE_DIR}/references/upstream-skill.md` } },
    { tool: 'shell', args: { command: `node "${UB_MODE_DIR}/scripts/review.js" --project . --file feature.ts --python ./.ecc-smoke/no-python` } },
    { text: 'UB-REVIEW-INCOMPLETE: local quality tools were unavailable; the quality gate did not pass.' },
  ],
  'shim-inner': [{ tool: 'shell', args: { command: 'echo should-be-blocked' } }, { text: 'SHIM-INNER-OK' }],
  'shim-compound-inner': [
    { tool: 'shell', args: { command: 'echo ecc-allowed; echo ecc-unexpected' } },
    { tool: 'shell', args: { command: 'echo ecc-allowed' } },
    { text: 'SHIM-COMPOUND-OK' },
  ],
};

const failures = [];

function expect(condition, label) {
  if (!condition) failures.push(label);
  console.log(`    ${condition ? 'ok  ' : 'FAIL'} ${label}`);
}

function hookifyRule({ name, event, pattern, action, message }) {
  return `---\nname: ${name}\nenabled: true\nevent: ${event}\naction: ${action}\npattern: ${JSON.stringify(pattern)}\n---\n\n${message}\n`;
}

function messagesOf(request) {
  return Array.isArray(request.body?.messages) ? request.body.messages : [];
}

function systemOf(request) {
  return messagesOf(request).filter(message => message.role === 'system').map(messageText).join('\n');
}

function userTexts(request) {
  return messagesOf(request).filter(message => message.role === 'user').map(messageText);
}

function allTexts(request) {
  return messagesOf(request).map(messageText);
}

function toolResults(requests) {
  return requests.flatMap(request => messagesOf(request).filter(message => message.role === 'tool').map(messageText));
}

function toolNames(request) {
  return (request.body?.tools ?? []).map(tool => tool.function?.name ?? tool.name);
}


function parseArgs(argv) {
  const options = { only: null, keep: false, bin: process.env.OPENCODE_BIN ?? 'opencode' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') options.only = argv[++i].split(',');
    else if (argv[i] === '--keep') options.keep = true;
    else if (argv[i] === '--opencode') options.bin = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  return options;
}

function runOpencode(bin, args, { cwd, env }) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runServerScenario(bin, scenario, { cwd, env, provider, before }) {
  const port = await freePort();
  const server = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitUntil(() => /server listening/i.test(output), 60000);
    const password = /server password (\S+)/.exec(output)?.[1];
    const authorization = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {};
    const request = async (method, route, body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { ...authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`);
      const parsed = text ? JSON.parse(text) : null;
      return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
    };
    const session = await request('POST', '/api/session', { location: { directory: cwd } });
    const call = (method, route, body) => request(method, route.replace(':id', encodeURIComponent(session.id)), body);
    const waitForRequests = predicate => waitUntil(() => predicate(provider.requests.slice(before).filter(item => item.path?.includes('/chat/completions'))), 60000);
    const waitIdle = () => call('POST', '/api/experimental/session/:id/wait');
    await scenario.server({ call, waitForRequests, waitIdle });
    await new Promise(resolve => setTimeout(resolve, 4000));
    return { code: 0, stdout: output, stderr: '' };
  } catch (error) {
    return { code: 1, stdout: output, stderr: String(error.stack ?? error) };
  } finally {
    server.kill();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

function readJsonLines(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-v2-smoke-'));
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'projects'].map(name => [name, path.join(sandbox, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const scenarioSteps = { ...Object.fromEntries(Object.entries(SCENARIOS).map(([name, scenario]) => [name, scenario.steps])), ...CHILD_SCENARIOS };
  const provider = await startMockProvider(scenarioSteps);
  const configDir = path.join(dirs.config, 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'opencode.json'), `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/scripted',
    update: 'disable',
    share: 'disabled',
    snapshots: false,
    providers: {
      mock: {
        name: 'Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: provider.baseURL, apiKey: 'mock' },
        models: {
          scripted: {
            name: 'Scripted',
            capabilities: { tools: true },
            limit: { context: 200000, output: 8000 },
            variants: [{ id: 'fast', body: { thinking: { type: 'disabled' } } }, { id: 'max', body: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } }],
          },
          'gpt-mock': { name: 'Scripted GPT', capabilities: { tools: true }, limit: { context: 200000, output: 8000 } },
        },
      },
    },
  }, null, 2)}\n`);

  const baseInstall = { action: 'install', scope: 'global', configDir, hooks: true, skills: true, context: true, force: false, dryRun: false, disabledHooks: [], modelMap: {}, shell: 'Bash' };
  const installWith = extra => install({ ...baseInstall, ...extra }, { root: ECC_ROOT, log: () => {} });
  const manifestFile = path.join(configDir, 'ecc-opencode-v2.install.json');
  installWith({});

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ECC_|CLAUDE)/i.test(key))),
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    OPENCODE_TEST_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
  };
  delete env.OPENCODE_CONFIG_DIR;

  const selected = Object.entries(SCENARIOS).filter(([name]) => !options.only || options.only.includes(name));
  for (const [name, scenario] of selected) {
    console.log(`\n[${name}]`);
    const projectDir = path.join(dirs.projects, name);
    fs.mkdirSync(projectDir, { recursive: true });
    for (const [relative, content] of Object.entries(scenario.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(projectDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, relative), content);
    }
    if (scenario.install) installWith(scenario.install);
    const manifestBefore = fs.statSync(manifestFile).mtimeMs;
    const before = provider.requests.length;
    const stateDir = path.join(dirs.state, 'ecc-opencode');
    const logFile = path.join(stateDir, 'ecc-opencode.log');
    const logOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const runEnv = { ...env, ...(scenario.env ?? {}), PWD: projectDir };
    const result = scenario.server
      ? await runServerScenario(options.bin, scenario, { cwd: projectDir, env: runEnv, provider, before })
      : await runOpencode(options.bin, ['run', '--standalone', '--auto', '--format', 'json', '-m', scenario.model ?? 'mock/scripted', `[[scenario:${name}]] ${scenario.prompt}`], { cwd: projectDir, env: runEnv });
    const requests = provider.requests.slice(before).filter(request => request.path?.includes('/chat/completions'));
    fs.writeFileSync(path.join(sandbox, `${name}.requests.json`), JSON.stringify(requests, null, 2));
    fs.writeFileSync(path.join(sandbox, `${name}.output.txt`), `${result.stdout}\n--- stderr ---\n${result.stderr}`);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(logOffset) : '';
    console.log(`    exit ${result.code}, ${requests.length} model requests`);
    if (result.code !== 0) console.log(result.stderr.split('\n').slice(-15).map(line => `      ${line}`).join('\n'));
    const manifestUnchanged = fs.statSync(manifestFile).mtimeMs === manifestBefore;
    if (scenario.install) installWith({});
    scenario.check({ requests, transcripts: readJsonLines(path.join(stateDir, 'transcripts')), log, projectDir, result, manifestUnchanged });
  }

  await provider.close();
  console.log(`\n${failures.length === 0 ? 'All smoke checks passed' : `${failures.length} smoke check(s) failed`}`);
  console.log(`sandbox: ${sandbox}${options.keep ? ' (kept)' : ''}`);
  if (!options.keep) fs.rmSync(sandbox, { recursive: true, force: true });
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
