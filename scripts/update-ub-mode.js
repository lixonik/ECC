#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const upstream = require('../skills/ub-mode/scripts/sync-upstream');
const { loadContextRegistry, loadSkillTriggers } = require('./lib/context-pack-registry');
const { digestObject, stableStringify } = require('./lib/context-profile-support');

const ROOT = path.resolve(__dirname, '..');
const USAGE = `Maintain the pinned ub-mode skill in an ECC Git checkout.

  npm run ub-mode:check
  npm run ub-mode:update
  node scripts/update-ub-mode.js --update --ref master --json

Successful updates refresh the context registry digest without replacing curated triggers.
Offline checks never fetch or write. Review the resulting diff and run validation before committing.
An installed standalone skill uses its own scripts/sync-upstream.js --update command.
`;

class MaintenanceFailure extends Error {}

function checkoutState(repoRoot, fileSystem) {
  if (!fileSystem.existsSync(path.join(repoRoot, '.git'))) throw new MaintenanceFailure('Run this command from an ECC Git checkout');
  const packageInfo = JSON.parse(fileSystem.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  if (packageInfo.name !== 'ecc-universal') throw new MaintenanceFailure('Run this command from an ECC Git checkout');
  const triggerFile = path.join(repoRoot, 'manifests/context-packs/skill-triggers@1.json');
  const before = fileSystem.readFileSync(triggerFile, 'utf8');
  const manifest = JSON.parse(before);
  if (manifest.schemaVersion !== 1 || !manifest.triggers || Array.isArray(manifest.triggers) || typeof manifest.triggers !== 'object') throw new MaintenanceFailure('The curated trigger manifest is invalid');
  const registry = loadContextRegistry({ repoRoot });
  const known = new Set(registry.entries.map(entry => entry.id));
  if (Object.keys(manifest.triggers).some(id => !known.has(id))) throw new MaintenanceFailure('The curated trigger manifest contains unknown skill IDs');
  return { triggerFile, before, manifest };
}

function refreshedManifest(repoRoot, manifest) {
  const registry = loadContextRegistry({ repoRoot });
  const { triggers } = loadSkillTriggers({ repoRoot });
  return {
    ...manifest,
    registryDigest: registry.registryDigest,
    coverage: { ...manifest.coverage, skills: registry.entries.length, withTriggers: Object.keys(triggers).length },
    triggersDigest: digestObject(triggers),
  };
}

function replaceMetadata(state, manifest, fileSystem) {
  const temporary = `${state.triggerFile}.${crypto.randomUUID()}.tmp`;
  try {
    if (fileSystem.readFileSync(state.triggerFile, 'utf8') !== state.before) throw new MaintenanceFailure('Curated triggers changed during the update; preserve that edit before retrying');
    fileSystem.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fileSystem.renameSync(temporary, state.triggerFile);
  } finally {
    fileSystem.rmSync(temporary, { force: true });
  }
}

async function run(input = {}, { repoRoot = ROOT, sync = upstream.run, fileSystem = fs } = {}) {
  const options = { action: 'check', ...input };
  let report;
  try {
    if (!['check', 'update'].includes(options.action)) throw new MaintenanceFailure('Use --check or --update');
    const state = checkoutState(repoRoot, fileSystem);
    report = await sync(options, { skillDir: path.join(repoRoot, 'skills/ub-mode') });
    if (!report.ok) return { ...report, registryUpdated: false };
    const next = refreshedManifest(repoRoot, state.manifest);
    const changed = stableStringify(next) !== stableStringify(state.manifest);
    if (changed && options.action === 'check') throw new MaintenanceFailure('The context registry metadata is stale; run npm run ub-mode:update');
    if (changed) replaceMetadata(state, next, fileSystem);
    return { ...report, registryUpdated: changed };
  } catch (error) {
    return { ok: false, updated: Boolean(report?.updated), registryUpdated: false, error: error instanceof MaintenanceFailure ? error.message : 'ub-mode maintenance could not complete; inspect checkout metadata and file access' };
  }
}

async function main() {
  let options;
  try { options = upstream.parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  const report = await run(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : report.ok ? `${report.message}\nContext metadata: ${report.registryUpdated ? 'refreshed' : 'unchanged'}` : report.error);
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { run };
if (require.main === module) main();
