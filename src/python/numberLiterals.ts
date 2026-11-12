import type { Node } from '@willbooster/web-tree-sitter';

import type { Constant } from './ast';
import { rowOf, unsupported } from './convertNodes';
import { fail } from './scopes';

/** Parses a number literal, rejecting the forms CPython rejects and the forms this grader does not support. */
export function parseNumber(node: Node): Constant {
  const text = node.text;
  const row = rowOf(node);
  const isImaginary = /[jJ]$/.test(text);
  const body = isImaginary ? text.slice(0, -1) : text;
  if (/^0[xXoObB]/.test(body)) unsupported(node, `数値「${text}」（16進数・8進数・2進数のリテラル）`);
  if (/[eE]/.test(body)) unsupported(node, `数値「${text}」（指数表記のリテラル）`);
  if (/_(?:_|$|\.)|\._/.test(body) || body.endsWith('_')) fail(row, `数値「${text}」の _ の位置に誤りがあります。`);
  if (/^[\d_.]+[lL]$/.test(body))
    fail(row, `数値「${text}」の末尾の L は Python 3 では使えません。L を消してください。`);
  const digits = body.replaceAll('_', '');
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(digits)) fail(row, `数値「${text}」の書き方に誤りがあります。`);
  if (!isImaginary && !digits.includes('.')) {
    if (/^0+[1-9]/.test(digits)) {
      fail(row, '0 で始まる整数は書けません（8進数は 0o を付けて書きます）。');
    }
    return { kind: 'int', value: BigInt(digits) };
  }
  const value = Number(digits);
  return isImaginary ? { kind: 'imaginary', value } : { kind: 'float', value };
}
