// A reader for the small subset of YAML that agent settings files use: block
// mappings, block sequences, plain and quoted scalars, and comments. Anything
// else (flow collections, anchors, tags, block scalars, several documents) is
// refused with the line it appears on, so a value is never guessed.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.code = 'yaml-unsupported';
    this.line = line;
  }
}

/** Removes a trailing comment that is outside quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1;
        else quote = null;
      } else if (ch === '\\' && quote === '"') {
        i += 1;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function lex(text) {
  const lines = [];
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  raw.forEach((line, index) => {
    const number = index + 1;
    if (/^\s*(#.*)?$/.test(line)) return;
    if (/^\t/.test(line) || /^ *\t/.test(line)) throw new YamlError('tabs are not allowed for indentation', number);
    if (line.trim() === '---') {
      if (lines.length > 0) throw new YamlError('several documents are not supported', number);
      return;
    }
    const indent = line.length - line.trimStart().length;
    const content = stripComment(line.trimStart());
    if (content === '') return;
    lines.push({ indent, content, number });
  });
  return lines;
}

function unquoteDouble(body, number) {
  return body.replace(/\\(.)/g, (whole, ch) => {
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
    if (!(ch in map)) throw new YamlError(`unsupported escape \\${ch}`, number);
    return map[ch];
  });
}

/** A scalar value: quoted strings, null, booleans, numbers or plain text. */
function scalar(text, number) {
  const value = text.trim();
  if (value === '') return null;
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new YamlError('unterminated double-quoted string', number);
    return unquoteDouble(value.slice(1, -1), number);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new YamlError('unterminated single-quoted string', number);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === '[]') return [];
  if (value === '{}') return {};
  if (/^[[{&*!|>%@`]/.test(value)) throw new YamlError(`unsupported value "${value}"`, number);
  if (/^(?:~|null|Null|NULL)$/.test(value)) return null;
  if (/^(?:true|True|TRUE)$/.test(value)) return true;
  if (/^(?:false|False|FALSE)$/.test(value)) return false;
  if (/^[-+]?\d+$/.test(value)) return Number(value);
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Splits `key: value` (or `key:`) outside quotes; null when the line is not a mapping entry. */
function splitKey(content, number) {
  let key;
  let rest;
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content[0];
    let end = 1;
    for (; end < content.length; end += 1) {
      if (content[end] === '\\' && quote === '"') {
        end += 1;
        continue;
      }
      if (content[end] === quote) {
        if (quote === "'" && content[end + 1] === "'") {
          end += 1;
          continue;
        }
        break;
      }
    }
    if (end >= content.length) throw new YamlError('unterminated quoted key', number);
    key = scalar(content.slice(0, end + 1), number);
    rest = content.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    rest = rest.slice(1);
    if (rest !== '' && !/^\s/.test(rest)) return null;
  } else {
    const match = /^([^:]*?)\s*:(?:\s+|$)/.exec(content);
    if (!match) return null;
    key = match[1];
    if (key === '' || /^[[{&*!|>%@`]/.test(key) || key.startsWith('? ')) {
      throw new YamlError(`unsupported key "${key}"`, number);
    }
    rest = content.slice(match[0].length);
  }
  return { key: String(key), value: rest.trim() };
}

function isItem(content) {
  return content === '-' || content.startsWith('- ');
}

/**
 * Parses YAML text in the supported subset into plain values.
 * @throws {YamlError} with code `yaml-unsupported` and the line number
 */
export function parseYaml(text) {
  const lines = lex(String(text ?? ''));
  if (lines.length === 0) return null;
  let pos = 0;

  function block(indent) {
    const line = lines[pos];
    if (isItem(line.content)) return sequence(indent);
    if (splitKey(line.content, line.number)) return mapping(indent);
    if (lines.length === 1 && indent === 0) {
      pos += 1;
      return scalar(line.content, line.number);
    }
    throw new YamlError(`expected "key: value" or "- item", found "${line.content}"`, line.number);
  }

  /** The value after `key:` or `- ` when it is on the following lines. */
  function nested(parentIndent, number, allowSameIndentSequence) {
    const next = lines[pos];
    if (!next) return null;
    if (next.indent > parentIndent) return block(next.indent);
    if (allowSameIndentSequence && next.indent === parentIndent && isItem(next.content)) return sequence(parentIndent);
    return null;
  }

  function mapping(indent) {
    const result = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.number);
      if (isItem(line.content)) break;
      const entry = splitKey(line.content, line.number);
      if (!entry) throw new YamlError(`expected "key: value", found "${line.content}"`, line.number);
      if (Object.hasOwn(result, entry.key)) throw new YamlError(`duplicate key "${entry.key}"`, line.number);
      pos += 1;
      if (entry.value === '') {
        result[entry.key] = nested(indent, line.number, true);
      } else {
        if (entry.value === '|' || entry.value === '>' || /^[|>][-+0-9]*$/.test(entry.value)) {
          throw new YamlError('block scalars are not supported', line.number);
        }
        result[entry.key] = scalar(entry.value, line.number);
      }
    }
    return result;
  }

  function sequence(indent) {
    const result = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.number);
      if (!isItem(line.content)) break;
      const rest = line.content === '-' ? '' : line.content.slice(2).trimStart();
      if (rest === '') {
        pos += 1;
        result.push(nested(indent, line.number, false));
        continue;
      }
      const itemIndent = indent + (line.content.length - rest.length);
      if (isItem(rest) || splitKey(rest, line.number)) {
        // The item's first line continues as a block at the column it starts in.
        lines[pos] = { indent: itemIndent, content: rest, number: line.number };
        result.push(block(itemIndent));
        continue;
      }
      pos += 1;
      result.push(scalar(rest, line.number));
    }
    return result;
  }

  const value = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError('unexpected content', lines[pos].number);
  return value;
}
