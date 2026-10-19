const HEADER = /^\*\*\* (Add|Delete|Update) File: (.+?)\s*$/;
const MOVE = /^\*\*\* Move to: (.+?)\s*$/;

export function parsePatchOperations(patchText) {
  const operations = [];
  let current = null;
  let hunk = null;

  const closeHunk = () => {
    if (current?.type === 'update' && hunk && (hunk.old.length > 0 || hunk.new.length > 0)) {
      current.hunks.push({ oldText: hunk.old.join('\n'), newText: hunk.new.join('\n') });
    }
    hunk = null;
  };

  for (const line of String(patchText ?? '').split(/\r?\n/)) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** End of File')) {
      closeHunk();
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      closeHunk();
      current = { type: header[1].toLowerCase(), path: header[2].trim() };
      if (current.type === 'add') current.lines = [];
      if (current.type === 'update') current.hunks = [];
      operations.push(current);
      continue;
    }
    if (!current) continue;
    const move = MOVE.exec(line);
    if (move && current.type === 'update') {
      current.moveTo = move[1].trim();
      continue;
    }
    if (current.type === 'add') {
      if (line.startsWith('+')) current.lines.push(line.slice(1));
      continue;
    }
    if (current.type !== 'update') continue;
    if (line.startsWith('@@')) {
      closeHunk();
      hunk = { old: [], new: [] };
      continue;
    }
    hunk ??= { old: [], new: [] };
    if (line.startsWith('-')) hunk.old.push(line.slice(1));
    else if (line.startsWith('+')) hunk.new.push(line.slice(1));
    else if (line.startsWith(' ') || line === '') {
      hunk.old.push(line.slice(1));
      hunk.new.push(line.slice(1));
    }
  }
  closeHunk();

  return operations.map(operation => (operation.type === 'add'
    ? { type: 'add', path: operation.path, content: operation.lines.join('\n') + (operation.lines.length > 0 ? '\n' : '') }
    : operation));
}
