import path from 'node:path';

export const DEFAULT_REVIEW_AGENT = 'code-reviewer';
export const REVIEW_GATE_FILE_LIMIT = 20;
const REVIEWER_ID = /(?:^|[-/])reviewer$/;

export function createReviewGate({ agent = DEFAULT_REVIEW_AGENT, projectDir }) {
  const turns = new Map();
  const turnOf = rootID => {
    if (!turns.has(rootID)) turns.set(rootID, { changed: new Set(), reviewed: false, fired: false });
    return turns.get(rootID);
  };
  return {
    agent,
    startTurn(rootID) {
      turns.set(rootID, { changed: new Set(), reviewed: false, fired: false });
    },
    recordChanges(rootID, filePaths) {
      const turn = turnOf(rootID);
      for (const filePath of filePaths) turn.changed.add(path.resolve(projectDir, filePath));
    },
    recordSubagent(rootID, agentID) {
      if (typeof agentID === 'string' && (agentID === agent || REVIEWER_ID.test(agentID))) turnOf(rootID).reviewed = true;
    },
    claim(rootID) {
      const turn = turnOf(rootID);
      if (turn.fired || turn.reviewed || turn.changed.size === 0) return null;
      turn.fired = true;
      return reviewGateMessage(agent, [...turn.changed], projectDir);
    },
  };
}

export function reviewGateMessage(agent, files, projectDir) {
  const shown = files.slice(0, REVIEW_GATE_FILE_LIMIT).map(file => {
    const relative = path.relative(projectDir, file);
    return `- ${relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file}`;
  });
  const more = files.length > REVIEW_GATE_FILE_LIMIT ? [`- ...and ${files.length - REVIEW_GATE_FILE_LIMIT} more`] : [];
  return [
    `Review gate: you changed ${files.length} file(s) in this turn:`,
    ...shown,
    ...more,
    '',
    `Before you finish, launch the \`${agent}\` subagent with the \`subagent\` tool and ask it to review exactly these changes (it can run \`git diff\` and read the files). Fix every CRITICAL and HIGH finding it reports, then finish with a short note on what the review found and what you changed.`,
  ].join('\n');
}
