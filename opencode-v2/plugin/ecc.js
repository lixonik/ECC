import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { emptyOutcome, interpretHookResult, mergeOutcomes } from '../lib/hook-protocol.js';
import { loadHookManifest, selectHookCommands } from '../lib/hooks-manifest.js';
import { configuredShell, shellToolNameFor } from '../lib/opencode-config.js';
import { runHookProcess } from '../lib/hook-runner.js';
import { createReviewGate } from '../lib/review-gate.js';
import { createRuleTracker, loadRuleSets } from '../lib/rules.js';
import { autoCatalog, createSkillRouter, detectProjectStack, suggestionNote } from '../lib/skill-routing.js';
import { applySkillCatalog, hiddenSkillsNote, loadEccSkills } from '../lib/skills.js';
import { CODE_MODE_TOOL, fromClaudeInput, toClaudeCalls, toClaudeResponse } from '../lib/tool-translate.js';
import { createLogger } from '../lib/logger.js';
import { DEFAULT_RETENTION_DAYS, createTranscriptMirror, pruneTranscripts } from '../lib/transcript.js';

export const PLUGIN_ID = 'ecc';
export const FEEDBACK_TAG = 'ecc-hook-feedback';
export const PROMPT_CONTEXT_TAG = 'ecc-hook-context';
export const PERMISSION_ACTION = 'ecc_hook';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILTIN_TOOLS = new Set(['shell', 'edit', 'write', 'patch', 'read', 'glob', 'grep', 'skill', 'subagent', 'webfetch', 'websearch', 'question', CODE_MODE_TOOL]);
const MAX_STOP_CONTINUATIONS = 3;
const FILE_CHANGING_TOOLS = new Set(['edit', 'write', 'patch']);
const SHUTDOWN_HOOK_BUDGET_MS = 5000;

export function createEccPlugin(defaults = {}) {
  return {
    id: PLUGIN_ID,
    setup: ctx => setupEcc(ctx, { ...defaults, ...(ctx.options ?? {}) }),
  };
}

export default createEccPlugin();

