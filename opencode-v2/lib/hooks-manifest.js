import path from 'node:path';
import { createRequire } from 'node:module';
import { createMatcher, describeHookCommand, tokenizeCommand } from './hook-protocol.js';

const DEFAULT_TIMEOUT_SECONDS = 60;

export function loadHookManifest(root) {
  const require = createRequire(path.join(root, 'package.json'));
  const { readHooksConfig } = require('./scripts/lib/hooks-config.js');
  const config = readHooksConfig(path.join(root, 'hooks', 'hooks.json'));
  return buildHookManifest(config);
}

export function buildHookManifest(config) {
  const manifest = {};
  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    manifest[event] = entries.map((entry, index) => ({
      event,
      id: entry.id ?? `${event}:${index}`,
      description: entry.description ?? '',
      matcher: entry.matcher ?? '*',
      matches: createMatcher(entry.matcher),
      commands: (entry.hooks ?? [])
        .filter(hook => hook.type === 'command' && typeof hook.command === 'string')
        .map(hook => {
          const argv = tokenizeCommand(hook.command);
          return {
            argv,
            async: hook.async === true,
            timeoutMs: (Number(hook.timeout) > 0 ? Number(hook.timeout) : DEFAULT_TIMEOUT_SECONDS) * 1000,
            ...describeHookCommand(argv),
          };
        }),
    }));
  }
  return manifest;
}

export function selectHookCommands(manifest, event, target, isEnabled) {
  return (manifest[event] ?? [])
    .filter(entry => entry.matches(target))
    .flatMap(entry => entry.commands.map(command => ({ ...command, entryId: entry.id })))
    .filter(command => !command.hookId || isEnabled(command.hookId, command.profiles));
}
