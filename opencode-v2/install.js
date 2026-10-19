#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILTIN_AGENT_IDS, BUILTIN_COMMAND_NAMES, convertAgent, convertCommand } from './lib/convert.js';
import { globalConfigDir } from './lib/opencode-config.js';

const ECC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_NAME = 'ecc-opencode-v2.install.json';
const PLUGIN_DIR = path.join('plugins', 'ecc');
const HOOK_PROFILES = ['minimal', 'standard', 'strict'];

const USAGE = `Usage: node opencode-v2/install.js [install|uninstall|status] [options]

Scope:
  --scope global|project     global: OpenCode config dir (default); project: <dir>/.opencode
  --project <dir>            project directory for --scope project (default: cwd)
  --config-dir <dir>         explicit OpenCode config dir (overrides scope resolution)

Hooks:
  --hooks on|off             run ECC hooks through the bridge (default: on)
  --profile minimal|standard|strict
  --disable-hook <ids>       comma-separated ECC hook ids to disable
  --shell auto|Bash|PowerShell  tool name ECC hooks see for the shell tool (default: auto)
  --node <path>              Node.js executable for hook scripts (default: node on PATH)
  --llm-summary              let PreCompact/SessionEnd call the claude CLI for summaries

Content:
  --model-map <map>          e.g. opus=provider/big,sonnet=provider/mid,haiku=provider/small
  --skills <ids>             register only these ECC skills (comma-separated ids)
  --no-skills                do not register ECC skills
  --no-context               do not inject the ECC tool-mapping note
  --data-home <dir>          ECC_AGENT_DATA_HOME for hooks and shells (default: ~/.claude)

Safety:
  --dry-run                  print the plan without writing
  --force                    overwrite files that were changed after install or not owned by ECC
`;

const splitList = value => value.split(',').map(item => item.trim()).filter(Boolean);

const VALUE_FLAGS = Object.freeze({
  '--scope': (options, value) => { options.scope = value; },
  '--project': (options, value) => { options.project = value; },
  '--config-dir': (options, value) => { options.configDir = value; },
  '--hooks': (options, value) => { options.hooks = parseOnOff(value); },
  '--profile': (options, value) => { options.profile = value; },
  '--disable-hook': (options, value) => { options.disabledHooks.push(...splitList(value)); },
  '--shell': (options, value) => { options.shell = value; },
  '--node': (options, value) => { options.node = value; },
  '--model-map': (options, value) => { options.modelMap = parseModelMap(value); },
  '--skills': (options, value) => { options.skills = splitList(value); },
  '--data-home': (options, value) => { options.dataHome = value; },
});

const SWITCH_FLAGS = Object.freeze({
  '--llm-summary': options => { options.llmSummary = true; },
  '--no-skills': options => { options.skills = false; },
  '--no-context': options => { options.context = false; },
  '--dry-run': options => { options.dryRun = true; },
  '--force': options => { options.force = true; },
  '--help': options => { options.action = 'help'; },
  '-h': options => { options.action = 'help'; },
});

export function parseArgs(argv) {
  const options = { action: 'install', scope: 'global', hooks: true, skills: true, context: true, force: false, dryRun: false, disabledHooks: [], modelMap: {} };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) options.action = args.shift();
  while (args.length > 0) {
    const flag = args.shift();
    if (Object.hasOwn(SWITCH_FLAGS, flag)) {
      SWITCH_FLAGS[flag](options);
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    VALUE_FLAGS[flag](options, value);
  }
  if (!['install', 'uninstall', 'status', 'help'].includes(options.action)) throw new Error(`Unknown action: ${options.action}`);
  if (!['global', 'project'].includes(options.scope)) throw new Error(`--scope must be global or project`);
  if (options.profile && !HOOK_PROFILES.includes(options.profile)) throw new Error(`--profile must be one of ${HOOK_PROFILES.join(', ')}`);
  if (options.shell && !['auto', 'Bash', 'PowerShell'].includes(options.shell)) throw new Error('--shell must be auto, Bash or PowerShell');
  return options;
}

function parseOnOff(value) {
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  if (['off', 'false', '0', 'no'].includes(value)) return false;
  throw new Error(`Expected on or off, got ${value}`);
}