export async function setupEcc(ctx, options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const projectDir = ctx.location?.directory ?? process.cwd();
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const logger = createLogger(path.join(stateDir, 'ecc-opencode.log'));
  const hookOptions = normalizeHookOptions(options.hooks);
  const baseEnv = buildBaseEnv({ root, projectDir, hookOptions, options });
  const hookFlags = createRequire(path.join(root, 'package.json'))('./scripts/lib/hook-flags.js');
  const hooksActive = hookOptions.enabled !== false && hookFlags.areHooksEnabled(baseEnv);
  const shellTool = createShellToolResolver(options.shell, projectDir);
  const sessions = new Map();
  const startedAt = Date.now();

  if (options.installDir && options.autoSync !== false) scheduleInstallSync(root, path.resolve(options.installDir), logger);

  const skillState = options.skills === false
    ? { hidden: [], hiddenIds: new Set(), skills: [], projectStack: new Set() }
    : await registerSkills(ctx, { root, projectDir, logger, selection: options.skills, catalogOption: options.skillCatalog });

  await ctx.shell.hook('create.before', event => {
    shellTool.observe(event.shell);
    event.env = { ...event.env, ...shellEnvFor(root, options) };
  });

  const note = options.context === false ? null : eccNote(root);
  const rules = await registerRules(ctx, { root, projectDir, sets: options.rules, logger, shellToolName: shellTool.name });
  const pushAmbient = event => {
    const texts = [
      note,
      skillState.hidden.length > 0 ? hiddenSkillsNote(skillState.hidden) : null,
      rules?.textFor(event.sessionID),
    ];
    for (const text of texts) if (text) event.system.push({ type: 'text', text });
  };

  if (!hooksActive) {
    const reason = hookOptions.enabled === false ? 'disabled by plugin options' : `disabled by environment (ECC_HOOKS_ENABLED=${baseEnv.ECC_HOOKS_ENABLED ?? 'unset'})`;
    logger.info(`ECC hooks inactive for ${projectDir}: ${reason}`);
    await ctx.session.hook('context', pushAmbient);
    await registerSkillSuggestions(ctx, { root, options, skillState, logger });
    return undefined;
  }

  const manifest = loadHookManifest(root);
  const transcriptDir = path.resolve(options.transcriptDir ?? path.join(stateDir, 'transcripts'));
  const pruned = pruneTranscripts(transcriptDir, retentionDays(options));
  if (pruned > 0) logger.info(`pruned ${pruned} transcript mirror(s) older than ${retentionDays(options)} days`);
  const transcript = createTranscriptMirror(transcriptDir, { cwd: projectDir });
  const isEnabled = (hookId, profiles) => hookFlags.isHookEnabled(hookId, { env: baseEnv, profiles });
  const nodePath = options.node ?? process.env.ECC_NODE ?? 'node';
  const asyncRuns = new Set();
  const toolIndex = createToolIndex(ctx);
  const allowedCalls = new Set();
  const pendingToolContext = new Map();

  const reviewGate = options.reviewGate
    ? createReviewGate({ agent: typeof options.reviewGate === 'object' ? options.reviewGate.agent : undefined, projectDir })
    : null;

  const sessionState = async sessionID => {
    let session = sessions.get(sessionID);
    if (!session) {
      session = { id: sessionID, parentID: undefined, resolved: false, createdHere: false, stopHookActive: false, continuations: 0, lastAssistantText: '', models: new Map(), model: undefined };
      sessions.set(sessionID, session);
    }
    if (!session.resolved) {
      session.resolved = true;
      try {
        const info = await ctx.session.get({ sessionID });
        session.parentID = info?.parentID ?? session.parentID;
        session.agent = info?.agent ?? session.agent;
        session.model ??= formatModel(info?.model);
        if (typeof info?.time?.created === 'number' && info.time.created >= startedAt) session.createdHere = true;
      } catch (error) {
        logger.warn(`session lookup failed for ${sessionID}: ${error.message}`);
      }
    }
    return session;
  };

  const rootOf = async session => {
    let current = session;
    for (let depth = 0; depth < 8 && current.parentID; depth += 1) current = await sessionState(current.parentID);
    return current;
  };

  const payloadFor = (session, eventName, extra = {}) => ({
    session_id: session.id,
    transcript_path: transcript.pathFor(session.id),
    cwd: projectDir,
    hook_event_name: eventName,
    permission_mode: 'default',
    ...(session.parentID ? { agent_id: session.id, agent_type: session.agent } : {}),
    ...extra,
  });

  const runHooks = async (eventName, target, payload, { forceAwait = false } = {}) => {
    const commands = selectHookCommands(manifest, eventName, target, isEnabled);
    if (commands.length === 0) return emptyOutcome();
    const env = {
      ...baseEnv,
      CLAUDE_SESSION_ID: payload.session_id,
      ECC_SESSION_ID: payload.session_id,
      CLAUDE_TRANSCRIPT_PATH: payload.transcript_path,
      CLAUDE_HOOK_EVENT_NAME: eventName,
    };
    const awaited = [];
    for (const command of commands) {
      const run = runHookProcess({ argv: command.argv, input: payload, env, cwd: payload.cwd, timeoutMs: command.timeoutMs, nodePath })
        .then(result => {
          const outcome = interpretHookResult(eventName, result);
          reportOutcome(logger, eventName, command.entryId, outcome);
          return outcome;
        });
      if (command.async && !forceAwait) {
        asyncRuns.add(run);
        run.finally(() => asyncRuns.delete(run));
      } else {
        awaited.push(run);
      }
    }
    return mergeOutcomes(await Promise.all(awaited));
  };

  const deliverToModel = async (sessionID, lines, resume = false) => {
    if (lines.length === 0) return;
    try {
      await ctx.session.synthetic({ sessionID, text: wrap(FEEDBACK_TAG, lines), delivery: resume ? 'queue' : 'steer', resume });
    } catch (error) {
      logger.warn(`could not deliver hook feedback to ${sessionID}: ${error.message}`);
    }
  };

  const ensureStarted = (session, source) => {
    if (session.parentID) return Promise.resolve();
    session.started ??= runHooks('SessionStart', source, payloadFor(session, 'SessionStart', { source, model: session.model }))
      .then(outcome => { session.startContext = outcome.context.join('\n\n'); })
      .catch(error => logger.error(`SessionStart failed: ${error.message}`));
    return session.started;
  };

  const translateEnv = sessionID => ({
    projectDir,
    shellToolName: shellTool.name,
    mcpName: toolId => toolIndex.mcpName(toolId),
    sessionID,
  });

  await ctx.tool.hook('execute.before', async event => {
    if (event.tool === CODE_MODE_TOOL) return;
    if (!BUILTIN_TOOLS.has(event.tool)) await toolIndex.refreshFor(event.tool);
    const session = await sessionState(event.sessionID);
    if (reviewGate && event.tool === 'subagent') reviewGate.recordSubagent((await rootOf(session)).id, event.input?.agent);
    const calls = toClaudeCalls(event.tool, event.input, translateEnv(event.sessionID));
    const contexts = [];
    for (const [index, call] of calls.entries()) {
      const callID = index === 0 ? event.id : `${event.id}:${index}`;
      transcript.toolUse(session.id, { messageID: event.messageID, model: session.model, callID, name: call.name, input: call.input });
      const outcome = await runHooks('PreToolUse', call.name, {
        ...payloadFor(session, 'PreToolUse', { tool_name: call.name, tool_input: call.input, tool_use_id: callID }),
        ...(call.cwd ? { cwd: call.cwd } : {}),
      });
      if (outcome.block || outcome.permission === 'deny') {
        throw new Error(`ECC hook blocked this ${call.name} call:\n${outcome.reason || outcome.permissionReason || 'Denied by ECC hook'}`);
      }
      if (outcome.permission === 'ask') {
        await ctx.permission.assert({
          sessionID: event.sessionID,
          agent: event.agent,
          action: PERMISSION_ACTION,
          resources: [call.name],
          metadata: { reason: outcome.permissionReason, tool: call.name },
          source: { type: 'tool', messageID: event.messageID, id: event.id },
        });
      }
      if (outcome.permission === 'allow') allowedCalls.add(event.id);
      if (outcome.updatedInput && calls.length === 1) {
        const updated = fromClaudeInput(event.tool, event.input, outcome.updatedInput, translateEnv(event.sessionID));
        if (updated) event.input = updated;
      }
      contexts.push(...outcome.context);
    }
    if (contexts.length > 0) pendingToolContext.set(event.id, contexts);
  });

  await ctx.tool.hook('execute.after', async event => {
    if (event.tool === CODE_MODE_TOOL) return;
    const session = await sessionState(event.sessionID);
    const calls = toClaudeCalls(event.tool, event.input, translateEnv(event.sessionID));
    const response = toClaudeResponse(event.tool, event);
    const eventName = event.status === 'error' ? 'PostToolUseFailure' : 'PostToolUse';
    if (reviewGate && event.status === 'completed' && FILE_CHANGING_TOOLS.has(event.tool)) {
      const changed = calls.flatMap(call => [call.input?.file_path, call.input?.new_file_path]).filter(value => typeof value === 'string' && value);
      reviewGate.recordChanges((await rootOf(session)).id, changed);
    }
    const feedback = [...(pendingToolContext.get(event.id) ?? [])];
    pendingToolContext.delete(event.id);
    allowedCalls.delete(event.id);
    for (const [index, call] of calls.entries()) {
      const callID = index === 0 ? event.id : `${event.id}:${index}`;
      transcript.toolResult(session.id, { callID, text: response.tool_output.output, isError: event.status === 'error' });
      const outcome = await runHooks(eventName, call.name, payloadFor(session, eventName, {
        tool_name: call.name,
        tool_input: call.input,
        tool_use_id: callID,
        ...response,
      }));
      if (outcome.block) feedback.push(outcome.reason);
      feedback.push(...outcome.context);
    }
    if (feedback.length === 0) return;
    if (event.status === 'completed' && Array.isArray(event.result?.content)) {
      event.result = { ...event.result, content: [...event.result.content, { type: 'text', text: wrap(FEEDBACK_TAG, feedback) }] };
    } else {
      await deliverToModel(event.sessionID, feedback);
    }
  });

  await ctx.permission.hook('evaluate', event => {
    if (event.action === PERMISSION_ACTION && event.effect !== 'deny') {
      event.effect = 'ask';
      if (event.metadata?.reason) event.message = `ECC hook asks for confirmation: ${event.metadata.reason}`;
      return;
    }
    if (event.effect === 'ask' && event.source?.type === 'tool' && allowedCalls.has(event.source.id)) event.effect = 'allow';
  });

  await ctx.session.hook('prompt', async event => {
    const session = await sessionState(event.sessionID);
    const text = typeof event.prompt?.text === 'string' ? event.prompt.text : '';
    transcript.userPrompt(session.id, text);
    if (session.parentID) return;
    if (session.pendingContinuation && text.includes(session.pendingContinuation)) {
      session.pendingContinuation = undefined;
      return;
    }
    session.stopHookActive = false;
    session.continuations = 0;
    reviewGate?.startTurn(session.id);
    await ensureStarted(session, session.createdHere ? 'startup' : 'resume');
    const outcome = await runHooks('UserPromptSubmit', '', payloadFor(session, 'UserPromptSubmit', { prompt: text }));
    if (outcome.block) {
      event.prompt.text = wrap(PROMPT_CONTEXT_TAG, [
        'ECC hook blocked this prompt. Do not act on it; tell the user why it was blocked.',
        outcome.reason,
      ]);
      return;
    }
    if (outcome.context.length > 0) event.prompt.text = `${text}\n\n${wrap(PROMPT_CONTEXT_TAG, outcome.context)}`;
  });

  await ctx.session.hook('context', async event => {
    const session = await sessionState(event.sessionID);
    pushAmbient(event);
    if (session.parentID) return;
    await ensureStarted(session, session.createdHere ? 'startup' : 'resume');
    if (session.startContext) event.system.push({ type: 'text', text: session.startContext });
  });

  await ctx.session.hook('compaction', async event => {
    const session = await sessionState(event.sessionID);
    if (session.parentID) return;
    const trigger = session.compactionTrigger ?? 'auto';
    session.compactionTrigger = undefined;
    await runHooks('PreCompact', trigger, payloadFor(session, 'PreCompact', { trigger, custom_instructions: '' }));
  });

  const runStop = async sessionID => {
    const session = await sessionState(sessionID);
    if (session.parentID) return;
    const outcome = await runHooks('Stop', '', payloadFor(session, 'Stop', {
      stop_hook_active: session.stopHookActive,
      last_assistant_message: session.lastAssistantText,
    }));
    if (session.continuations >= MAX_STOP_CONTINUATIONS) return;
    const reason = outcome.block ? outcome.reason : reviewGate?.claim(sessionID);
    if (!reason) return;
    session.stopHookActive = true;
    session.continuations += 1;
    session.pendingContinuation = reason;
    await deliverToModel(sessionID, [reason], true);
  };

  const runSessionEnd = async (sessionID, reason) => {
    const session = sessions.get(sessionID);
    if (!session || session.parentID || !session.started || session.ended) return;
    session.ended = true;
    await runHooks('SessionEnd', reason, payloadFor(session, 'SessionEnd', { reason }), { forceAwait: true });
  };

  const handlers = {
    'session.created': async data => {
      const session = await sessionState(data.sessionID);
      session.createdHere = true;
      if (data.parentID) session.parentID = data.parentID;
      if (data.agent) session.agent = data.agent;
    },
    'session.step.started': async data => {
      const session = await sessionState(data.sessionID);
      session.model = formatModel(data.model);
      session.models.set(data.assistantMessageID, session.model);
    },
    'session.text.ended': async data => {
      const session = await sessionState(data.sessionID);
      session.lastAssistantText = data.text ?? '';
      transcript.assistantText(session.id, { messageID: data.assistantMessageID, model: session.models.get(data.assistantMessageID) ?? session.model, text: data.text ?? '' });
    },
    'session.step.ended': async data => {
      const session = await sessionState(data.sessionID);
      transcript.usage(session.id, { messageID: data.assistantMessageID, model: session.models.get(data.assistantMessageID) ?? session.model, tokens: data.tokens, cost: data.cost });
      session.models.delete(data.assistantMessageID);
    },
    'session.compaction.started': async data => {
      const session = await sessionState(data.sessionID);
      session.compactionTrigger = data.reason === 'manual' ? 'manual' : 'auto';
    },
    'session.compaction.ended': async data => {
      const session = await sessionState(data.sessionID);
      transcript.compactBoundary(session.id);
      if (session.parentID) return;
      session.started = undefined;
      await ensureStarted(session, 'compact');
    },
    'session.execution.succeeded': data => runStop(data.sessionID),
    'session.deleted': data => runSessionEnd(data.sessionID, 'other'),
  };

  const subscription = new AbortController();
  const debug = options.debug === true || process.env.ECC_OPENCODE_DEBUG === '1';
  consumeEvents(ctx, subscription.signal, handlers, logger, debug);
  logger.info(`ECC hook bridge active for ${projectDir} (root ${root})`);

  await registerSkillSuggestions(ctx, { root, options, skillState, logger });

  return async () => {
    subscription.abort();
    const ends = [...sessions.keys()].map(sessionID => runSessionEnd(sessionID, 'prompt_input_exit'));
    await Promise.race([
      Promise.allSettled([...ends, ...asyncRuns]),
      new Promise(resolve => setTimeout(resolve, SHUTDOWN_HOOK_BUDGET_MS).unref?.()),
    ]);
  };
}

