import type { Node } from '@willbooster/web-tree-sitter';

import { fail } from './scopes';
import { lookupName } from './unicodeDatabase';

export function rowOf(node: Node): number {
  return node.startPosition.row;
}

/** The named children except extras: comments and backslash line continuations, which may appear anywhere. */
export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && !isExtra(child));
}

export function children(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null && !isExtra(child));
}

/** Whether a node is a comment or a backslash continuation, which the grammar allows between any two tokens. */
function isExtra(node: Node): boolean {
  return node.type === 'comment' || node.type === 'line_continuation';
}

export function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) throw new Error(`The ${node.type} node has no ${name}`);
  return child;
}

export function fieldNodes(node: Node, name: string): Node[] {
  return node.childrenForFieldName(name).filter((child): child is Node => child !== null);
}

const CLAUSE_TYPES = new Set(['elif_clause', 'else_clause', 'except_clause', 'finally_clause']);

/**
 * Rejects a clause of a compound statement that the grammar accepts and CPython does not: one following the previous
 * body on its line, as in `if x: a(); else: b()`, and one indented deeper than its statement, which the grammar's
 * error recovery attaches by inserting a dedent that no node shows.
 */
export function checkClauseLines(node: Node): void {
  const all = children(node);
  for (const [index, clause] of all.entries()) {
    if (!CLAUSE_TYPES.has(clause.type)) continue;
    const previous = all[index - 1];
    const keyword = clause.text.split(/[\s:]/, 1)[0];
    if (previous.endPosition.row === clause.startPosition.row && previous.endPosition.column > 0) {
      fail(rowOf(clause), `${keyword} は、行の先頭に書いてください。`);
    }
    if (clause.startPosition.column !== node.startPosition.column) {
      fail(rowOf(clause), `${keyword} は、対応する文と同じ字下げで書いてください。`);
    }
  }
}

export function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => child?.type === token);
}

/** Rejects a construct this grader does not support, naming it for learners. */
export function unsupported(node: Node | number, feature: string): never {
  return fail(
    typeof node === 'number' ? node : rowOf(node),
    `${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`
  );
}

/** Decodes the escape sequences of a string literal's text, as a non-raw literal does. */
export function decodeEscapes(text: string, row: number): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '\\' || index + 1 >= text.length) {
      result += text[index++];
      continue;
    }
    const [decoded, end] = decodeEscape(text, index + 1, row);
    result += decoded;
    index = end;
  }
  return result;
}

/** Decodes the escape sequence whose character after the backslash is at `start`, returning it and the index after it. */
function decodeEscape(text: string, start: number, row: number): [string, number] {
  const next = text[start];
  const simple = SIMPLE_ESCAPES[next];
  if (simple !== undefined) return [simple, start + 1];
  if (next === '\n') return ['', start + 1];
  if (next === '\r') return ['', text[start + 1] === '\n' ? start + 2 : start + 1];
  if (/[0-7]/.test(next)) {
    const digits = /^[0-7]{1,3}/.exec(text.slice(start))?.[0] ?? next;
    return [String.fromCodePoint(Number.parseInt(digits, 8)), start + digits.length];
  }
  const hexLength = HEX_ESCAPE_LENGTHS[next];
  if (hexLength !== undefined) return [decodeHexEscape(text, start, hexLength, row), start + 1 + hexLength];
  if (next === 'N') return decodeNamedEscape(text, start, row);
  // An unknown escape keeps its backslash, which Python only warns about.
  return [`\\${next}`, start + 1];
}

/** Decodes `\N{name}`, whose name may be a character's name or alias in any letter case. */
function decodeNamedEscape(text: string, start: number, row: number): [string, number] {
  const end = text.indexOf('}', start);
  const name = text.slice(start + 2, end);
  if (text[start + 1] !== '{' || end === -1 || name === '') {
    // oxlint-disable-next-line unicorn/prefer-string-raw -- Bun's transpiler escapes non-ASCII characters in a raw template.
    fail(row, '文字列の中の \\N の後には、{文字の名前} を書いてください。');
  }
  const point = lookupName(name, false);
  if (typeof point !== 'number') fail(row, `文字列の中の \\N{${name}} は、Unicode の文字の名前ではありません。`);
  return [String.fromCodePoint(point), end + 1];
}

function decodeHexEscape(text: string, start: number, hexLength: number, row: number): string {
  const next = text[start];
  const digits = text.slice(start + 1, start + 1 + hexLength);
  if (!new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(digits)) {
    fail(row, `文字列の中の \\${next} の後には、16進数を${hexLength}桁書いてください。`);
  }
  const codePoint = Number.parseInt(digits, 16);
  if (codePoint > 0x10_ff_ff) fail(row, `文字列の中の \\${next}${digits} は、文字の範囲を超えています。`);
  return String.fromCodePoint(codePoint);
}

/** The bytes of a bytes literal's ASCII text, decoding its escape sequences unless the literal is raw. */
export function decodeBytesEscapes(text: string, row: number, isRaw: boolean): Uint8Array {
  const bytes: number[] = [];
  let index = 0;
  while (index < text.length) {
    if (isRaw || text[index] !== '\\' || index + 1 >= text.length) {
      bytes.push(text.codePointAt(index++) as number);
      continue;
    }
    const next = text[index + 1];
    if (next === 'x') {
      const digits = text.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) {
        // oxlint-disable-next-line unicorn/prefer-string-raw -- Bun's transpiler escapes non-ASCII characters in a raw template.
        fail(row, 'bytes の中の \\x の後には、16進数を2桁書いてください。');
      }
      bytes.push(Number.parseInt(digits, 16));
      index += 4;
    } else if (next === 'N' || next === 'u' || next === 'U') {
      bytes.push(0x5c);
      index++;
    } else {
      const [decoded, end] = decodeEscape(text, index + 1, row);
      for (const char of decoded) bytes.push((char.codePointAt(0) as number) & 0xff);
      index = end;
    }
  }
  return Uint8Array.from(bytes);
}

const HEX_ESCAPE_LENGTHS: Record<string, number> = { x: 2, u: 4, U: 8 };

const SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  a: '\u0007',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};
