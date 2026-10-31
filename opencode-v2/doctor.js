#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDoctorChecks } from './lib/doctor-checks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALUE_FLAGS = Object.freeze({ '--project': 'project', '--config-dir': 'configDir', '--opencode': 'opencode', '--base-url': 'baseURL', '--model': 'model', '--api-key-env': 'apiKeyEnv', '--thinking': 'thinking', '--reasoning-effort': 'reasoningEffort', '--timeout-ms': 'timeoutMs' });
const USAGE = `Usage: node opencode-v2/doctor.js [options]

Local checks:
  --project <dir>       project directory (default: current directory)
  --config-dir <dir>    ECC installation and config directory
  --opencode <path>     OpenCode executable (default: opencode)
  --json               print a structured diagnostic report

Optional endpoint check:
  --probe              send two synthetic tool-calling requests
  --base-url <url>      OpenAI-compatible API base URL, usually ending in /v1
  --model <id>          model ID expected by that endpoint
  --api-key-env <name>  read a bearer token from this environment variable
  --thinking on|off    send an explicit thinking setting
  --reasoning-effort low|high|max
  --timeout-ms <ms>     diagnostic timeout, 1..120000 (default: 15000)
  --help               show this help
`;

export function parseDoctorArgs(argv) {
  const options = { project: path.resolve(process.cwd()), opencode: 'opencode', json: false, probe: false, help: false, timeoutMs: 15000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--json', '--probe', '--help'].includes(flag)) { options[flag.slice(2)] = true; continue; }
    if (!Object.hasOwn(VALUE_FLAGS, flag)) throw new Error('Unknown option; use --help for supported flags');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    options[VALUE_FLAGS[flag]] = value;
  }
  options.project = path.resolve(options.project);
  if (options.configDir) options.configDir = path.resolve(options.configDir);
  options.timeoutMs = Number(options.timeoutMs);
  validateDoctorOptions(options);
  return options;
}

function validateDoctorOptions(options) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw new Error('--timeout-ms must be an integer from 1 to 120000');
  if (options.thinking && !['on', 'off'].includes(options.thinking)) throw new Error('--thinking must be on or off');
  if (options.reasoningEffort && !['low', 'high', 'max'].includes(options.reasoningEffort)) throw new Error('--reasoning-effort must be low, high or max');
  if (options.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) throw new Error('--api-key-env must name an environment variable');
  if (!options.help && options.probe && (!options.baseURL || !options.model)) throw new Error('--probe requires --base-url and --model');
  if (!options.probe && ['baseURL', 'model', 'apiKeyEnv', 'thinking', 'reasoningEffort'].some(key => options[key] !== undefined)) throw new Error('Endpoint options require --probe');
}

async function endpointChecks(options, env) {
  const apiKey = options.apiKeyEnv ? env[options.apiKeyEnv] : undefined;
  if (options.apiKeyEnv && !apiKey) return [{ id: 'model.credentials', status: 'fail', message: 'The API key environment variable is empty' }];
  const { probeModel } = await import('./lib/model-probe.js');
  const report = await probeModel({ baseURL: options.baseURL, model: options.model, apiKey, thinking: options.thinking, reasoningEffort: options.reasoningEffort, timeoutMs: options.timeoutMs });
  if (!report.ok || options.thinking !== 'on') return report.checks;
  const reasoning = report.reasoningObserved
    ? { id: 'model.reasoning', status: 'pass', message: 'Reasoning content was observed and preserved across the tool round-trip' }
    : { id: 'model.reasoning', status: 'warn', message: 'Thinking was requested but no reasoning content was observed; confirm endpoint support' };
  return [...report.checks, reasoning];
}

export async function runDoctor(options, { root = ROOT, env = process.env, nodeVersion = process.versions.node, runCommand } = {}) {
  const checks = await localDoctorChecks(options, { root, env, nodeVersion, runCommand });
  if (options.probe) checks.push(...await endpointChecks(options, env));
  const summary = { passed: checks.filter(check => check.status === 'pass').length, warnings: checks.filter(check => check.status === 'warn').length, failed: checks.filter(check => check.status === 'fail').length };
  return { ok: summary.failed === 0, checks, summary };
}

async function main() {
  let options;
  try {
    options = parseDoctorArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ECC doctor: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) { console.log(USAGE); return; }
  try {
    const report = await runDoctor(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) console.log(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
      console.log(`Passed: ${report.summary.passed}; warnings: ${report.summary.warnings}; failed: ${report.summary.failed}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.error('ECC doctor could not complete; inspect local file access and executable configuration');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