async function registerSkills(ctx, { root, projectDir, logger, selection, catalogOption }) {
  const { skills, skipped } = loadEccSkills(root);
  for (const entry of skipped) logger.warn(`skill ${entry.id} skipped: ${entry.reason}`);
  const wanted = Array.isArray(selection) ? new Set(selection) : null;
  const selected = wanted ? skills.filter(skill => wanted.has(skill.id)) : skills;
  for (const id of [...(wanted ?? []), ...(Array.isArray(catalogOption) ? catalogOption : [])]) {
    if (!skills.some(skill => skill.id === id)) logger.warn(`skill ${id} requested but not found in ECC`);
  }
  const projectStack = catalogOption === 'auto' ? detectProjectStack(root, projectDir) : new Set();
  const catalog = applySkillCatalog(selected, catalogOption === 'auto' ? autoCatalog(selected, projectStack) : catalogOption);
  if (catalogOption === 'auto') logger.info(`auto skill catalog for ${projectDir} (stack: ${[...projectStack].join(', ') || 'unknown'}): ${selected.length - catalog.hidden.length} described`);
  const hiddenIds = new Set(catalog.hidden);
  const state = { hidden: [], hiddenIds, skills: selected, projectStack };
  await ctx.skill.transform(editor => {
    const hidden = [];
    for (const skill of catalog.skills) {
      if (editor.get(skill.id)) continue;
      editor.add(skill);
      if (hiddenIds.has(skill.id)) hidden.push(skill.id);
    }
    state.hidden = hidden;
  });
  return state;
}

