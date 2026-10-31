import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuredShell, globalConfigDir, readJsonc } from './opencode-config.js';
import { loadHookManifest } from './hooks-manifest.js';
import { loadEccSkills } from './skills.js';

const execFileAsync = promisify(execFile);
const result = (id, status, message) => ({ id, status, message });
const commandFailure = (id, label) => result(id, 'fail', id === 'opencode'
  ? 'OpenCode could not be checked; pass its native executable with --opencode (opencode.exe on Windows)'
  : `${label} could not be checked`);

export async function runDoctorCommand(command, args, { cwd, env, timeoutMs }) {
  const script = /\.(?:[cm]?js)$/i.test(command);
  try {
    const output = await execFileAsync(script ? process.execPath : command, script ? [command, ...args] : args, {
      cwd, env, timeout: Math.min(timeoutMs, 15000), maxBuffer: 65536, encoding: 'utf8', windowsHide: true,
    });
    return { exitCode: 0, ...output };
  } catch {
    return { exitCode: 1, stdout: '', stderr: '', error: 'Command could not complete' };
  }
}

async function commandCheck(id, command, args, context, accept, label) {
  try {
    const response = await context.runCommand(command, args, context);
    const version = /\bv?(\d+)\.(\d+)\.(\d+)\b/.exec(response.stdout ?? '');
    if (response.exitCode !== 0 || response.error || !version) return commandFailure(id, label);
    if (!accept(version.slice(1).map(Number))) return result(id, 'fail', `${label} version ${version[0]} is unsupported`);
    return result(id, 'pass', `${label} ${version[0]}`);
  } catch {
    return commandFailure(id, label);
  }
}

function configDirectories(options, env) {
  return [...new Set([options.configDir ?? globalConfigDir(env), options.project, path.join(options.project, '.opencode')].map(dir => path.resolve(dir)))];
}

function checkConfig(options, env) {
  const files = configDirectories(options, env).flatMap(dir => ['opencode.json', 'opencode.jsonc'].map(name => path.join(dir, name))).filter(file => fs.existsSync(file));
  if (files.length === 0) return result('config', 'warn', 'No local OpenCode config found; provider connections may be managed by OpenCode');
  for (const file of files) {
    const config = readJsonc(file);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return result('config', 'fail', 'An OpenCode config file is invalid');
  }
  return result('config', 'pass', `${files.length} local config file(s) are valid JSONC`);
}

function checkHooks(root) {
  try {
    const count = Object.values(loadHookManifest(root)).reduce((total, entries) => total + entries.reduce((sum, entry) => sum + entry.commands.length, 0), 0);
    return result('hooks', count > 0 ? 'pass' : 'fail', count > 0 ? `${count} hook commands parsed; no hooks were executed` : 'No hook commands found');
  } catch {
    return result('hooks', 'fail', 'ECC hook manifest could not be parsed');
  }
}

function checkSkills(root) {
  try {
    const { skills, skipped } = loadEccSkills(root);
    if (skills.length === 0) return result('skills', 'fail', 'No loadable ECC skills found');
    return result('skills', skipped.length ? 'warn' : 'pass', `${skills.length} skills loaded; ${skipped.length} invalid skill(s) skipped`);
  } catch {
    return result('skills', 'fail', 'ECC skill catalog could not be loaded');
  }
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function manifestDirectory(options, env) {
  if (options.configDir) return path.resolve(options.configDir);
  const local = path.join(options.project, '.opencode');
  return fs.existsSync(path.join(local, 'ecc-opencode-v2.install.json')) ? local : globalConfigDir(env);
}

function inspectOwnedFiles(directory, files) {
  let modified = 0;
  let missing = 0;
  let totalBytes = 0;
  if (Object.keys(files).length > 2000) throw new Error('Ownership manifest is too large');
  for (const [relative, expected] of Object.entries(files)) {
    const file = path.resolve(directory, relative);
    const inside = path.relative(directory, file);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside) || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid ownership manifest');
    if (!fs.existsSync(file)) { missing += 1; continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid owned file');
    totalBytes += stat.size;
    if (totalBytes > 32 * 1024 * 1024) throw new Error('Installed files are too large to inspect');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) modified += 1;
  }
  return { modified, missing };
}

function checkInstallation(options, env, root) {
  const directory = manifestDirectory(options, env);
  const file = path.join(directory, 'ecc-opencode-v2.install.json');
  if (!fs.existsSync(file)) return result('installation', 'warn', 'ECC v2 installation manifest not found; run opencode-v2/install.js');
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.tool !== 'ecc-opencode-v2' || typeof manifest.eccRoot !== 'string' || !samePath(manifest.eccRoot, root)) return result('installation', 'fail', 'ECC installation points to a different clone; run the installer again');
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !manifest.files['plugins/ecc/index.js']) throw new Error('Invalid manifest');
    const { missing, modified } = inspectOwnedFiles(directory, manifest.files);
    if (missing) return result('installation', 'fail', `${missing} installed ECC file(s) are missing; run the installer again`);
    if (modified) return result('installation', 'warn', `${modified} installed ECC file(s) were customized; no files were changed`);
    return result('installation', 'pass', `${Object.keys(manifest.files).length} installed ECC files match their installation manifest`);
  } catch {
    return result('installation', 'fail', 'ECC installation manifest or owned files are invalid');
  }
}

async function checkShell(options, context) {
  const selected = configuredShell(options.project, options.configDir ? { ...context.env, OPENCODE_CONFIG_DIR: options.configDir } : context.env);
  const candidates = selected ? [selected] : process.platform === 'win32' ? ['pwsh', 'powershell', 'bash', 'cmd'] : ['bash'];
  for (const shell of candidates) {
    const name = path.basename(shell).replace(/\.exe$/i, '').toLowerCase();
    const args = ['pwsh', 'powershell'].includes(name) ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] : name === 'cmd' ? ['/d', '/c', 'ver'] : ['--version'];
    const checked = await commandCheck('shell', shell, args, context, () => true, 'Shell');
    if (checked.status === 'pass') return checked;
  }
  return result('shell', 'fail', 'Selected shell could not be checked; set a working shell in OpenCode config');
}

function configuredHookNode(options, env) {
  try {
    const directory = manifestDirectory(options, env);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'ecc-opencode-v2.install.json'), 'utf8'));
    const configured = manifest.installOptions?.node;
    if (typeof configured === 'string' && configured) return configured;
  } catch {
    return env.ECC_NODE || 'node';
  }
  return env.ECC_NODE || 'node';
}

export async function localDoctorChecks(options, { root, env, nodeVersion, runCommand = runDoctorCommand }) {
  const nodeMajor = Number(String(nodeVersion).split('.')[0]);
  const node = result('node', nodeMajor >= 20 ? 'pass' : 'fail', nodeMajor >= 20 ? `Node.js ${nodeVersion}` : 'Node.js 20 or newer is required');
  const context = { cwd: options.project, env, timeoutMs: options.timeoutMs, runCommand };
  const [opencode, gitCheck, shell, hookNode] = await Promise.all([
    commandCheck('opencode', options.opencode, ['--version'], context, ([major, minor, patch]) => major > 2 || (major === 2 && (minor > 0 || patch >= 32)), 'OpenCode'),
    commandCheck('git', 'git', ['--version'], context, () => true, 'Git'),
    checkShell(options, context),
    commandCheck('hook-node', configuredHookNode(options, env), ['--version'], context, ([major]) => major >= 20, 'Hook Node.js'),
  ]);
  return [node, opencode, gitCheck, shell, hookNode, checkConfig(options, env), checkHooks(root), checkSkills(root), checkInstallation(options, env, root)];
}
