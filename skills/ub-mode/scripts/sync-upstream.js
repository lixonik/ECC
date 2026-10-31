#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const REPOSITORY = 'https://github.com/unclebob/ub-mode';
const SNAPSHOT_PATH = 'references/upstream-skill.md';
const MAX_DOCUMENT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const USAGE = `Usage: node skills/ub-mode/scripts/sync-upstream.js [options]

  --check             validate the pinned snapshot locally (default; no network)
  --update            resolve the upstream ref and refresh the owned snapshot
  --ref <ref>         branch, tag or commit to follow (default: pinned ref)
  --timeout-ms <ms>   total update deadline, 1..120000 (default: 15000)
  --json              print a structured report
  --help              show this help

Updates change upstream.json and references/upstream-skill.md only.
The ECC SKILL.md adaptation is kept separately and is never overwritten.
`;

class SyncFailure extends Error {}

function hasAsciiControl(value, multiline = false) {
  return [...value].some(char => {
    const point = char.codePointAt(0);
    return (point < 32 || point === 127) && !(multiline && [9, 10, 13].includes(point));
  });
}

function validRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && ref.length <= 256 && !hasAsciiControl(ref);
}

function validateOptions(options) {
  if (!['check', 'update'].includes(options.action)) throw new SyncFailure('Use --check or --update.');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw new SyncFailure('--timeout-ms must be an integer from 1 to 120000.');
  if (options.ref !== undefined && (!validRef(options.ref) || options.action !== 'update')) throw new SyncFailure('--ref needs a valid upstream ref and --update.');
}

function parseArgs(argv) {
  const options = { action: 'check', timeoutMs: DEFAULT_TIMEOUT_MS, json: false, help: false };
  let selected;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--check', '--update'].includes(flag)) {
      if (selected && selected !== flag) throw new SyncFailure('Choose either --check or --update.');
      selected = flag;
      options.action = flag.slice(2);
    } else if (['--json', '--help'].includes(flag)) options[flag.slice(2)] = true;
    else if (['--ref', '--timeout-ms'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new SyncFailure(`${flag} needs a value.`);
      options[flag === '--ref' ? 'ref' : 'timeoutMs'] = flag === '--ref' ? value : Number(value);
    } else throw new SyncFailure('Unknown option; use --help.');
  }
  validateOptions(options);
  return options;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validateManifest(manifest) {
  const valid = manifest && manifest.schemaVersion === 1 && manifest.repository === REPOSITORY
    && manifest.path === 'SKILL.md' && validRef(manifest.ref)
    && /^[a-f0-9]{40}$/.test(manifest.commit) && /^[a-f0-9]{64}$/.test(manifest.sha256);
  if (!valid) throw new SyncFailure('Invalid ub-mode provenance metadata.');
}

function validateSnapshot(bytes) {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new SyncFailure('The upstream document exceeds the byte limit.');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SyncFailure('The upstream document is not valid UTF-8.'); }
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatter || !/^name:[ \t]*(?:ub-mode|"ub-mode"|'ub-mode')[ \t]*\r?$/m.test(frontmatter[1]) || !frontmatter[2].trim()) throw new SyncFailure('The upstream document is not the ub-mode skill.');
  if (hasAsciiControl(source, true) || /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(source)) throw new SyncFailure('The upstream document contains unsupported control characters.');
  if (/[\u2014\u2192\u00ab\u00bb]/.test(source)) throw new SyncFailure('Upstream typography conflicts with project rules; inspect the document before updating.');
}

function readFile(fileSystem, file, maxBytes) {
  const stat = fileSystem.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new SyncFailure('Owned upstream files must be regular files within the byte limit.');
  return fileSystem.readFileSync(file);
}

function validateReferenceDirectory(fileSystem, directory) {
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SyncFailure('The upstream references directory must be a regular directory.');
}

