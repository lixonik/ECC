import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createTranscriptMirror(directory, { cwd } = {}) {
  const lastUuid = new Map();
  let prepared = false;

  const pathFor = sessionID => path.join(directory, `${String(sessionID).replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);

  const append = (sessionID, record) => {
    if (!prepared) {
      fs.mkdirSync(directory, { recursive: true });
      prepared = true;
    }
    const uuid = randomUUID();
    const line = {
      parentUuid: lastUuid.get(sessionID) ?? null,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId: sessionID,
      version: 'opencode-v2',
      uuid,
      timestamp: new Date().toISOString(),
      ...record,
    };
    fs.appendFileSync(pathFor(sessionID), `${JSON.stringify(line)}\n`);
    lastUuid.set(sessionID, uuid);
    return uuid;
  };

  return {
    pathFor,
    userPrompt(sessionID, text) {
      return append(sessionID, { type: 'user', message: { role: 'user', content: text } });
    },
    toolUse(sessionID, { messageID, model, callID, name, input }) {
      return append(sessionID, {
        type: 'assistant',
        message: { id: messageID, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: callID, name, input }] },
      });
    },
    toolResult(sessionID, { callID, text, isError }) {
      return append(sessionID, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callID, content: text, is_error: Boolean(isError) }] },
      });
    },
    assistantText(sessionID, { messageID, model, text }) {
      return append(sessionID, {
        type: 'assistant',
        message: { id: messageID, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] },
      });
    },
    usage(sessionID, { messageID, model, tokens, cost }) {
      return append(sessionID, {
        type: 'assistant',
        costUSD: typeof cost === 'number' ? cost : undefined,
        message: {
          id: messageID,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: {
            input_tokens: tokens?.input ?? 0,
            output_tokens: (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
            cache_read_input_tokens: tokens?.cache?.read ?? 0,
            cache_creation_input_tokens: tokens?.cache?.write ?? 0,
          },
        },
      });
    },
    compactBoundary(sessionID) {
      return append(sessionID, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
    },
  };
}