function consumeEvents(ctx, signal, handlers, logger, debug) {
  (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (debug) logger.info(`event ${event?.type} ${JSON.stringify(event?.data ?? {}).slice(0, 200)}`);
        const handler = handlers[event?.type];
        if (!handler || !event.data?.sessionID) continue;
        Promise.resolve()
          .then(() => handler(event.data))
          .catch(error => logger.error(`${event.type} handler failed: ${error.message}`));
      }
    } catch (error) {
      if (!signal.aborted) logger.error(`event stream stopped: ${error.message}`);
    }
  })();
}

function createToolIndex(ctx) {
  let byId = new Map();
  return {
    async refreshFor(toolId) {
      if (byId.has(toolId)) return;
      try {
        byId = new Map((await ctx.tool.list()).map(tool => [tool.id, tool]));
      } catch {
        byId = new Map();
      }
    },
    mcpName(toolId) {
      const tool = byId.get(toolId);
      const namespace = tool?.options?.namespace;
      return namespace ? `mcp__${namespace}__${tool.name}` : null;
    },
  };
}

function createShellToolResolver(option, projectDir) {
  const fixed = option === 'Bash' || option === 'PowerShell' ? option : null;
  const configured = fixed ? undefined : shellToolNameFor(configuredShell(projectDir));
  const guess = configured ?? (process.platform === 'win32' ? 'PowerShell' : 'Bash');
  let observed = null;
  return {
    name: () => fixed ?? observed ?? guess,
    observe: shell => {
      observed = shellToolNameFor(shell) ?? observed;
    },
  };
}