function readState(skillDir, fileSystem) {
  try {
    const manifestFile = path.join(skillDir, 'upstream.json');
    const snapshotFile = path.join(skillDir, SNAPSHOT_PATH);
    validateReferenceDirectory(fileSystem, path.dirname(snapshotFile));
    const manifestBytes = readFile(fileSystem, manifestFile, 16384);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    validateManifest(manifest);
    const snapshotBytes = readFile(fileSystem, snapshotFile, MAX_DOCUMENT_BYTES);
    validateSnapshot(snapshotBytes);
    if (sha256(snapshotBytes) !== manifest.sha256) throw new SyncFailure('The upstream snapshot checksum changed locally; preserve or restore that edit before updating.');
    return { manifest, manifestFile, snapshotFile, manifestBytes, snapshotBytes };
  } catch (error) {
    if (error instanceof SyncFailure) throw error;
    throw new SyncFailure('ub-mode provenance metadata or snapshot could not be read.');
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new SyncFailure('The upstream update timed out.')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function responseBytes(response, signal, budget) {
  if (!response.ok) throw new SyncFailure(`Upstream returned HTTP ${response.status}.`);
  if (!response.body) throw new SyncFailure('Upstream returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return Buffer.concat(chunks);
      budget.bytes += value.byteLength;
      if (budget.bytes > MAX_DOCUMENT_BYTES + 16384) throw new SyncFailure('The upstream response exceeds the byte limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchBytes(url, context) {
  const response = await abortable(context.fetcher(url, { redirect: 'error', signal: context.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'ecc-ub-mode-sync' } }), context.signal);
  return responseBytes(response, context.signal, context.budget);
}

async function fetchUpdate(ref, context) {
  const commitBytes = await fetchBytes(`https://api.github.com/repos/unclebob/ub-mode/commits/${encodeURIComponent(ref)}`, context);
  let commit;
  try { commit = JSON.parse(commitBytes.toString('utf8')).sha; }
  catch { throw new SyncFailure('Upstream returned invalid commit metadata.'); }
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new SyncFailure('Upstream returned an invalid commit revision.');
  const bytes = await fetchBytes(`https://raw.githubusercontent.com/unclebob/ub-mode/${commit}/SKILL.md`, context);
  validateSnapshot(bytes);
  return { commit, bytes };
}

function replacePair(state, manifestBytes, snapshotBytes, fileSystem) {
  validateReferenceDirectory(fileSystem, path.dirname(state.snapshotFile));
  const targets = [
    { file: state.snapshotFile, before: state.snapshotBytes, after: snapshotBytes },
    { file: state.manifestFile, before: state.manifestBytes, after: manifestBytes },
  ].map(entry => ({ ...entry, temporary: `${entry.file}.${crypto.randomUUID()}.tmp` }));
  for (const entry of targets) {
    if (!readFile(fileSystem, entry.file, MAX_DOCUMENT_BYTES).equals(entry.before)) throw new SyncFailure('Owned upstream files changed while fetching; preserve that edit before updating.');
  }
  const replaced = [];
  let failure;
  try {
    for (const entry of targets) fileSystem.writeFileSync(entry.temporary, entry.after, { flag: 'wx' });
    for (const entry of targets) { fileSystem.renameSync(entry.temporary, entry.file); replaced.push(entry); }
  } catch {
    failure = 'The upstream update could not replace its owned files.';
    for (const entry of replaced) {
      try { fileSystem.writeFileSync(entry.file, entry.before); }
      catch { failure = 'Upstream rollback failed; run --check and restore the pinned files before retrying.'; }
    }
  } finally {
    for (const entry of targets) {
      try { fileSystem.rmSync(entry.temporary, { force: true }); }
      catch { failure = 'An upstream staging file could not be cleaned up; inspect the skill directory.'; }
    }
  }
  if (failure) throw new SyncFailure(failure);
}

async function updateState(state, options, context) {
  const ref = options.ref ?? state.manifest.ref;
  const fetched = await fetchUpdate(ref, context);
  const manifest = { schemaVersion: 1, repository: REPOSITORY, ref, commit: fetched.commit, path: 'SKILL.md', sha256: sha256(fetched.bytes) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const unchanged = manifestBytes.equals(state.manifestBytes) && fetched.bytes.equals(state.snapshotBytes);
  if (context.signal.aborted) throw new SyncFailure('The upstream update timed out.');
  if (!unchanged) replacePair(state, manifestBytes, fetched.bytes, context.fileSystem);
  return { ok: true, updated: !unchanged, commit: manifest.commit, ref, message: unchanged ? 'The pinned upstream skill is unchanged.' : 'Updated the pinned upstream skill; review the diff and run repository validation before committing.' };
}

async function run(input = {}, dependencies = {}) {
  const options = { action: 'check', timeoutMs: DEFAULT_TIMEOUT_MS, ...input };
  const fileSystem = dependencies.fileSystem ?? fs;
  const controller = new AbortController();
  let timer;
  try {
    validateOptions(options);
    const state = readState(dependencies.skillDir ?? path.resolve(__dirname, '..'), fileSystem);
    if (options.action === 'check') return { ok: true, updated: false, commit: state.manifest.commit, ref: state.manifest.ref, message: 'The pinned upstream skill matches its provenance checksum.' };
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
    return await updateState(state, options, { fetcher: dependencies.fetcher ?? globalThis.fetch, signal: controller.signal, budget: { bytes: 0 }, fileSystem });
  } catch (error) {
    return { ok: false, updated: false, error: controller.signal.aborted ? 'The upstream update timed out.' : error instanceof SyncFailure ? error.message : 'The upstream update failed; inspect network, TLS and local file access.' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  const report = await run(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : report.ok ? `${report.message}\nCommit: ${report.commit}` : `ub-mode sync: ${report.error}`);
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { parseArgs, run };
if (require.main === module) main().catch(() => { console.error('ub-mode sync could not complete.'); process.exitCode = 1; });
