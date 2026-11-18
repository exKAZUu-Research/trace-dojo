import { CompileError } from '../interpreter/diagnostics';
import type { Expr, FormatArgs, FormatPiece, FormatSpec, Span } from './ast';

function formatError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}

/**
 * Parses a format string as `format_args!` does, resolving each placeholder to an argument; a name that no argument
 * has captures the variable of that name, as Rust 2021 does.
 */
// code-gauge-allow functionCognitiveComplexity 60 -- Transcribes std::fmt's grammar.
export function parseFormatString(
  text: string,
  args: Expr[],
  positionalCount: number,
  named: Map<string, number>,
  span: Span,
  stringSpan: Span
): FormatArgs {
  const pieces: FormatPiece[] = [];
  const allArgs = [...args];
  const used = new Set<number>();
  const captured = new Map<string, number>();
  let nextPositional = 0;
  let literal = '';
  const chars = [...text];
  let index = 0;

  const resolveName = (name: string): number => {
    const existing = named.get(name);
    if (existing !== undefined) return existing;
    const capture = captured.get(name);
    if (capture !== undefined) return capture;
    if (!/^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(name))
      formatError(stringSpan, `書式の引数名 ${name} に誤りがあります。`);
    const expr: Expr = { kind: 'path', path: { segments: [{ name, args: undefined, span }], span }, span };
    captured.set(name, allArgs.length);
    allArgs.push(expr);
    return allArgs.length - 1;
  };
  const resolveIndex = (value: number): number => {
    if (value >= positionalCount) {
      formatError(stringSpan, `書式の {${value}} にあたる引数がありません（引数は ${positionalCount} 個です）。`);
    }
    return value;
  };
  const readArgument = (): number | string | undefined => {
    let digits = '';
    while (index < chars.length && /\d/.test(chars[index])) digits += chars[index++];
    if (digits) return Number(digits);
    let name = '';
    while (index < chars.length && /[\p{XID_Continue}]/u.test(chars[index])) name += chars[index++];
    return name || undefined;
  };
  const readCount = (): FormatSpec['width'] => {
    const start = index;
    const argument = readArgument();
    if (argument === undefined) return undefined;
    if (chars[index] === '$') {
      index++;
      const arg = typeof argument === 'number' ? resolveIndex(argument) : resolveName(argument);
      used.add(arg);
      return { kind: 'arg', arg };
    }
    if (typeof argument === 'number') return { kind: 'literal', value: argument };
    index = start;
    return undefined;
  };

  while (index < chars.length) {
    const char = chars[index];
    if (char === '}') {
      if (chars[index + 1] === '}') {
        literal += '}';
        index += 2;
        continue;
      }
      formatError(stringSpan, '書式の文字列に、対応する { のない } があります（} は }} と書きます）。');
    }
    if (char !== '{') {
      literal += char;
      index++;
      continue;
    }
    if (chars[index + 1] === '{') {
      literal += '{';
      index += 2;
      continue;
    }
    index++;
    if (literal) pieces.push(literal);
    literal = '';
    while (chars[index] === ' ') index++;
    const argument = readArgument();
    while (chars[index] === ' ') index++;
    const spec: FormatSpec = {
      arg: -1,
      trait: 'display',
      fill: ' ',
      align: undefined,
      sign: undefined,
      alternate: false,
      zero: false,
      width: undefined,
      precision: undefined,
    };
    if (chars[index] === ':') {
      index++;
      if (chars[index + 1] !== undefined && '<>^'.includes(chars[index + 1]) && chars[index] !== '}') {
        spec.fill = chars[index];
        spec.align = chars[index + 1] as FormatSpec['align'];
        index += 2;
      } else if ('<>^'.includes(chars[index])) {
        spec.align = chars[index] as FormatSpec['align'];
        index++;
      }
      if (chars[index] === '+' || chars[index] === '-') spec.sign = chars[index++] as '+' | '-';
      if (chars[index] === '#') {
        spec.alternate = true;
        index++;
      }
      if (chars[index] === '0' && chars[index + 1] !== '$') {
        spec.zero = true;
        index++;
      }
      spec.width = readCount();
      if (chars[index] === '.') {
        index++;
        if (chars[index] === '*') {
          index++;
          if (nextPositional >= positionalCount) {
            formatError(stringSpan, '書式の .* にあたる引数が足りません。');
          }
          spec.precision = { kind: 'arg', arg: nextPositional };
          used.add(nextPositional);
          nextPositional++;
        } else {
          spec.precision = readCount();
          if (!spec.precision) formatError(stringSpan, '書式の精度（. の後）に誤りがあります。');
        }
      }
      while (chars[index] === ' ') index++;
      let type = '';
      while (index < chars.length && chars[index] !== '}' && chars[index] !== ' ') type += chars[index++];
      while (chars[index] === ' ') index++;
      const traits: Record<string, FormatSpec['trait']> = {
        '': 'display',
        '?': 'debug',
        x: 'lowerHex',
        X: 'upperHex',
        o: 'octal',
        b: 'binary',
        e: 'lowerExp',
        E: 'upperExp',
      };
      if (type === 'x?' || type === 'X?') {
        formatError(stringSpan, `書式の {:${type}} は、この採点環境では使えません。`);
      }
      const trait = traits[type];
      if (!trait) formatError(stringSpan, `書式の指定 ${type} は使えません（使えるのは ?, x, X, o, b, e, E です）。`);
      spec.trait = trait;
    }
    if (chars[index] !== '}') formatError(stringSpan, '書式の文字列の { } の書き方に誤りがあります。');
    index++;
    if (argument === undefined) {
      if (nextPositional >= positionalCount) {
        formatError(stringSpan, `書式の {} の数に対して、引数が足りません（引数は ${positionalCount} 個です）。`);
      }
      spec.arg = nextPositional++;
    } else {
      spec.arg = typeof argument === 'number' ? resolveIndex(argument) : resolveName(argument);
    }
    used.add(spec.arg);
    pieces.push(spec);
  }
  if (literal) pieces.push(literal);
  for (let arg = 0; arg < args.length; arg++) {
    if (!used.has(arg)) {
      const name = [...named.entries()].find(([, value]) => value === arg)?.[0];
      formatError(
        args[arg].span,
        name ? `名前付きの引数 ${name} を書式の文字列で使っていません。` : '書式の文字列で使っていない引数があります。'
      );
    }
  }
  return { pieces, args: allArgs, span };
}
