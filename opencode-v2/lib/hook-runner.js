import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;

export function runHookProcess({ argv, input, env, cwd, timeoutMs, nodePath = 'node' }) {
  const [program, ...args] = argv;
  const executable = program === 'node' ? nodePath : program;
  const detached = process.platform !== 'win32';
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: error.message });
      return;
    }
    const stdout = createCapture();
    const stderr = createCapture();
    let timedOut = false;
    let settled = false;
    let graceTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, detached);
      graceTimer = setTimeout(() => finish({ exitCode: null, stdout: stdout.text(), stderr: stderr.text(), timedOut }), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    child.on('error', error => finish({ exitCode: null, stdout: stdout.text(), stderr: stderr.text(), timedOut, error: error.message }));
    child.on('close', code => finish({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function killTree(child, detached) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    process.kill(detached ? -child.pid : child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function createCapture() {
  const chunks = [];
  let size = 0;
  return {
    push: chunk => {
      if (size >= MAX_CAPTURE_BYTES) return;
      const slice = chunk.subarray(0, MAX_CAPTURE_BYTES - size);
      chunks.push(slice);
      size += slice.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}
