import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { decodeIdentifierBytes } from './utf8';

function fail(node: Node, message: string): never {
  throw new CompileError([{ row: node.startPosition.row, message }]);
}

export function validateCommentText(root: Node): void {
  const source = root.text;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as Node;
    if (node.type === 'comment' || node.type === 'doc_comment' || node.type === 'container_doc_comment') {
      const text = node.text.endsWith('\r') && source[node.endIndex] === '\n' ? node.text.slice(0, -1) : node.text;
      validateRawText(text.replaceAll(/\r?\n/g, ''), node);
    } else {
      for (const child of node.namedChildren) pending.push(child);
    }
  }
}

export class LiteralDecoder {
  private allocated = 0;

  decodeIdentifier(node: Node): string {
    if (!node.text.startsWith('@')) return node.text;
    const bytes = this.decodeQuoted(node);
    if (bytes.length === 0) fail(node, '名前を空にはできません。');
    if (bytes.includes(0)) fail(node, '名前に NUL 文字は使えません。');
    return decodeIdentifierBytes(bytes);
  }

  decodeString(node: Node): number[] {
    if (node.type !== 'multiline_string') return this.decodeQuoted(node);
    const bytes: number[] = [];
    let first = true;
    for (const line of node.text.split(/\r?\n/)) {
      const prefix = /^[ \t]*\\\\/.exec(line);
      if (!prefix) continue;
      if (!first) this.appendBytes(bytes, [10]);
      first = false;
      this.appendText(bytes, line.slice(prefix[0].length), node);
    }
    return bytes;
  }

  decodeCharacter(node: Node): bigint {
    const content = node.namedChildren.find(
      (part) => part.type === 'character_content' || part.type === 'escape_sequence'
    );
    if (!content) fail(node, '文字のリテラルが空です。');
    validateRawText(content.text, content);
    return BigInt(
      content.type === 'escape_sequence' ? escapeValue(content.text, content) : (content.text.codePointAt(0) as number)
    );
  }

  private decodeQuoted(node: Node): number[] {
    const bytes: number[] = [];
    for (const part of node.namedChildren) {
      if (part.type === 'string') return this.decodeQuoted(part);
      if (part.type === 'string_content') this.appendText(bytes, part.text, part);
      else if (part.type === 'escape_sequence') {
        validateRawText(part.text, part);
        this.appendBytes(bytes, escapeBytes(part.text, part, true));
      }
    }
    return bytes;
  }

  private appendText(bytes: number[], text: string, node: Node): void {
    if (this.allocated + text.length > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
    validateRawText(text, node);
    let length = 0;
    for (const character of text) {
      const point = character.codePointAt(0) as number;
      length += point <= 0x7f ? 1 : point <= 0x7_ff ? 2 : point <= 0xff_ff ? 3 : 4;
    }
    this.reserve(length);
    for (const byte of new TextEncoder().encode(text)) bytes.push(byte);
  }

  private appendBytes(bytes: number[], decoded: readonly number[]): void {
    this.reserve(decoded.length);
    for (const byte of decoded) bytes.push(byte);
  }

  private reserve(length: number): void {
    this.allocated += length;
    if (this.allocated > LIMITS.maxSlots) throw new ExecutionLimitError('storage');
  }
}

function validateRawText(text: string, node: Node): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) as number;
    if (code < 0x20 || code === 0x7f) fail(node, 'そのまま書けない制御文字があります。');
  }
}

/** The bytes an escape sequence stands for in a string: `\u{...}` is UTF-8 encoded. */
function escapeBytes(text: string, node: Node, inString: boolean): number[] {
  if (text.startsWith(String.raw`\u`)) {
    const value = escapeValue(text, node);
    if (inString && value >= 0xd8_00 && value <= 0xdf_ff) {
      fail(node, String.raw`\u{...} のコードポイントが、Unicode の文字として正しくありません。`);
    }
    return [...new TextEncoder().encode(String.fromCodePoint(value))];
  }
  return [escapeValue(text, node)];
}