function parseModelMap(value) {
  return Object.fromEntries(value.split(',').map(pair => pair.split('=').map(part => part.trim())).map(([tier, model]) => {
    if (!tier || !model || !model.includes('/')) throw new Error(`Invalid --model-map entry: ${tier}=${model ?? ''}`);
    return [tier.toLowerCase(), model];
  }));
}

export function resolveTargetDir(options, env = process.env) {
  if (options.configDir) return path.resolve(options.configDir);
  if (options.scope === 'project') return path.resolve(options.project ?? process.cwd(), '.opencode');
  return globalConfigDir(env);
}

export function pluginOptionsFrom(options) {
  return dropUndefined({
    root: ECC_ROOT,
    hooks: options.hooks
      ? dropUndefined({ enabled: true, profile: options.profile, disabled: options.disabledHooks.length > 0 ? options.disabledHooks : undefined })
      : false,
    skills: options.skills,
    context: options.context,
    shell: options.shell && options.shell !== 'auto' ? options.shell : undefined,
    node: options.node,
    llmSummary: options.llmSummary,
    dataHome: options.dataHome ? path.resolve(options.dataHome) : undefined,
  });
}

export function planFiles(options, root = ECC_ROOT) {
  const files = new Map();
  const warnings = [];
  for (const file of fs.readdirSync(path.join(root, 'agents')).filter(name => name.endsWith('.md')).sort()) {
    const id = path.basename(file, '.md');
    if (BUILTIN_AGENT_IDS.includes(id)) {
      warnings.push(`agent ${id} skipped: collides with a built-in OpenCode agent`);
      continue;
    }
    files.set(path.join('agents', file), convertAgent(fs.readFileSync(path.join(root, 'agents', file), 'utf8'), options));
  }
  for (const file of fs.readdirSync(path.join(root, 'commands')).filter(name => name.endsWith('.md')).sort()) {
    const name = path.basename(file, '.md');
    if (BUILTIN_COMMAND_NAMES.includes(name)) {
      warnings.push(`command ${name} skipped: collides with a built-in OpenCode command`);
      continue;
    }
    files.set(path.join('commands', file), convertCommand(fs.readFileSync(path.join(root, 'commands', file), 'utf8'), options));
  }
  files.set(path.join(PLUGIN_DIR, 'package.json'), `${JSON.stringify({ name: 'ecc-opencode-v2-entry', private: true, type: 'module', main: 'index.js' }, null, 2)}\n`);
  files.set(path.join(PLUGIN_DIR, 'index.js'), pluginEntrySource(pluginOptionsFrom(options), root));
  return { files, warnings };
}

