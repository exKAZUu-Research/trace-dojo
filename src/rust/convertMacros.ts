import type { Node } from '@willbooster/web-tree-sitter';

import type { Expr, FormatArgs, MacroCall, Pattern, Span } from './ast';
import { PatternConverter } from './convertPatterns';
import { isComment, syntaxError, unavailable } from './convertSyntax';
import { parseFormatString } from './formatString';
import { parseStringLiteral } from './literals';

/** Converts macro invocations, whose arguments it reparses as Rust code. */
export abstract class MacroConverter extends PatternConverter {
  protected macro(node: Node): MacroCall {
    const span = this.span(node);
    const macroNode = this.field(node, 'macro');
    if (macroNode.type !== 'identifier') {
      const name = macroNode.text.replace(/^(?:r#)?(?:std|core|alloc)::/, '').replace(/^r#/, '');
      if (name.includes('::')) unavailable(span, `マクロ ${macroNode.text}!`);
    }
    const name = macroNode.text.replace(/^(?:r#)?(?:std|core|alloc)::/, '').replace(/^r#/, '');
    const tree = node.namedChildren.find((child) => child.type === 'token_tree');
    if (!tree) syntaxError(span, `${name}! の引数が足りません。`);
    return this.macroCall(name, tree, span);
  }

  // code-gauge-allow functionNcss 38 -- One case per macro.
  private macroCall(name: string, tree: Node, span: Span): MacroCall {
    switch (name) {
      case 'println':
      case 'print':
      case 'eprintln':
      case 'eprint': {
        return this.printMacro(name, tree, span);
      }
      case 'format': {
        const args = this.macroArgs(tree);
        if (args.length === 0) syntaxError(span, 'format! には、書式の文字列が要ります。');
        return { kind: 'format', format: this.formatArgs(args, span, name) };
      }
      case 'write':
      case 'writeln': {
        return this.writeMacro(name, tree, span);
      }
      case 'panic':
      case 'unreachable':
      case 'todo':
      case 'unimplemented': {
        const args = this.macroArgs(tree);
        return { kind: 'panic', name, format: this.optionalFormatArgs(args, span, name) };
      }
      case 'assert':
      case 'debug_assert': {
        return this.assertMacro(name, tree, span);
      }
      case 'assert_eq':
      case 'assert_ne':
      case 'debug_assert_eq':
      case 'debug_assert_ne': {
        return this.assertEqMacro(name, tree, span);
      }
      case 'vec': {
        return this.vecMacro(tree, span);
      }
      case 'matches': {
        return this.matchesMacro(tree, span);
      }
      case 'dbg': {
        const args = this.macroArgs(tree);
        return {
          kind: 'dbg',
          args: args.map((arg) => this.expr(arg)),
          texts: args.map((arg) => arg.text.replaceAll(/\s+/g, ' ')),
        };
      }
      default: {
        return unavailable(span, `マクロ ${name}!`);
      }
    }
  }

  private printMacro(name: string, tree: Node, span: Span): MacroCall {
    const args = this.macroArgs(tree);
    const newline = name.endsWith('ln');
    const stream = name.startsWith('e') ? 'stderr' : 'stdout';
    if (args.length === 0) {
      if (!newline) syntaxError(span, `${name}! には、書式の文字列が要ります。`);
      return { kind: 'print', stream, newline, format: undefined };
    }
    return { kind: 'print', stream, newline, format: this.formatArgs(args, span, name) };
  }

  private writeMacro(name: string, tree: Node, span: Span): MacroCall {
    const args = this.macroArgs(tree);
    if (args.length === 0) syntaxError(span, `${name}! には、書き込む先が要ります。`);
    const [target, ...rest] = args;
    if (rest.length === 0 && name === 'write') syntaxError(span, 'write! には、書式の文字列が要ります。');
    return {
      kind: 'write',
      target: this.expr(target),
      newline: name === 'writeln',
      format: this.optionalFormatArgs(rest, span, name),
    };
  }

  private assertMacro(name: string, tree: Node, span: Span): MacroCall {
    const args = this.macroArgs(tree);
    if (args.length === 0) syntaxError(span, `${name}! には、条件が要ります。`);
    const [cond, ...rest] = args;
    return {
      kind: 'assert',
      cond: this.expr(cond),
      text: cond.text.replaceAll(/\s+/g, ' '),
      format: this.optionalFormatArgs(rest, span, name),
    };
  }

  private assertEqMacro(name: string, tree: Node, span: Span): MacroCall {
    const args = this.macroArgs(tree);
    if (args.length < 2) syntaxError(span, `${name}! には、比べる2つの値が要ります。`);
    const [left, right, ...rest] = args;
    return {
      kind: 'assertEq',
      equal: name.endsWith('eq'),
      left: this.expr(left),
      right: this.expr(right),
      format: this.optionalFormatArgs(rest, span, name),
    };
  }

  /** The comma-separated arguments of a macro, reparsed as expressions at their places in the source. */
  private macroArgs(tree: Node): Node[] {
    const open = tree.text[0];
    if (open !== '(' && open !== '[' && open !== '{') syntaxError(this.span(tree), '書き方に誤りがあります。');
    const inner = tree.text.slice(1, -1);
    const prefix = this.prefixFor(tree);
    return this.reparse(
      `${prefix}(${inner}${inner.trim() === '' || inner.trimEnd().endsWith(',') ? '' : ','});`,
      (root) => {
        const statement = root.namedChildren.find((child) => !isComment(child));
        const expression = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
        if (!expression) return [];
        if (expression.type === 'unit_expression') return [];
        if (expression.type === 'tuple_expression') return expression.namedChildren.filter((c) => !isComment(c));
        if (expression.type === 'parenthesized_expression') return [this.onlyChild(expression)];
        syntaxError(this.span(tree), '書き方に誤りがあります。');
      }
    ) as Node[];
  }

  /** Spaces and newlines that place reparsed text where the token tree starts. */
  private prefixFor(tree: Node): string {
    const { row, column } = tree.startPosition;
    return '\n'.repeat(row) + ' '.repeat(column);
  }

  private vecMacro(tree: Node, span: Span): MacroCall {
    const inner = tree.text.slice(1, -1);
    return this.reparse(`${this.prefixFor(tree)}[${inner}];`, (root) => {
      const statement = root.namedChildren.find((child) => !isComment(child));
      const array = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
      if (array?.type !== 'array_expression') syntaxError(span, 'vec! の書き方に誤りがあります。');
      const expr = this.expr(array);
      if (expr.kind === 'arrayRepeat') return { kind: 'vecRepeat', value: expr.value, count: expr.count };
      if (expr.kind !== 'array') syntaxError(span, 'vec! の書き方に誤りがあります。');
      return { kind: 'vec', elems: expr.elems };
    }) as MacroCall;
  }

  private matchesMacro(tree: Node, span: Span): MacroCall {
    const inner = tree.text.slice(1, -1);
    const comma = topLevelComma(inner);
    if (comma < 0) syntaxError(span, 'matches! には、値とパターンが要ります。');
    const valueText = inner.slice(0, comma);
    const patternText = inner.slice(comma + 1).replace(/,\s*$/, '');
    const value = this.reparse(`${this.prefixFor(tree)} ${valueText};`, (root) => {
      const statement = root.namedChildren.find((child) => !isComment(child));
      const expression = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
      if (!expression) syntaxError(span, 'matches! の書き方に誤りがあります。');
      return this.expr(expression);
    }) as Expr;
    const pattern = this.reparse(`fn f() { match x { ${patternText} => {} } }`, (root) => {
      const arm = root.descendantsOfType('match_arm')[0];
      if (!arm) syntaxError(span, 'matches! の書き方に誤りがあります。');
      const matchPattern = this.field(arm, 'pattern');
      if (matchPattern.childForFieldName('condition')) unavailable(span, 'match の腕のガード（if）');
      const patternNode = matchPattern.namedChildren.find((child) => !isComment(child));
      return patternNode ? this.pattern(patternNode) : ({ kind: 'wild', span } as Pattern);
    }) as Pattern;
    return { kind: 'matches', value, pattern: withSpan(pattern, span) };
  }

  private optionalFormatArgs(args: Node[], span: Span, macroName: string): FormatArgs | undefined {
    return args.length > 0 ? this.formatArgs(args, span, macroName) : undefined;
  }

  /** The format string and arguments of a formatting macro, with implicit named arguments (`{x}`) captured. */
  private formatArgs(args: Node[], span: Span, macroName: string): FormatArgs {
    const [formatNode, ...rest] = args;
    const text = this.formatString(formatNode, args.length, span, macroName);
    const positional: Expr[] = [];
    const named = new Map<string, number>();
    const exprs: Expr[] = [];
    for (const arg of rest) {
      if (arg.type === 'assignment_expression' && this.field(arg, 'left').type === 'identifier') {
        const name = this.identifier(this.field(arg, 'left'));
        if (named.has(name)) syntaxError(this.span(arg), `名前付きの引数 ${name} が2回あります。`);
        named.set(name, exprs.length);
        exprs.push(this.expr(this.field(arg, 'right')));
      } else {
        if (named.size > 0) syntaxError(this.span(arg), '名前のない引数は、名前付きの引数より前に書いてください。');
        positional.push(this.expr(arg));
        exprs.push(positional.at(-1) as Expr);
      }
    }
    // Named arguments follow the positional ones, and `{}` may take them in turn too.
    return parseFormatString(text, exprs, exprs.length, named, span, this.span(formatNode));
  }

  private formatString(formatNode: Node, argCount: number, span: Span, macroName: string): string {
    if (formatNode.type === 'raw_string_literal') unavailable(this.span(formatNode), '生の文字列（r"..."）');
    if (formatNode.type !== 'string_literal' || formatNode.text.startsWith('b')) {
      if (macroName === 'panic' && argCount === 1) {
        syntaxError(span, 'panic! の引数は、書式の文字列にしてください。');
      }
      syntaxError(this.span(formatNode), `${macroName}! の最初の引数は、書式の文字列（"..."）にしてください。`);
    }
    const text = parseStringLiteral(formatNode.text);
    if (text === undefined) syntaxError(this.span(formatNode), '文字列の書き方に誤りがあります。');
    return text;
  }
}

function topLevelComma(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return index;
  }
  return -1;
}

function withSpan(pattern: Pattern, span: Span): Pattern {
  const copy = { ...pattern, span } as Pattern;
  switch (copy.kind) {
    case 'tuple': {
      return { ...copy, elems: copy.elems.map((elem) => withSpan(elem, span)) };
    }
    case 'tupleStruct': {
      return { ...copy, elems: copy.elems.map((elem) => withSpan(elem, span)) };
    }
    case 'or': {
      return { ...copy, alternatives: copy.alternatives.map((alt) => withSpan(alt, span)) };
    }
    default: {
      return copy;
    }
  }
}
