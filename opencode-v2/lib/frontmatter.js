const FRONTMATTER_PATTERN = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const KEY_PATTERN = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+(.*)|\s*)$/;
const BLOCK_SCALAR_PATTERN = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/;

export function splitFrontmatter(text) {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) return { data: {}, body: text, present: false };
  return { data: parseYamlSubset(match[1]), body: text.slice(match[0].length), present: true };
}

export function parseYamlSubset(source) {
  const lines = source.split(/\r?\n/).map(raw => ({ raw, indent: indentOf(raw), blank: isBlank(raw) }));
  const start = nextContentLine(lines, 0);
  if (start >= lines.length) return {};
  return parseNode(lines, start, lines[start].indent).value ?? {};
}

function parseNode(lines, index, indent) {
  return isSequenceItem(lines[index].raw.trim())
    ? parseSequence(lines, index, indent)
    : parseMapping(lines, index, indent);
}

function parseMapping(lines, index, indent) {
  const result = {};
  let cursor = index;
  while (cursor < lines.length) {
    cursor = nextContentLine(lines, cursor);
    if (cursor >= lines.length || lines[cursor].indent < indent) break;
    if (lines[cursor].indent > indent) throw new Error(`Unexpected indentation: ${lines[cursor].raw}`);
    const match = KEY_PATTERN.exec(lines[cursor].raw.trim());
    if (!match) throw new Error(`Unsupported YAML line: ${lines[cursor].raw}`);
    const parsed = parseValue(lines, cursor, indent, match[2]);
    result[unquoteKey(match[1])] = parsed.value;
    cursor = parsed.next;
  }
  return { value: result, next: cursor };
}

function parseSequence(lines, index, indent) {
  const result = [];
  let cursor = index;
  while (cursor < lines.length) {
    cursor = nextContentLine(lines, cursor);
    if (cursor >= lines.length || lines[cursor].indent < indent) break;
    const trimmed = lines[cursor].raw.trim();
    if (lines[cursor].indent > indent || !isSequenceItem(trimmed)) break;
    const rest = trimmed.slice(1).trimStart();
    if (rest === '') {
      const child = nextContentLine(lines, cursor + 1);
      if (child < lines.length && lines[child].indent > indent) {
        const parsed = parseNode(lines, child, lines[child].indent);
        result.push(parsed.value);
        cursor = parsed.next;
      } else {
        result.push(null);
        cursor += 1;
      }
      continue;
    }
    const itemIndent = indent + (trimmed.length - rest.length);
    if (KEY_PATTERN.test(rest) && !/^["'[{]/.test(rest)) {
      const virtual = [...lines.slice(0, cursor), { raw: ' '.repeat(itemIndent) + rest, indent: itemIndent, blank: false }, ...lines.slice(cursor + 1)];
      const parsed = parseMapping(virtual, cursor, itemIndent);
      result.push(parsed.value);
      cursor = parsed.next;
      continue;
    }
    const parsed = parseValue(lines, cursor, indent, rest);
    result.push(parsed.value);
    cursor = parsed.next;
  }
  return { value: result, next: cursor };
}

function parseValue(lines, index, indent, rawValue) {
  const value = (rawValue ?? '').trim();
  if (value === '' || value.startsWith('#')) {
    const child = nextContentLine(lines, index + 1);
    if (child < lines.length && lines[child].indent > indent) return parseNode(lines, child, lines[child].indent);
    if (child < lines.length && lines[child].indent === indent && isSequenceItem(lines[child].raw.trim())) {
      return parseSequence(lines, child, indent);
    }
    return { value: null, next: index + 1 };
  }
  const block = BLOCK_SCALAR_PATTERN.exec(value);
  if (block) return parseBlockScalar(lines, index, indent, block);
  if (value.startsWith('[')) return { value: parseFlowSequence(value), next: index + 1 };
  if (value.startsWith('{')) return { value: parseFlowMapping(value), next: index + 1 };
  if (value.startsWith('"') || value.startsWith("'")) return { value: parseQuoted(value), next: index + 1 };
  return parsePlainScalar(lines, index, indent, value);
}

function parsePlainScalar(lines, index, indent, firstLine) {
  const parts = [stripComment(firstLine)];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.blank) {
      const next = nextContentLine(lines, cursor);
      if (next < lines.length && lines[next].indent > indent) {
        parts.push('\n');
        cursor = next;
        continue;
      }
      break;
    }
    if (line.indent <= indent) break;
    parts.push(stripComment(line.raw.trim()));
    cursor += 1;
  }
  const text = parts.reduce((joined, part) => {
    if (part === '\n') return `${joined}\n`;
    if (joined === '' || joined.endsWith('\n')) return joined + part;
    return `${joined} ${part}`;
  }, '');
  return { value: parts.length === 1 ? coerceScalar(text) : text, next: cursor };
}

