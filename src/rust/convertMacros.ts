import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { Block, Expr, FormatArgs, Item, MacroCall, MatchArm, Pattern, Span, TypeAst } from './ast';
import { PatternConverter } from './convertPatterns';
import { isComment, syntaxError, unavailable } from './convertSyntax';
import { parseFormatString } from './formatString';
import { parseRawStringLiteral, parseStringLiteral } from './literals';
import { expand, MacroError, type MacroRule, parseParts, tokensOf, tokenText as macroTokenText } from './macroRules';

const MAX_MACRO_DEPTH = 128;

/** Converts macro invocations, whose arguments it reparses as Rust code. */
export abstract class MacroConverter extends PatternConverter {
  /** The `macro_rules!` macros defined so far, which later code may invoke, by name. */
  private readonly userMacros = new Map<string, MacroRule[]>();
  private macroDepth = 0;

  /** Records a `macro_rules!` definition. */
  protected defineMacro(node: Node): void {
    const name = this.identifier(this.field(node, 'name'));
    const rules = node.namedChildren
      .filter((child) => child.type === 'macro_rule')
      .map((rule) => {
        try {
          return {
            matcher: parseParts(tokensOf(this.field(rule, 'left')), true),
            transcriber: parseParts(tokensOf(this.field(rule, 'right')), false),
          };
        } catch (error) {
          if (error instanceof MacroError) syntaxError(this.span(rule), error.message);
          throw error;
        }
      });
    this.userMacros.set(name, rules);
  }

  /** Whether an invocation names a `macro_rules!` macro of the program. */
  protected isUserMacro(node: Node): boolean {
    const macroNode = node.childForFieldName('macro');
    const name = macroNode?.text.replace(/^(?:crate|self)::/, '');
    return name !== undefined && this.userMacros.has(name);
  }

  /**
   * Expands an invocation of a `macro_rules!` macro and converts the code it makes with `convert`, which gets the
   * syntax tree of `wrap(code)`: the expansion stands on the invocation's row.
   */
  protected expandUserMacro<T>(node: Node, wrap: (code: string) => string, convert: (root: Node) => T): T {
    const span = this.span(node);
    const name = (node.childForFieldName('macro') as Node).text.replace(/^(?:crate|self)::/, '');
    const tree = node.namedChildren.find((child) => child.type === 'token_tree');
    if (this.macroDepth >= MAX_MACRO_DEPTH)
      syntaxError(span, `マクロ ${name}! の展開が深すぎます（再帰の上限を超えました）。`);
    let code: string;
    try {
      code = macroTokenText(expand(this.userMacros.get(name) as MacroRule[], tree ? tokensOf(tree) : [], name));
    } catch (error) {
      if (error instanceof MacroError) syntaxError(span, error.message);
      throw error;
    }
    this.macroDepth++;
    try {
      return this.reparse(`${'\n'.repeat(span.row)}${wrap(code)}`, convert as (root: Node) => unknown) as T;
    } finally {
      this.macroDepth--;
    }
  }

  /** A user macro in an expression's place, which must make one expression (`{ ... }` for statements). */
  protected userMacroExpr(node: Node): Expr {
    return this.expandUserMacro(
      node,
      (code) => `fn macro_expansion() { ${code} }`,
      (root) => {
        const block = this.macroBody(root, node);
        if (block.stmts.length > 0 || block.items.length > 0 || !block.tail) {
          syntaxError(this.span(node), 'このマクロは式になりません（式の場所のマクロは、1つの式に展開してください）。');
        }
        return block.tail;
      }
    );
  }

  /** A user macro in a statement's place, whose statements and items join the block around it. */
  protected userMacroStatements(node: Node): Block {
    return this.expandUserMacro(
      node,
      (code) => `fn macro_expansion() { ${code} }`,
      (root) => this.macroBody(root, node)
    );
  }

  private macroBody(root: Node, node: Node): Block {
    const fn = root.namedChildren.find((child) => child.type === 'function_item');
    const body = fn?.childForFieldName('body');
    if (!body) syntaxError(this.span(node), 'マクロの展開の書き方に誤りがあります。');
    return this.block(body);
  }

