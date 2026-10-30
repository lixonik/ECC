import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 });

async function git(directory, args, limits) {
  const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: directory,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    windowsHide: true,
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxOutputBytes,
    encoding: 'buffer',
  });
  return result.stdout;
}

function changedPaths(output) {
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(output)) throw new Error('Unsupported Git path encoding');
  const entries = decoded.split('\0');
  const files = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Invalid Git status response');
    files.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[++index];
      if (!original) throw new Error('Incomplete Git rename response');
      files.add(original);
    }
  }
  return [...files].sort();
}

async function safeFilePath(directory, relative) {
  const file = path.resolve(directory, relative);
  const inside = path.relative(directory, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Git reported a path outside the working tree');
  const parents = inside.split(path.sep).slice(0, -1);
  let parent = directory;
  for (const segment of parents) {
    parent = path.join(parent, segment);
    try {
      if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Cannot inspect a path through a symbolic link');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return file;
}

async function hashFile(file, limits, usage) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limits.maxFileBytes)) throw new Error('Working tree snapshot file byte limit exceeded');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      usage.bytes += bytesRead;
      if (size > limits.maxFileBytes || usage.bytes > limits.maxTotalBytes) throw new Error('Working tree snapshot byte limit exceeded');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Working tree changed during snapshot');
    return `${Number(after.mode & 0o111n)}:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

async function fileFingerprint(directory, relative, limits, usage) {
  const file = await safeFilePath(directory, relative);
  if (!file) return 'missing';
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) return `link:${await fs.readlink(file)}`;
  if (!stat.isFile()) throw new Error('Cannot inspect a non-file working tree entry');
  return hashFile(file, limits, usage);
}

async function currentHead(directory, limits) {
  try {
    return (await git(directory, ['rev-parse', '--verify', 'HEAD'], limits)).toString('utf8').trim();
  } catch (error) {
    if (error.code === 128 || error.code === 1) return null;
    throw error;
  }
}

async function committedPaths(directory, head, baselineHead, limits) {
  if (!head || head === baselineHead || baselineHead === undefined) return [];
  const args = baselineHead
    ? ['diff', '--name-only', '--no-renames', '-z', baselineHead, head, '--']
    : ['ls-files', '-z', '--cached'];
  return (await git(directory, args, limits)).toString('utf8').split('\0').filter(Boolean);
}

export async function readWorkingTreeSnapshot(projectDir, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const files = new Map();
  let directory = path.resolve(projectDir);
  try {
    directory = (await git(directory, ['rev-parse', '--show-toplevel'], limits)).toString('utf8').trim();
    const output = await git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules'], limits);
    const head = await currentHead(directory, limits);
    const changedSinceCommit = await committedPaths(directory, head, options.baselineHead, limits);
    const included = (options.includePaths ?? []).map(file => path.relative(directory, path.resolve(file)).split(path.sep).join('/'));
    const paths = [...new Set([...changedPaths(output), ...changedSinceCommit, ...included])].sort();
    if (paths.length > limits.maxFiles) throw new Error('Working tree snapshot file limit exceeded');
    const usage = { bytes: 0 };
    for (const relative of paths) files.set(relative, await fileFingerprint(directory, relative, limits, usage));
    return { directory, head, available: true, complete: true, files, diagnostic: '' };
  } catch (error) {
    const notRepository = /not a git repository/i.test(String(error.stderr ?? ''));
    return { directory, available: !notRepository, complete: notRepository, files, diagnostic: notRepository ? '' : String(error.message).split('\n')[0] };
  }
}
