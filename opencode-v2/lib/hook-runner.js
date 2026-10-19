import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 1024 * 1024;

export function runHookProcess({ argv, input, env, cwd, timeoutMs, nodePath = 'node' }) {
  const [program, ...args] = argv;
  const executable = program === 'node' ? nodePath : program;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, error: error.message });
      return;
    }
    const stdout = createCapture();
    const stderr = createCapture();
    let timedOut = false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    child.on('error', error => finish({ exitCode: null, stdout: stdout.text(), stderr: stderr.text(), timedOut, error: error.message }));
    child.on('close', code => finish({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
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