function normalizeHookOptions(value) {
  if (value === false) return { enabled: false };
  if (value === true || value === undefined || value === null) return {};
  return {
    enabled: value.enabled,
    profile: typeof value.profile === 'string' ? value.profile : undefined,
    disabled: Array.isArray(value.disabled) ? value.disabled.map(String) : [],
  };
}

function buildBaseEnv({ root, projectDir, hookOptions, options }) {
  const disabled = [process.env.ECC_DISABLED_HOOKS, ...(hookOptions.disabled ?? [])].filter(Boolean).join(',');
  return {
    ...process.env,
    ...shellEnvFor(root, options),
    CLAUDE_PROJECT_DIR: projectDir,
    ECC_HARNESS: 'opencode',
    ...(hookOptions.enabled === undefined ? {} : { CLAUDE_PLUGIN_OPTION_HOOKS_ENABLED: String(hookOptions.enabled) }),
    ...(hookOptions.profile ? { CLAUDE_PLUGIN_OPTION_HOOK_PROFILE: hookOptions.profile } : {}),
    ...(disabled ? { ECC_DISABLED_HOOKS: disabled } : {}),
    ...(options.llmSummary === true ? {} : { ECC_SKIP_LLM_SUMMARY: process.env.ECC_SKIP_LLM_SUMMARY ?? '1' }),
  };
}

