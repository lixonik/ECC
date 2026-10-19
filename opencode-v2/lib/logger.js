import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const SIZE_CHECK_INTERVAL = 50;

export function createLogger(file, { maxBytes = DEFAULT_MAX_LOG_BYTES } = {}) {
  let writes = 0;
  const rotateIfLarge = () => {
    try {
      if (fs.statSync(file).size < maxBytes) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      return;
    }
  };
  const write = (level, message) => {
    try {
      if (writes % SIZE_CHECK_INTERVAL === 0) rotateIfLarge();
      writes += 1;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${String(message).replace(/\r?\n/g, '\n    ')}\n`);
    } catch {
      return;
    }
  };
  return {
    info: message => write('INFO', message),
    warn: message => write('WARN', message),
    error: message => write('ERROR', message),
  };
}
