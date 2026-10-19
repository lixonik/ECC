import path from 'node:path';
import { parsePatchOperations } from './patch.js';

export const CODE_MODE_TOOL = 'execute';

const SIMPLE_TOOL_NAMES = Object.freeze({
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  skill: 'Skill',
  subagent: 'Task',
  question: 'AskUserQuestion',
});

export function toClaudeCalls(tool, input, env) {
  const args = isObject(input) ? input : {};
  switch (tool) {
    case CODE_MODE_TOOL:
      return [];
    case 'shell':
      return [{ name: env.shellToolName(), input: shellInput(args), cwd: args.workdir ? resolvePath(env, args.workdir) : undefined }];
    case 'edit':
      return [{
        name: 'Edit',
        input: dropUndefined({
          file_path: resolvePath(env, args.path),
          old_string: args.oldString,
          new_string: args.newString,
          replace_all: args.replaceAll,
        }),
      }];
    case 'write':
      return [{ name: 'Write', input: { file_path: resolvePath(env, args.path), content: args.content } }];
    case 'patch':
      return patchCalls(args.patchText, env);
    case 'read':
      return [{ name: 'Read', input: dropUndefined({ ...omit(args, ['path']), file_path: resolvePath(env, args.path) }) }];
    case 'skill':
      return [{ name: 'Skill', input: { skill: args.id, skill_id: args.id } }];
    case 'subagent':
      return [{
        name: 'Task',
        input: dropUndefined({
          subagent_type: args.agent,
          description: args.description,
          prompt: args.prompt,
          model: args.model,
          run_in_background: args.background,
        }),
      }];
    default:
      break;
  }
  if (Object.hasOwn(SIMPLE_TOOL_NAMES, tool)) return [{ name: SIMPLE_TOOL_NAMES[tool], input: args }];
  const mcpName = env.mcpName?.(tool);
  return [{ name: mcpName ?? tool, input: args }];
}

export function fromClaudeInput(tool, original, updated, env) {
  if (!isObject(updated) || !isObject(original)) return null;
  switch (tool) {
    case 'shell':
      return dropUndefined({
        ...original,
        command: updated.command ?? original.command,
        timeout: updated.timeout ?? original.timeout,
        background: updated.run_in_background ?? original.background,
      });
    case 'edit':
      return dropUndefined({
        ...original,
        path: updated.file_path ? relativeIfInside(env, updated.file_path, original.path) : original.path,
        oldString: updated.old_string ?? original.oldString,
        newString: updated.new_string ?? original.newString,
        replaceAll: updated.replace_all ?? original.replaceAll,
      });
    case 'write':
      return {
        ...original,
        path: updated.file_path ? relativeIfInside(env, updated.file_path, original.path) : original.path,
        content: updated.content ?? original.content,
      };
    case 'read':
      return dropUndefined({
        ...original,
        ...omit(updated, ['file_path']),
        path: updated.file_path ? relativeIfInside(env, updated.file_path, original.path) : original.path,
      });
    case 'subagent':
      return dropUndefined({
        ...original,
        agent: updated.subagent_type ?? original.agent,
        description: updated.description ?? original.description,
        prompt: updated.prompt ?? original.prompt,
      });
    case 'patch':
    case CODE_MODE_TOOL:
      return null;
    default:
      return { ...original, ...updated };
  }
}

export function toClaudeResponse(tool, completion) {
  if (completion.status === 'error') {
    const message = errorMessage(completion.error);
    return { error: message, tool_response: { error: message, success: false }, tool_output: { output: message } };
  }
  const result = completion.result ?? {};
  const text = textOf(result.content);
  const structured = isObject(result.output) ? result.output : {};
  if (tool === 'shell') {
    const exitCode = structured.exit ?? result.metadata?.exit;
    return {
      tool_response: dropUndefined({
        stdout: typeof structured.output === 'string' ? structured.output : text,
        stderr: '',
        interrupted: structured.status === 'running' ? false : Boolean(structured.signal),
        exit_code: exitCode,
        isImage: false,
      }),
      tool_output: { output: typeof structured.output === 'string' ? structured.output : text },
    };
  }
  return {
    tool_response: dropUndefined({ ...structured, output: text || structured.output, success: true }),
    tool_output: { output: text },
  };
}

function patchCalls(patchText, env) {
  return parsePatchOperations(patchText).flatMap(operation => {
    const filePath = resolvePath(env, operation.path);
    if (operation.type === 'add') return [{ name: 'Write', input: { file_path: filePath, content: operation.content } }];
    if (operation.type === 'update') {
      return [{
        name: 'MultiEdit',
        input: dropUndefined({
          file_path: filePath,
          new_file_path: operation.moveTo ? resolvePath(env, operation.moveTo) : undefined,
          edits: operation.hunks.map(hunk => ({ old_string: hunk.oldText, new_string: hunk.newText, replace_all: false })),
        }),
      }];
    }
    return [];
  });
}

function shellInput(args) {
  return dropUndefined({
    command: args.command,
    timeout: args.timeout,
    run_in_background: args.background,
    description: args.description,
  });
}

function resolvePath(env, value) {
  if (typeof value !== 'string' || value === '') return value;
  return path.resolve(env.projectDir, value);
}

function relativeIfInside(env, absolute, original) {
  if (typeof original === 'string' && path.isAbsolute(original)) return absolute;
  const relative = path.relative(env.projectDir, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : absolute;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(part => part && part.type === 'text').map(part => part.text).join('\n');
}

function errorMessage(error) {
  if (!error) return 'Tool failed';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

function omit(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function dropUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