function escapeValue(text: string, node: Node): number {
  const kind = text[1];
  switch (kind) {
    case 'n': {
      return 0x0a;
    }
    case 'r': {
      return 0x0d;
    }
    case '\\': {
      return 0x5c;
    }
    case 't': {
      return 0x09;
    }
    case "'": {
      return 0x27;
    }
    case '"': {
      return 0x22;
    }
    case 'x': {
      if (!/^\\x[\da-f]{2}$/i.test(text))
        fail(node, `エスケープ ${text} が正しくありません（\\x の後には16進数を2桁書きます）。`);
      return Number.parseInt(text.slice(2), 16);
    }
    case 'u': {
      const match = /^\\u\{([\da-f]{1,6})\}$/i.exec(text);
      if (!match) fail(node, `エスケープ ${text} が正しくありません（\\u{3042} のように書きます）。`);
      const value = Number.parseInt(match[1], 16);
      if (value > 0x10_ff_ff) fail(node, String.raw`\u{...} のコードポイントが大きすぎます。`);
      return value;
    }
    default: {
      return fail(node, `エスケープ ${text} は使えません。`);
    }
  }
}

/** An integer literal's value, rejecting what `std.zig.number_literal` rejects. */
export function parseIntegerText(text: string, node: Node): bigint {
  checkNumber(text, node);
  const clean = text.replaceAll('_', '');
  return BigInt(clean.startsWith('0o') ? `0o${clean.slice(2)}` : clean);
}

/** Checks a float literal as `std.zig.number_literal` does. */
export function parseFloatText(text: string, node: Node): void {
  checkNumber(text, node);
}

function checkNumber(text: string, node: Node): void {
  let index = 0;
  let base = 10;
  if (text.length >= 2 && text[0] === '0') {
    const second = text[1];
    if (second === 'b' || second === 'o' || second === 'x') {
      base = second === 'b' ? 2 : second === 'o' ? 8 : 16;
      index = 2;
    } else if (second === 'B' || second === 'O' || second === 'X') {
      fail(node, `数 '${text}' の基数の記号は小文字で書いてください。`);
    } else if (second !== '.' && second !== 'e' && second !== 'E') {
      fail(node, `数 '${text}' の先頭に 0 があります（8進数は 0o で始めます）。`);
    }
  }
  if (text.length === 2 && base !== 10) fail(node, `数 '${text}' の基数の記号の後に数字がありません。`);
  let underscore = false;
  let special = '';
  let exponent = false;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === '_') {
      if (special !== '' || underscore || (index === 2 && base !== 10))
        fail(node, `数 '${text}' の _ の位置が正しくありません。`);
      underscore = true;
      continue;
    }
    if ((char === 'e' || char === 'E') && base === 10) {
      if (exponent || underscore) fail(node, `数 '${text}' の書き方が正しくありません。`);
      special = char;
      exponent = true;
      continue;
    }
    if ((char === 'p' || char === 'P') && base === 16) {
      if (exponent || underscore) fail(node, `数 '${text}' の書き方が正しくありません。`);
      special = char;
      exponent = true;
      continue;
    }
    if (char === '.') {
      if (exponent || underscore) fail(node, `数 '${text}' の書き方が正しくありません。`);
      if (base !== 10 && base !== 16) fail(node, `数 '${text}' の基数では小数を書けません。`);
      special = char;
      continue;
    }
    if (char === '+' || char === '-') {
      if (!(special === 'p' || special === 'P' || ((special === 'e' || special === 'E') && base === 10))) {
        fail(node, `数 '${text}' の符号の位置が正しくありません。`);
      }
      special = char;
      continue;
    }
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit)) fail(node, `数 '${text}' に使えない文字があります。`);
    if (digit >= base || (exponent && digit >= 10))
      fail(node, `数 '${text}' に、基数 ${base} では使えない数字があります。`);
    underscore = false;
    special = '';
  }
  if (underscore || special !== '') fail(node, `数 '${text}' の終わり方が正しくありません。`);
}