  /** A user macro in an item's place, whose items join the module around it. */
  protected userMacroItems(node: Node): Item[] {
    return this.expandUserMacro(
      node,
      (code) => code,
      (root) =>
        root.namedChildren.flatMap((child) => {
          if (isComment(child)) return [];
          if (
            (child.type === 'expression_statement' && macroInvocationOf(child) === undefined) ||
            child.type === 'let_declaration'
          ) {
            syntaxError(this.span(node), 'このマクロは項目になりません（関数の外では、項目に展開してください）。');
          }
          return this.itemsOf(child);
        })
    );
  }

  /** The items a node declares: one, none, or the items a macro invocation expands to. */
  protected itemsOf(node: Node): Item[] {
    const invocation = node.type === 'expression_statement' ? macroInvocationOf(node) : node;
    if (invocation?.type === 'macro_invocation' && this.isUserMacro(invocation)) return this.userMacroItems(invocation);
    const item = this.item(node);
    return item ? [item] : [];
  }

  /** A user macro in a type's place. */
  protected userMacroType(node: Node): TypeAst {
    return this.expandUserMacro(
      node,
      (code) => `type MacroExpansion = ${code};`,
      (root) => this.type(this.field(root.namedChildren.find((child) => child.type === 'type_item') as Node, 'type'))
    );
  }

  /** A user macro in a pattern's place. */
  protected userMacroPattern(node: Node): Pattern {
    return this.expandUserMacro(
      node,
      (code) => `fn macro_expansion() { match x { ${code} => {} } }`,
      (root) => {
        const arm = root.descendantsOfType('match_arm')[0];
        const pattern = arm && this.field(arm, 'pattern').namedChildren.find((child) => !isComment(child));
        if (!pattern) syntaxError(this.span(node), 'このマクロはパターンになりません。');
        return this.pattern(pattern);
      }
    );
  }
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