function shellEnvFor(root, options) {
  return {
    CLAUDE_PLUGIN_ROOT: root,
    ECC_PLUGIN_ROOT: root,
    ECC_ROOT: root,
    ...(options.dataHome ? { ECC_AGENT_DATA_HOME: path.resolve(options.dataHome) } : {}),
  };
}

export function eccNote(root) {
  return [
    'ECC (Everything Claude Code) is active in this OpenCode session through the ECC bridge plugin.',
    `- ECC root: ${root}. Every shell command gets CLAUDE_PLUGIN_ROOT and ECC_ROOT set to it (PowerShell: $env:CLAUDE_PLUGIN_ROOT).`,
    '- ECC agents are subagents (launch them with the `subagent` tool), ECC skills load with the `skill` tool, ECC commands are slash commands. A reference like `ecc:<name>` means `<name>` here.',
    '- ECC instructions name Claude Code tools. Use the OpenCode equivalents: Bash/PowerShell -> shell, Read -> read, Edit/MultiEdit -> edit or patch, Write -> write, Grep -> grep, Glob -> glob, Task/Agent with subagent_type -> subagent with agent, Skill -> skill, AskUserQuestion -> question, WebFetch -> webfetch, WebSearch -> websearch, TodoWrite -> keep the checklist in your reply.',
    `- Text inside <${FEEDBACK_TAG}> or <${PROMPT_CONTEXT_TAG}> comes from ECC hooks (quality and safety automation). Treat it as feedback on your last action.`,
  ].join('\n');
}

