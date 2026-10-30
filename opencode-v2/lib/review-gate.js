import path from 'node:path';
import { readWorkingTreeSnapshot } from './working-tree.js';

export const DEFAULT_REVIEW_AGENT = 'code-reviewer';
export const REVIEW_GATE_FILE_LIMIT = 20;
const REVIEWER_ID = /(?:^|[-/])reviewer$/;

function normalizeSnapshot(snapshot, projectDir) {
  const directory = snapshot.directory ?? projectDir;
  return { ...snapshot, files: new Map([...snapshot.files].map(([file, hash]) => [path.resolve(directory, file), hash])) };
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
}

export function createReviewGate({ agent = DEFAULT_REVIEW_AGENT, projectDir, readSnapshot = options => readWorkingTreeSnapshot(projectDir, options) }) {
  const turns = new Map();
  const snapshot = async options => {
    try {
      return normalizeSnapshot(await readSnapshot(options), projectDir);
    } catch (error) {
      return { available: true, complete: false, files: new Map(), diagnostic: error.message };
    }
  };
  const createTurn = () => ({ baseline: snapshot(), explicit: new Set(), revision: 0, reviews: new Map(), approved: null, prompted: new Set() });
  const turnOf = rootID => {
    if (!turns.has(rootID)) turns.set(rootID, createTurn());
    return turns.get(rootID);
  };
  const inspect = async turn => {
    const before = await turn.baseline;
    const current = await snapshot({ includePaths: [...before.files.keys()], baselineHead: before.head });
    const paths = [...new Set([...turn.explicit, ...changedFiles(before.files, current.files)])].sort();
    const diagnostic = [before, current].filter(item => !item.complete).map(item => item.diagnostic).filter(Boolean).join('; ');
    const complete = before.complete && current.complete;
    const fingerprint = JSON.stringify([turn.revision, paths.map(file => [file, current.files.get(file)]), diagnostic]);
    return { paths, fingerprint, complete, diagnostic };
  };
  return {
    agent,
    async startTurn(rootID) {
      const turn = createTurn();
      turns.set(rootID, turn);
      await turn.baseline;
    },
    async recordChanges(rootID, filePaths) {
      const turn = turnOf(rootID);
      for (const filePath of filePaths) turn.explicit.add(path.resolve(projectDir, filePath));
      if (filePaths.length > 0) turn.revision += 1;
    },
    async beginReview(rootID, callID, agentID) {
      if (typeof agentID !== 'string' || (agentID !== agent && !REVIEWER_ID.test(agentID))) return;
      const turn = turnOf(rootID);
      const current = await inspect(turn);
      if (turns.get(rootID) !== turn) return;
      turn.prompted.delete(current.fingerprint);
      if (current.paths.length > 0 && current.complete) turn.reviews.set(callID, current.fingerprint);
    },
    async completeReview(rootID, callID, status) {
      const turn = turnOf(rootID);
      const started = turn.reviews.get(callID);
      turn.reviews.delete(callID);
      if (!started) return;
      if (status !== 'completed') {
        turn.prompted.delete(started);
        return;
      }
      const current = await inspect(turn);
      if (turns.get(rootID) === turn && current.complete && current.fingerprint === started) turn.approved = current.fingerprint;
    },
    async claim(rootID) {
      const turn = turnOf(rootID);
      const current = await inspect(turn);
      if (turns.get(rootID) !== turn || (current.paths.length === 0 && current.complete) || turn.approved === current.fingerprint || turn.prompted.has(current.fingerprint)) return null;
      turn.prompted.add(current.fingerprint);
      if (!current.complete) return `Review gate could not inspect the complete working tree: ${current.diagnostic || 'incomplete snapshot'}. Resolve this inspection failure and have the reviewer check the final changes before finishing.`;
      return reviewGateMessage(agent, current.paths, projectDir);
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
