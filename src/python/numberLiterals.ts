import type { Node } from '@willbooster/web-tree-sitter';

import type { Constant } from './ast';
import { rowOf } from './convertNodes';
import { fail } from './scopes';

const DIGIT_PART = String.raw`\d(?:_?\d)*`;
const POINT_FLOAT = String.raw`(?:(?:${DIGIT_PART})?\.${DIGIT_PART}|${DIGIT_PART}\.)`;
const FLOAT_NUMBER = String.raw`(?:${POINT_FLOAT}(?:[eE][+-]?${DIGIT_PART})?|${DIGIT_PART}[eE][+-]?${DIGIT_PART})`;
const INTEGER_LITERAL = /^(?:[1-9](?:_?\d)*|0+(?:_?0)*|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|0[xX](?:_?[\dA-Fa-f])+)$/;
const FLOAT_LITERAL = new RegExp(`^${FLOAT_NUMBER}$`);
const IMAGINARY_LITERAL = new RegExp(`^(?:${FLOAT_NUMBER}|${DIGIT_PART})[jJ]$`);

/** Parses a number literal, rejecting the forms CPython's tokenizer rejects. */
export function parseNumber(node: Node): Constant {
  const text = node.text;
  const row = rowOf(node);
  const digits = text.replaceAll('_', '').toLowerCase();
  if (INTEGER_LITERAL.test(text)) return { kind: 'int', value: BigInt(digits) };
  if (FLOAT_LITERAL.test(text)) return { kind: 'float', value: Number(digits) };
  if (IMAGINARY_LITERAL.test(text)) return { kind: 'imaginary', value: Number(digits.slice(0, -1)) };
  const body = /[jJ]$/.test(text) ? text.slice(0, -1) : text;
  // Only report underscore placement when `_` is actually misplaced, such as `1__0`, `1_.0`, `1._0`, `1_`, `0x_`.
  if (
    /_(?:_|$|\.)|\._|^0[xXoObB]_?[xXoObB_]/.test(body) &&
    !/[lL]$/.test(body) &&
    /__|_$|_\.|\._|[eE][+-]?_|_[eE]/.test(body)
  ) {
    fail(row, `数値「${text}」の _ の位置に誤りがあります。`);
  }
  if (/^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[\d_.]+)[lL]$/.test(body)) {
    fail(row, `数値「${text}」の末尾の L は Python 3 では使えません。L を消してください。`);
  }
  if (/^0+_?[1-9]/.test(text) && /^[\d_]+$/.test(text)) {
    fail(row, '0 で始まる整数は書けません（8進数は 0o を付けて書きます）。');
  }
  return fail(row, `数値「${text}」の書き方に誤りがあります。`);
}