function parseBlockScalar(lines, index, indent, [, style, chomping, explicitIndent]) {
  let cursor = index + 1;
  const firstContent = nextContentLine(lines, cursor);
  const blockIndent = explicitIndent
    ? indent + Number(explicitIndent)
    : firstContent < lines.length ? lines[firstContent].indent : indent + 1;
  const collected = [];
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line.blank && line.indent < blockIndent) break;
    if (!line.blank && line.indent <= indent) break;
    collected.push(line.blank ? '' : line.raw.slice(blockIndent));
    cursor += 1;
  }
  let trailingBlank = 0;
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop();
    trailingBlank += 1;
  }
  const body = style === '|' ? collected.join('\n') : foldLines(collected);
  if (chomping === '-') return { value: body, next: cursor };
  if (chomping === '+') return { value: `${body}\n${'\n'.repeat(trailingBlank)}`, next: cursor };
  return { value: body === '' ? '' : `${body}\n`, next: cursor };
}

function foldLines(collected) {
  let text = '';
  let previousWasText = false;
  for (const line of collected) {
    const moreIndented = /^\s/.test(line);
    if (line === '') {
      text += '\n';
      previousWasText = false;
    } else if (previousWasText && !moreIndented) {
      text += ` ${line}`;
    } else {
      text += (text === '' || text.endsWith('\n') ? '' : '\n') + line;
      previousWasText = !moreIndented;
    }
  }
  return text;
}

function parseFlowSequence(value) {
  const inner = value.trim().replace(/^\[/, '').replace(/\]\s*(?:#.*)?$/, '');
  return splitFlow(inner).map(item => (item.startsWith('"') || item.startsWith("'") ? parseQuoted(item) : coerceScalar(item)));
}

function parseFlowMapping(value) {
  const inner = value.trim().replace(/^\{/, '').replace(/\}\s*(?:#.*)?$/, '');
  return Object.fromEntries(splitFlow(inner).map(entry => {
    const separator = entry.indexOf(':');
    const key = unquoteKey(entry.slice(0, separator).trim());
    const raw = entry.slice(separator + 1).trim();
    return [key, raw.startsWith('"') || raw.startsWith("'") ? parseQuoted(raw) : coerceScalar(raw)];
  }));
}

function splitFlow(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\') {
        current += inner[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') items.push(current.trim());
  return items.filter(item => item !== '');
}

function parseQuoted(value) {
  const quote = value[0];
  if (quote === "'") {
    const end = findSingleQuoteEnd(value);
    return value.slice(1, end).replace(/''/g, "'");
  }
  const end = findDoubleQuoteEnd(value);
  return JSON.parse(value.slice(0, end + 1).replace(/\\'/g, "'").replace(/\t/g, '\\t'));
}

function findSingleQuoteEnd(value) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === "'") {
      if (value[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
  }
  throw new Error(`Unterminated single-quoted scalar: ${value}`);
}

function findDoubleQuoteEnd(value) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === '"') return i;
  }
  throw new Error(`Unterminated double-quoted scalar: ${value}`);
}

function coerceScalar(raw) {
  const value = stripComment(raw);
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(value)) return Number(value);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function stripComment(value) {
  const index = value.search(/\s#/);
  return (index === -1 ? value : value.slice(0, index)).trim();
}

function unquoteKey(key) {
  if (key.startsWith('"') || key.startsWith("'")) return parseQuoted(key);
  return key.trim();
}

function isSequenceItem(trimmed) {
  return trimmed === '-' || trimmed.startsWith('- ');
}

function indentOf(raw) {
  return raw.length - raw.trimStart().length;
}

function isBlank(raw) {
  return raw.trim() === '' || /^\s*#/.test(raw);
}

function nextContentLine(lines, index) {
  let cursor = index;
  while (cursor < lines.length && lines[cursor].blank) cursor += 1;
  return cursor;
}

export function stringifyFrontmatter(data) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    appendYaml(lines, key, value, 0);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

function appendYaml(lines, key, value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item && typeof item === 'object') {
        const entries = Object.entries(item).filter(([, nested]) => nested !== undefined);
        entries.forEach(([nestedKey, nestedValue], position) => {
          const prefix = position === 0 ? `${pad}  - ` : `${pad}    `;
          lines.push(`${prefix}${nestedKey}: ${formatScalar(nestedValue)}`);
        });
      } else {
        lines.push(`${pad}  - ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    lines.push(`${pad}${key}:`);
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) appendYaml(lines, nestedKey, nestedValue, indent + 2);
    }
    return;
  }
  lines.push(`${pad}${key}: ${formatScalar(value)}`);
}

function formatScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(String(value));
}
