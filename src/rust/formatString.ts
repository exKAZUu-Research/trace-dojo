import { CompileError } from '../interpreter/diagnostics';
import type { Expr, FormatArgs, FormatPiece, FormatSpec, Span } from './ast';

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

/**
 * Parses a format string as `format_args!` does, resolving each placeholder to an argument; a name that no argument
 * has captures the variable of that name, as Rust 2021 does.
 */
export function parseFormatString(
  text: string,
  args: Expr[],
  positionalCount: number,
  named: Map<string, number>,
  span: Span,
  stringSpan: Span
): FormatArgs {
  return new FormatStringParser(text, args, positionalCount, named, span, stringSpan).parse();
}

class FormatStringParser {
  private readonly pieces: FormatPiece[] = [];
  private readonly allArgs: Expr[];
  private readonly used = new Set<number>();
  private readonly captured = new Map<string, number>();
  private readonly chars: string[];
  private nextPositional = 0;
  private literal = '';
  private index = 0;

  constructor(
    text: string,
    private readonly args: Expr[],
    private readonly positionalCount: number,
    private readonly named: Map<string, number>,
    private readonly span: Span,
    private readonly stringSpan: Span
  ) {
    this.allArgs = [...args];
    this.chars = [...text];
  }

  parse(): FormatArgs {
    while (this.index < this.chars.length) this.step();
    if (this.literal) this.pieces.push(this.literal);
    this.checkAllUsed();
    return { pieces: this.pieces, args: this.allArgs, span: this.span };
  }

  private step(): void {
    const char = this.chars[this.index];
    if (char === '}') {
      if (this.chars[this.index + 1] === '}') {
        this.literal += '}';
        this.index += 2;
        return;
      }
      this.error('書式の文字列に、対応する { のない } があります（} は }} と書きます）。');
    }
    if (char !== '{') {
      this.literal += char;
      this.index++;
      return;
    }
    if (this.chars[this.index + 1] === '{') {
      this.literal += '{';
      this.index += 2;
      return;
    }
    this.index++;
    if (this.literal) this.pieces.push(this.literal);
    this.literal = '';
    this.pieces.push(this.placeholder());
  }

  private placeholder(): FormatSpec {
    this.skipSpaces();
    const argument = this.readArgument();
    this.skipSpaces();
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
    if (this.chars[this.index] === ':') {
      this.index++;
      this.formatSpec(spec);
    }
    if (this.chars[this.index] !== '}') this.error('書式の文字列の { } の書き方に誤りがあります。');
    this.index++;
    spec.arg = this.placeholderArgument(argument);
    this.used.add(spec.arg);
    return spec;
  }

  private formatSpec(spec: FormatSpec): void {
    this.fillAndAlign(spec);
    this.flags(spec);
    spec.width = this.readCount();
    if (this.chars[this.index] === '.') {
      this.index++;
      spec.precision = this.precision();
    }
    this.skipSpaces();
    let type = '';
    while (this.index < this.chars.length && this.chars[this.index] !== '}' && this.chars[this.index] !== ' ') {
      type += this.chars[this.index++];
    }
    this.skipSpaces();
    if (type === 'x?' || type === 'X?') spec.debugHex = type[0] as 'x' | 'X';
    const trait = traits[type.replace(/^[xX]\?$/, '?')];
    if (!trait) this.error(`書式の指定 ${type} は使えません（使えるのは ?, x, X, o, b, e, E です）。`);
    spec.trait = trait;
  }

  private fillAndAlign(spec: FormatSpec): void {
    const chars = this.chars;
    if (chars[this.index + 1] !== undefined && '<>^'.includes(chars[this.index + 1])) {
      spec.fill = chars[this.index];
      spec.align = chars[this.index + 1] as FormatSpec['align'];
      this.index += 2;
    } else if ('<>^'.includes(chars[this.index])) {
      spec.align = chars[this.index] as FormatSpec['align'];
      this.index++;
    }
  }

  private flags(spec: FormatSpec): void {
    const chars = this.chars;
    if (chars[this.index] === '+' || chars[this.index] === '-') spec.sign = chars[this.index++] as '+' | '-';
    if (chars[this.index] === '#') {
      spec.alternate = true;
      this.index++;
    }
    if (chars[this.index] === '0' && chars[this.index + 1] !== '$') {
      spec.zero = true;
      this.index++;
    }
  }

  private precision(): FormatSpec['precision'] {
    if (this.chars[this.index] !== '*') {
      // An empty precision (`{:.}`) is no precision.
      return this.readCount();
    }
    this.index++;
    if (this.nextPositional >= this.positionalCount) this.error('書式の .* にあたる引数が足りません。');
    const arg = this.nextPositional++;
    this.used.add(arg);
    return { kind: 'arg', arg };
  }

  private placeholderArgument(argument: number | string | undefined): number {
    if (argument !== undefined) return this.resolve(argument);
    if (this.nextPositional >= this.positionalCount) {
      this.error(`書式の {} の数に対して、引数が足りません（引数は ${this.positionalCount} 個です）。`);
    }
    return this.nextPositional++;
  }

  private readCount(): FormatSpec['width'] {
    const start = this.index;
    const argument = this.readArgument();
    if (argument === undefined) return undefined;
    if (this.chars[this.index] === '$') {
      this.index++;
      const arg = this.resolve(argument);
      this.used.add(arg);
      return { kind: 'arg', arg };
    }
    if (typeof argument === 'number') return { kind: 'literal', value: argument };
    this.index = start;
    return undefined;
  }

  private readArgument(): number | string | undefined {
    const digits = this.readWhile(/\d/);
    if (digits) return Number(digits);
    return this.readWhile(/[\p{XID_Continue}]/u) || undefined;
  }

  private readWhile(pattern: RegExp): string {
    let text = '';
    while (this.index < this.chars.length && pattern.test(this.chars[this.index])) text += this.chars[this.index++];
    return text;
  }

  private skipSpaces(): void {
    while (this.chars[this.index] === ' ') this.index++;
  }

  private resolve(argument: number | string): number {
    return typeof argument === 'number' ? this.resolveIndex(argument) : this.resolveName(argument);
  }

  private resolveIndex(value: number): number {
    if (value >= this.positionalCount) {
      this.error(`書式の {${value}} にあたる引数がありません（引数は ${this.positionalCount} 個です）。`);
    }
    return value;
  }

  private resolveName(name: string): number {
    const existing = this.named.get(name) ?? this.captured.get(name);
    if (existing !== undefined) return existing;
    if (!/^[\p{XID_Start}_][\p{XID_Continue}]*$/u.test(name)) this.error(`書式の引数名 ${name} に誤りがあります。`);
    const span = this.span;
    const expr: Expr = { kind: 'path', path: { segments: [{ name, args: undefined, span }], span }, span };
    this.captured.set(name, this.allArgs.length);
    this.allArgs.push(expr);
    return this.allArgs.length - 1;
  }

  private checkAllUsed(): void {
    for (let arg = 0; arg < this.args.length; arg++) {
      if (this.used.has(arg)) continue;
      const name = [...this.named.entries()].find(([, value]) => value === arg)?.[0];
      formatError(
        this.args[arg].span,
        name ? `名前付きの引数 ${name} を書式の文字列で使っていません。` : '書式の文字列で使っていない引数があります。'
      );
    }
  }

  private error(message: string): never {
    formatError(this.stringSpan, message);
  }
}

function formatError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}