export function pluginEntrySource(pluginOptions, root = ECC_ROOT) {
  const entry = pathToFileURL(path.join(root, 'opencode-v2', 'plugin', 'ecc.js')).href;
  return `import { createEccPlugin } from ${JSON.stringify(entry)};\n\nexport default createEccPlugin(${JSON.stringify(pluginOptions, null, 2)});\n`;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readManifest(targetDir) {
  const file = path.join(targetDir, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function currentHash(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

export function install(options, { root = ECC_ROOT, log = console.log } = {}) {
  const targetDir = resolveTargetDir(options);
  const previous = readManifest(targetDir);
  const owned = new Map(Object.entries(previous?.files ?? {}));
  const { files, warnings } = planFiles(options, root);
  const written = {};
  const report = { targetDir, created: 0, updated: 0, unchanged: 0, skipped: [], removed: 0, warnings };

  for (const [relative, content] of files) {
    const absolute = path.join(targetDir, relative);
    const existing = currentHash(absolute);
    const next = sha256(content);
    const recorded = owned.get(normalizeKey(relative));
    if (existing === next) {
      report.unchanged += 1;
      written[normalizeKey(relative)] = next;
      continue;
    }
    if (existing !== null && !options.force && (recorded === undefined || recorded !== existing)) {
      report.skipped.push(`${relative} (${recorded === undefined ? 'not created by ECC' : 'modified after install'}; use --force to overwrite)`);
      if (recorded !== undefined) written[normalizeKey(relative)] = recorded;
      continue;
    }
    if (!options.dryRun) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    if (existing === null) report.created += 1;
    else report.updated += 1;
    written[normalizeKey(relative)] = next;
  }

  for (const [relative, hash] of owned) {
    if (Object.hasOwn(written, relative)) continue;
    const absolute = path.join(targetDir, relative);
    if (currentHash(absolute) === hash) {
      if (!options.dryRun) fs.rmSync(absolute, { force: true });
      report.removed += 1;
    } else if (fs.existsSync(absolute)) {
      report.skipped.push(`${relative} (stale but modified; left in place)`);
    }
  }

  if (!options.dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, MANIFEST_NAME), `${JSON.stringify({
      tool: 'ecc-opencode-v2',
      eccRoot: root,
      installedAt: new Date().toISOString(),
      options: pluginOptionsFrom(options),
      files: written,
    }, null, 2)}\n`);
  }
  printReport(log, options.dryRun ? 'Dry run' : 'Installed', report);
  return report;
}

export function uninstall(options, { log = console.log } = {}) {
  const targetDir = resolveTargetDir(options);
  const manifest = readManifest(targetDir);
  const report = { targetDir, removed: 0, skipped: [], created: 0, updated: 0, unchanged: 0, warnings: [] };
  if (!manifest) {
    log(`No ECC install manifest in ${targetDir}; nothing to remove.`);
    return report;
  }
  for (const [relative, hash] of Object.entries(manifest.files ?? {})) {
    const absolute = path.join(targetDir, relative);
    if (!fs.existsSync(absolute)) continue;
    if (currentHash(absolute) !== hash && !options.force) {
      report.skipped.push(`${relative} (modified after install; use --force to remove)`);
      continue;
    }
    if (!options.dryRun) fs.rmSync(absolute, { force: true });
    report.removed += 1;
  }
  if (!options.dryRun) {
    removeIfEmpty(path.join(targetDir, PLUGIN_DIR));
    if (report.skipped.length === 0) fs.rmSync(path.join(targetDir, MANIFEST_NAME), { force: true });
  }
  printReport(log, options.dryRun ? 'Dry run' : 'Uninstalled', report);
  return report;
}

export function status(options, { log = console.log } = {}) {
  const targetDir = resolveTargetDir(options);
  const manifest = readManifest(targetDir);
  if (!manifest) {
    log(`ECC for OpenCode V2 is not installed in ${targetDir}.`);
    return null;
  }
  const entries = Object.entries(manifest.files ?? {});
  const missing = entries.filter(([relative]) => !fs.existsSync(path.join(targetDir, relative))).length;
  const modified = entries.filter(([relative, hash]) => {
    const absolute = path.join(targetDir, relative);
    return fs.existsSync(absolute) && currentHash(absolute) !== hash;
  }).length;
  log(`ECC for OpenCode V2 in ${targetDir}`);
  log(`  ECC root:   ${manifest.eccRoot}`);
  log(`  installed:  ${manifest.installedAt}`);
  log(`  files:      ${entries.length} (${missing} missing, ${modified} modified)`);
  log(`  agents:     ${entries.filter(([relative]) => relative.startsWith('agents/')).length}`);
  log(`  commands:   ${entries.filter(([relative]) => relative.startsWith('commands/')).length}`);
  log(`  options:    ${JSON.stringify(manifest.options)}`);
  return { targetDir, files: entries.length, missing, modified };
}

function removeIfEmpty(directory) {
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {
    return;
  }
}

function normalizeKey(relative) {
  return relative.split(path.sep).join('/');
}

function printReport(log, title, report) {
  log(`${title}: ECC for OpenCode V2 -> ${report.targetDir}`);
  log(`  created ${report.created}, updated ${report.updated}, unchanged ${report.unchanged}, removed ${report.removed}`);
  for (const warning of report.warnings) log(`  note: ${warning}`);
  for (const skipped of report.skipped) log(`  skipped: ${skipped}`);
}

function dropUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.action === 'help') {
    console.log(USAGE);
    return;
  }
  const actions = { install, uninstall, status };
  const result = actions[options.action](options);
  if (result && Array.isArray(result.skipped) && result.skipped.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