  /** A macro of the standard library that expands to a literal, as that literal; undefined for the other macros. */
  // code-gauge-allow functionNcss -- One case per macro.
  protected literalMacro(node: Node): Expr | undefined {
    const span = this.span(node);
    const name = this.field(node, 'macro')
      .text.replace(/^(?:r#)?(?:::)?(?:std|core|alloc)::/, '')
      .replace(/^r#/, '');
    const tree = node.namedChildren.find((child) => child.type === 'token_tree');
    switch (name) {
      case 'cfg': {
        if (!tree) syntaxError(span, 'cfg! には条件を書いてください。');
        return { kind: 'bool', value: this.attributes.cfgMacro(tree, span), span };
      }
      case 'pin':
      case 'pin::pin': {
        return this.pinMacro(tree, span);
      }
      case 'matches': {
        return tree && this.guardedMatches(tree, span);
      }
      case 'line': {
        return { kind: 'int', value: BigInt(span.row + 1), suffix: 'u32', span };
      }
      case 'column': {
        return { kind: 'int', value: BigInt(span.col), suffix: 'u32', span };
      }
      case 'file': {
        return { kind: 'str', value: 'src/main.rs', span };
      }
      case 'module_path': {
        return { kind: 'str', value: ['main', ...this.modulePath].join('::'), span };
      }
      case 'stringify': {
        const inner = tree ? tree.children.slice(1, -1).filter((child) => !isComment(child)) : [];
        return { kind: 'str', value: tokenText(inner), span };
      }
      case 'concat': {
        return { kind: 'str', value: this.concatMacro(tree), span };
      }
      case 'compile_error': {
        const [message] = tree ? this.macroArgs(tree) : [];
        const text = message?.type === 'string_literal' ? parseStringLiteral(message.text) : undefined;
        return syntaxError(span, text ?? 'compile_error! には、文字列を書いてください。');
      }
      case 'include':
      case 'include_str':
      case 'include_bytes': {
        return unavailable(span, `別のファイルを読み込むマクロ ${name}!`);
      }
      case 'env':
      case 'option_env': {
        return unavailable(span, `コンパイルするときの環境変数を読むマクロ ${name}!`);
      }
      case 'asm':
      case 'global_asm':
      case 'naked_asm': {
        return unavailable(span, `CPU によって結果が変わるインラインアセンブリ（${name}!）`);
      }
      case 'concat_idents':
      case 'log_syntax':
      case 'trace_macros':
      case 'format_args_nl':
      case 'concat_bytes': {
        return syntaxError(span, `${name}! は、不安定な機能なので使えません（E0658）。`);
      }
      case 'try': {
        return syntaxError(span, 'try は予約語なので、try! は使えません（? 演算子を使ってください）。');
      }
      default: {
        return undefined;
      }
    }
  }

  /** The text `concat!` makes of its literal arguments. */
  private concatMacro(tree: Node | undefined): string {
    let text = '';
    for (const arg of tree ? this.macroArgs(tree) : []) {
      const expr = this.expr(arg);
      switch (expr.kind) {
        case 'str':
        case 'char': {
          text += expr.value;
          break;
        }
        case 'bool': {
          text += String(expr.value);
          break;
        }
        case 'int': {
          text += expr.value.toString();
          break;
        }
        case 'float': {
          text += arg.text.replaceAll('_', '').replace(/f(?:32|64)$/, '');
          break;
        }
        case 'unary': {
          if (expr.op === '-' && (expr.operand.kind === 'int' || expr.operand.kind === 'float')) {
            text += `-${arg.text
              .slice(1)
              .trim()
              .replaceAll('_', '')
              .replace(/(?:[iu]\d+|[iu]size|f32|f64)$/, '')}`;
            break;
          }
          syntaxError(this.span(arg), 'concat! には、リテラルだけを書いてください。');
          break;
        }
        default: {
          syntaxError(this.span(arg), 'concat! には、リテラルだけを書いてください。');
        }
      }
    }
    return text;
  }

  // code-gauge-allow functionNcss -- One case per macro.
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
          texts: args.map((arg) => tokenText([arg])),
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
      text: tokenText([cond]),
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
  protected macroArgs(tree: Node): Node[] {
    const open = tree.text[0];
    if (open !== '(' && open !== '[' && open !== '{') syntaxError(this.span(tree), '書き方に誤りがあります。');
    const inner = tree.text.slice(1, -1);
    const prefix = this.prefixFor(tree);
    return this.reparse(
      `${prefix}(${inner}${inner.trim() === '' || inner.trimEnd().endsWith(',') ? '' : ','});`,
      (root) => {
        const expression = firstExpression(root);
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
      const array = firstExpression(root);
      if (array?.type !== 'array_expression') syntaxError(span, 'vec! の書き方に誤りがあります。');
      const expr = this.expr(array);
      if (expr.kind === 'arrayRepeat') return { kind: 'vecRepeat', value: expr.value, count: expr.count };
      if (expr.kind !== 'array') syntaxError(span, 'vec! の書き方に誤りがあります。');
      return { kind: 'vec', elems: expr.elems };
    }) as MacroCall;
  }

  /** `pin!(value)`, which pins the value in a place of its own that lives as long as the reference to it. */
  private pinMacro(tree: Node | undefined, span: Span): Expr {
    const args = tree ? this.macroArgs(tree) : [];
    if (args.length !== 1) syntaxError(span, 'pin! には値を1つ書いてください。');
    const segments = ['std', 'pin', 'pin_value'].map((part) => ({ name: part, args: undefined, span }));
    return { kind: 'call', callee: { kind: 'path', path: { segments, span }, span }, args: [this.expr(args[0])], span };
  }

  /** `matches!(v, p if g)` as the `match` it expands to; undefined without a guard, which the `matches` call takes. */
  private guardedMatches(tree: Node, span: Span): Expr | undefined {
    const { value, pattern, guard } = this.matchesParts(tree, span);
    if (!guard) return undefined;
    const arms: MatchArm[] = [
      { pattern, guard, body: { kind: 'bool', value: true, span }, span },
      { pattern: { kind: 'wild', span }, guard: undefined, body: { kind: 'bool', value: false, span }, span },
    ];
    return { kind: 'match', scrutinee: value, arms, endRow: span.row, span };
  }

  private matchesMacro(tree: Node, span: Span): MacroCall {
    const { value, pattern } = this.matchesParts(tree, span);
    return { kind: 'matches', value, pattern };
  }

  /** The value, the pattern, and the guard of `matches!(value, pattern if guard)`. */
  private matchesParts(tree: Node, span: Span): { value: Expr; pattern: Pattern; guard: Expr | undefined } {
    const tokens = tree.children.slice(1, -1).filter((child) => !isComment(child));
    const last = tokens.at(-1);
    const end = last?.type === ',' ? last.startIndex - tree.startIndex : tree.text.length - 1;
    const { comma, expression } = this.matchValue(tree, tokens, end, span);
    const value = this.expr(expression);
    const patternText = tree.text.slice(comma + 1, end);
    const pattern = this.reparse(`${this.matchHeadBefore(tree, comma + 1)}${patternText}\n => {} } }`, (root) => {
      const arm = root.descendantsOfType('match_arm')[0];
      if (!arm) syntaxError(span, 'matches! の書き方に誤りがあります。');
      const matchPattern = this.field(arm, 'pattern');
      const condition = matchPattern.childForFieldName('condition');
      const patternNode = matchPattern.namedChildren.find((child) => !isComment(child) && child.id !== condition?.id);
      return {
        pattern: patternNode ? this.pattern(patternNode) : ({ kind: 'wild', span } as Pattern),
        guard: condition ? this.expr(condition) : undefined,
      };
    }) as { pattern: Pattern; guard: Expr | undefined };
    return { value, ...pattern };
  }

  /**
   * The start of a `match` to reparse a pattern in, which leaves the pattern where it is in the source so that errors
   * in any part of it are reported there: on the line above it when there is one.
   */
  private matchHeadBefore(tree: Node, offset: number): string {
    const before = tree.text.slice(0, offset);
    const lineStart = before.lastIndexOf('\n') + 1;
    const row = tree.startPosition.row + (before.match(/\n/g)?.length ?? 0);
    const column = lineStart === 0 ? tree.startPosition.column + offset : offset - lineStart;
    const head = 'fn f() { match x {';
    return row === 0 ? `${head} ` : `${'\n'.repeat(row - 1)}${head}\n${' '.repeat(column)}`;
  }

  private matchValue(tree: Node, tokens: Node[], end: number, span: Span): { comma: number; expression: Node } {
    const text = tree.text;
    const prefix = this.prefixFor(tree);
    for (const token of tokens) {
      const comma = token.startIndex - tree.startIndex;
      if (token.type !== ',' || comma >= end) continue;
      try {
        // A comma can still be inside a turbofish or a closure's parameters, which token trees leave ungrouped.
        const expression = this.reparse(`${prefix} ${text.slice(1, comma)};`, firstExpression) as Node | undefined;
        if (expression) return { comma, expression };
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
      }
    }
    return syntaxError(span, 'matches! には、値とパターンが要ります。');
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
    if (formatNode.type === 'raw_string_literal') {
      const raw = parseRawStringLiteral(formatNode.text);
      if (raw && !raw.prefix) return raw.body;
    }
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

function firstExpression(root: Node): Node | undefined {
  const statement = root.namedChildren.find((child) => !isComment(child));
  return statement?.type === 'expression_statement'
    ? statement.namedChildren.find((child) => !isComment(child))
    : statement;
}

/** The text `stringify!` gives tokens: as written, with one space where spaces or newlines separate them. */
function tokenText(tokens: Node[]): string {
  let text = '';
  let end: number | undefined;
  const visit = (token: Node): void => {
    if (isComment(token)) return;
    if (token.childCount > 0 && !token.type.endsWith('_literal')) {
      for (const child of token.children) visit(child);
      return;
    }
    if (end !== undefined && token.startIndex > end) text += ' ';
    text += token.text;
    end = token.endIndex;
  };
  for (const token of tokens) visit(token);
  return text;
}

/** The macro invocation an expression statement consists of, if it does. */
function macroInvocationOf(statement: Node): Node | undefined {
  const inner = statement.namedChildren.find((child) => !isComment(child));
  return inner?.type === 'macro_invocation' ? inner : undefined;
}