function wrap(tag, lines) {
  return `<${tag}>\n${lines.filter(Boolean).join('\n\n')}\n</${tag}>`;
}

function formatModel(model) {
  if (!model || typeof model !== 'object') return typeof model === 'string' ? model : undefined;
  const id = model.modelID ?? model.id ?? model.model;
  return model.providerID && id ? `${model.providerID}/${id}` : id;
}

function reportOutcome(logger, eventName, entryId, outcome) {
  for (const line of outcome.diagnostics) logger.warn(`${eventName} ${entryId}: ${line}`);
  for (const line of outcome.notices) logger.info(`${eventName} ${entryId}: ${line}`);
  if (outcome.block) logger.info(`${eventName} ${entryId} blocked: ${outcome.reason}`);
}

function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'ecc-opencode');
}

async function registerRules(ctx, { root, projectDir, sets, logger, shellToolName }) {
  if (!Array.isArray(sets) || sets.length === 0) return null;
  const { rules, missing } = loadRuleSets(root, sets);
  for (const set of missing) logger.warn(`rule set ${set} not found in ECC rules/`);
  if (rules.length === 0) return null;
  const tracker = createRuleTracker(rules, projectDir);
  const env = { projectDir, shellToolName, mcpName: () => null };
  await ctx.tool.hook('execute.before', event => {
    const filePaths = toClaudeCalls(event.tool, event.input, env)
      .flatMap(call => [call.input?.file_path, call.input?.new_file_path, call.input?.notebook_path])
      .filter(value => typeof value === 'string' && value);
    const activated = tracker.touch(event.sessionID, filePaths);
    if (activated.length > 0) logger.info(`rules activated for ${event.sessionID}: ${activated.join(', ')}`);
  });
  logger.info(`ECC rules loaded: ${rules.length} from ${sets.join(', ')}`);
  return tracker;
}

async function registerSkillSuggestions(ctx, { root, options, skillState, logger }) {
  if (options.skillSuggestions === false || skillState.hiddenIds.size === 0) return;
  let router;
  try {
    router = createSkillRouter(root, skillState.skills, skillState.projectStack.size > 0 ? skillState.projectStack : detectProjectStack(root, ctx.location?.directory));
  } catch (error) {
    logger.warn(`skill suggestions unavailable: ${error.message}`);
    return;
  }
  await ctx.session.hook('prompt', event => {
    const text = typeof event.prompt?.text === 'string' ? event.prompt.text : '';
    if (!text.trim() || text.trimStart().startsWith('<ecc-')) return;
    const suggestions = router.suggest(text, { candidates: skillState.hiddenIds });
    if (suggestions.length > 0) event.prompt.text = `${text}

${suggestionNote(suggestions)}`;
  });
}

const installSyncs = new Map();

export function scheduleInstallSync(root, installDir, logger) {
  if (!installSyncs.has(installDir)) {
    installSyncs.set(installDir, new Promise(resolve => setTimeout(resolve, 0))
      .then(() => import('../install.js'))
      .then(({ syncInstall }) => {
        const report = syncInstall(installDir, { root });
        if (report && report.created + report.updated + report.removed > 0) {
          logger.info(`auto-sync refreshed ECC files in ${installDir}: ${report.created} created, ${report.updated} updated, ${report.removed} removed`);
        }
        return report;
      })
      .catch(error => {
        logger.warn(`auto-sync failed for ${installDir}: ${error.message}`);
        return null;
      }));
  }
  return installSyncs.get(installDir);
}

function retentionDays(options) {
  const configured = Number(options.transcriptRetentionDays ?? process.env.ECC_SESSION_RETENTION_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_DAYS;
}
