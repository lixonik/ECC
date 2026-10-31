const { spawn } = require('node:child_process');

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 2000;

function stopTree(child) {
  if (!child.pid) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return Promise.resolve(true);
    } catch (error) {
      return Promise.resolve(error.code === 'ESRCH');
    }
  }
  return new Promise(resolve => {
    const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { cleanup.kill(); resolve(false); }, CLEANUP_TIMEOUT_MS);
    cleanup.once('error', () => { clearTimeout(timer); resolve(false); });
    cleanup.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

function runCommand(argv, { cwd, timeoutMs, input } = {}) {
  return new Promise(resolve => {
    const output = { stdout: [], stderr: [] };
    let size = 0;
    let settled = false;
    let timedOut = false;
    let outputLimit = false;
    let stopping;
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, PYTHONUTF8: '1' }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (exitCode, cleanupConfirmed = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ exitCode, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), timedOut, outputLimit, cleanupConfirmed });
    };
    const stop = () => {
      if (stopping) return;
      stopping = stopTree(child).then(confirmed => finish(null, confirmed));
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { outputLimit = true; stop(); return; }
      output[stream].push(chunk);
    });
    child.once('error', () => finish(null, false));
    child.once('close', code => { if (!stopping) finish(code); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

module.exports = { runCommand };
