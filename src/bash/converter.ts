// code-gauge-allow-file fileNcss 454 -- Converts every node kind of the grammar in one converter, which shares the source and annotations.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { MaskedArithmetic } from './arithmeticMasking';
import type {
  ArithmeticSource,
  Assignment,
  BackquoteSyntaxError,
  CaseItem,
  ParameterExpansion,
  Program,
  Redirect,
  Statement,
  TestExpression,
  Word,
  WordPart,
} from './ast';
import { isReservedCommand, unexpectedTokenMessage } from './syntaxErrors';
import { unsupportedMessage } from './unsupported';

/** The node types that expand inside a word, which arithmetic substitutes into its text. */
const EXPANSION_TYPES = new Set([
  'simple_expansion',
  'expansion',
  'command_substitution',
  'arithmetic_expansion',
  'string',
  'raw_string',
  'ansi_c_string',
  'translated_string',
]);

/** Converts the tree of a program into statements, rejecting the syntax this environment does not support. */
export class Converter {
  /** The rows of the `# atomic` annotations that a function's header holds. */
  readonly claimedAtomicRows = new Set<number>();

  constructor(
    private readonly source: string,
    private readonly atomicRows: ReadonlySet<number>,
    private readonly masked: MaskedArithmetic,
    private readonly rawPieces: (raw: string) => (string | WordPart)[],
    /** Parses the text of a backquoted command substitution that Bash reads again after removing backslashes. */
    private readonly reparse: (text: string, row: number) => Statement[],
    /** The syntax errors of backquoted bodies, which Bash reports when it runs them, by the index of their `` ` ``. */
    private readonly backquoteErrors: ReadonlyMap<number, BackquoteSyntaxError>
  ) {}

  convertProgram(root: Node): Program {
    const units: Statement[][] = [];
    const unitEndRows: number[] = [];
    let unit: Statement[] = [];
    let previousEnd: number | undefined;
    let previousEndRow = 0;
    for (const child of root.children) {
      if (!child.isNamed) {
        this.checkTerminator(child);
        continue;
      }
      if (child.type === 'comment') continue;
      // Bash reads and runs a program one line at a time, so an error that discards a command discards its line.
      if (previousEnd !== undefined && this.source.slice(previousEnd, child.startIndex).includes('\n')) {
        units.push(unit);
        unitEndRows.push(previousEndRow);
        unit = [];
      }
      unit.push(this.statement(child));
      previousEnd = child.endIndex;
      previousEndRow = child.endPosition.row;
    }
    if (unit.length > 0) {
      units.push(unit);
      unitEndRows.push(previousEndRow);
    }
    return { units, unitEndRows };
  }

  private fail(node: Node, message: string): never {
    throw new CompileError([{ row: node.startPosition.row, message }]);
  }

  private unsupported(node: Node, feature: string): never {
    this.fail(node, unsupportedMessage(feature));
  }

  private checkTerminator(node: Node): void {
    if (node.type === '&') this.unsupported(node, 'バックグラウンド実行（&）');
  }

  private statements(nodes: Node[]): Statement[] {
    const result: Statement[] = [];
    for (const node of nodes) {
      if (!node.isNamed) {
        this.checkTerminator(node);
        continue;
      }
      if (node.type === 'comment') continue;
      result.push(this.statement(node));
    }
    return result;
  }

  private fieldNodes(node: Node, field: string): Node[] {
    const result: Node[] = [];
    for (let i = 0; i < node.childCount; i++) {
      if (node.fieldNameForChild(i) === field) result.push(node.child(i) as Node);
    }
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per statement node of the grammar, each delegating to its own converter.
  // code-gauge-allow functionNcss 56 -- One case per statement node of the grammar, each delegating to its own converter.
  private statement(node: Node): Statement {
    const row = node.startPosition.row;
    const base = { row, lineRow: lineRowOf(node) };
    switch (node.type) {
      case 'command': {
        return this.command(node);
      }
      case 'declaration_command': {
        return this.declaration(node);
      }
      case 'variable_assignment': {
        return { ...base, kind: 'command', assignments: [this.assignment(node)], words: [], redirects: [] };
      }
      case 'arithmetic_command': {
        return { ...base, kind: 'arithmetic', expression: this.arithmeticInside(node, '((', '))') };
      }
      case 'test_command': {
        return { ...base, kind: 'test', expression: this.testOf(this.innerTest(node)), text: node.text };
      }
      case 'if_statement': {
        return this.ifStatement(node);
      }
      case 'while_statement': {
        return {
          ...base,
          kind: 'while',
          until: node.childForFieldName('keyword')?.type === 'until',
          condition: this.statements(this.fieldNodes(node, 'condition')),
          body: this.body(node.childForFieldName('body') as Node),
        };
      }
      case 'for_statement': {
        return this.forStatement(node);
      }
      case 'c_style_for_statement': {
        const opening = node.children.find((child) => child.type === '((');
        const raw = opening ? this.masked.get(opening.endIndex) : undefined;
        const parts = raw === undefined ? undefined : splitForHeader(raw);
        const part = (index: number, field: string): ArithmeticSource | undefined => {
          if (!parts) return this.optionalArithmetic(node, field);
          return parts[index].trim() === '' ? undefined : { pieces: this.rawPieces(parts[index]), row };
        };
        return {
          ...base,
          kind: 'arithmeticFor',
          init: part(0, 'initializer'),
          condition: part(1, 'condition'),
          update: part(2, 'update'),
          body: this.body(node.childForFieldName('body') as Node),
        };
      }
      case 'case_statement': {
        return this.caseStatement(node);
      }
      case 'compound_statement': {
        return { ...base, kind: 'group', body: this.nonEmpty(node, this.statements(node.children)) };
      }
      case 'function_definition': {
        return this.functionDefinition(node);
      }
      case 'list': {
        const operator = node.childForFieldName('operator')?.type === '||' ? '||' : '&&';
        return {
          ...base,
          kind: 'list',
          operator,
          left: this.statement(node.childForFieldName('left') as Node),
          right: this.statement(node.childForFieldName('right') as Node),
        };
      }
      case 'negated_command': {
        const body = node.namedChildren.find((child) => child?.type !== 'comment') as Node;
        return { ...base, kind: 'not', body: this.statement(body) };
      }
      case 'redirected_statement': {
        const body = node.childForFieldName('body') as Node;
        if (body.type === 'function_definition') this.unsupported(node, '関数の定義に付けたリダイレクト');
        return {
          ...base,
          kind: 'redirected',
          body: this.statement(body),
          redirects: this.fieldNodes(node, 'redirect').map((redirect) => this.redirect(redirect)),
        };
      }
      case 'pipeline': {
        return this.unsupported(node, 'パイプ（|）');
      }
      case 'subshell': {
        return this.unsupported(node, 'サブシェル（( ... )）');
      }
      case 'coproc_command': {
        return this.unsupported(node, 'coproc');
      }
      case 'timed_command': {
        return this.unsupported(node, 'time');
      }
      default: {
        return this.fail(node, unexpectedTokenMessage(node.text.split(/\s/)[0] || node.type));
      }
    }
  }

  private body(node: Node): Statement[] {
    if (node.type === 'do_group' || node.type === 'compound_statement')
      return this.nonEmpty(node, this.statements(node.children));
    return [this.statement(node)];
  }

  /** The statements of a body, which Bash requires to hold at least one, naming the word that ends an empty one. */
  private nonEmpty(node: Node, statements: Statement[], closing?: Node): Statement[] {
    if (statements.length > 0) return statements;
    const end =
      closing ?? node.children.findLast((child) => !child.isNamed && child.type !== ';' && child.type !== '&');
    return this.fail(end ?? node, unexpectedTokenMessage(end?.type ?? node.type));
  }

  private command(node: Node): Statement {
    if (isReservedCommand(node)) {
      this.fail(node, unexpectedTokenMessage(node.childForFieldName('name')?.text ?? node.text));
    }
    const row = node.startPosition.row;
    const nameNode = node.childForFieldName('name');
    const words = nameNode ? [this.word(nameNode.namedChildren.at(-1) as Node)] : [];
    for (const argument of this.fieldNodes(node, 'argument')) words.push(this.word(argument));
    return {
      row,
      lineRow: lineRowOf(node),
      kind: 'command',
      assignments: this.fieldNodes(node, 'assignment').map((assignment) => this.assignment(assignment)),
      words,
      redirects: this.fieldNodes(node, 'redirect').map((redirect) => this.redirect(redirect)),
    };
  }

  private declaration(node: Node): Statement {
    const row = node.startPosition.row;
    const args = this.fieldNodes(node, 'argument').map((argument) =>
      argument.type === 'variable_assignment' ? this.assignment(argument) : this.word(argument)
    );
    return {
      row,
      lineRow: lineRowOf(node),
      kind: 'declaration',
      name: node.childForFieldName('name')?.text ?? '',
      assignments: this.fieldNodes(node, 'assignment').map((assignment) => this.assignment(assignment)),
      args,
      redirects: this.fieldNodes(node, 'redirect').map((redirect) => this.redirect(redirect)),
    };
  }

  private assignment(node: Node): Assignment {
    const nameNode = node.childForFieldName('name') as Node;
    const valueNode = node.childForFieldName('value');
    // The grammar does not expose the operator token, so the text after the name tells `+=` from `=`.
    const append = this.source.startsWith('+=', nameNode.endIndex);
    const assignment: Assignment = {
      name: nameNode.type === 'subscript' ? (nameNode.childForFieldName('name')?.text ?? '') : nameNode.text,
      append,
      value: undefined,
      row: node.startPosition.row,
      text: node.text,
    };
    if (nameNode.type === 'subscript') assignment.subscript = this.subscriptWord(nameNode);
    if (valueNode?.type === 'array') {
      assignment.array = valueNode.namedChildren.flatMap((child) =>
        child && child.type !== 'comment' ? [this.word(child)] : []
      );
    } else if (valueNode) assignment.value = this.word(valueNode);
    return assignment;
  }

  /** The index of a subscript node, from its first `[` to its last `]`, including any nested brackets. */
  private subscriptWord(node: Node): Word {
    const children = node.children;
    const open = children.findIndex((child) => child.type === '[');
    let close = -1;
    for (let i = children.length - 1; i > open; i--) {
      if (children[i].type === ']') {
        close = i;
        break;
      }
    }
    const parts: WordPart[] = [];
    for (const child of children.slice(open + 1, close)) {
      if (child.isNamed) parts.push(...this.wordParts(child));
      else parts.push({ kind: 'literal', text: child.text });
    }
    const start = children[open]?.endIndex ?? node.startIndex;
    const end = children[close]?.startIndex ?? node.endIndex;
    return { parts: mergeLiterals(parts), row: node.startPosition.row, text: this.source.slice(start, end) };
  }

  private redirect(node: Node): Redirect {
    if (node.type === 'heredoc_redirect') this.unsupported(node, 'ヒアドキュメント（<<）');
    if (node.type === 'herestring_redirect') this.unsupported(node, 'ヒアストリング（<<<）');
    const operator = node.childForFieldName('operator')?.type ?? '';
    const descriptor = node.childForFieldName('descriptor')?.text;
    const destination = node.childForFieldName('destination');
    const fd = descriptor === undefined ? 1 : Number(descriptor);
    const target = destination?.type === 'word' ? destination.text : undefined;
    const isCopy =
      (operator === '>&' || operator === '<&') && (fd === 1 || fd === 2) && (target === '1' || target === '2');
    if (isCopy && (operator === '>&' || fd === Number(target))) return { fd, target: Number(target) as 1 | 2 };
    return this.unsupported(node, `リダイレクト（${node.text}）`);
  }

  private ifStatement(node: Node): Statement {
    const row = node.startPosition.row;
    // An empty body ends at the next clause's word or at `fi`, which Bash then reports as unexpected.
    const clauses = [
      {
        condition: this.statements(this.fieldNodes(node, 'condition')),
        body: this.nonEmpty(
          node,
          this.statements(this.fieldNodes(node, 'consequence')),
          nextClauseWord(node, thenWord(node))
        ),
      },
    ];
    let elseBody: Statement[] | undefined;
    for (const child of node.namedChildren) {
      if (child?.type === 'elif_clause') {
        clauses.push({
          condition: this.statements(this.fieldNodes(child, 'condition')),
          body: this.nonEmpty(
            child,
            this.statements(this.fieldNodes(child, 'consequence')),
            nextClauseWord(node, thenWord(child))
          ),
        });
      } else if (child?.type === 'else_clause') {
        elseBody = this.nonEmpty(child, this.statements(child.children), nextClauseWord(node, child.child(0) as Node));
      }
    }
    return { row, lineRow: row, kind: 'if', clauses, elseBody };
  }

  private forStatement(node: Node): Statement {
    const row = node.startPosition.row;
    if (node.childForFieldName('keyword')?.type === 'select') this.unsupported(node, 'select（標準入力を読む）');
    const hasIn = node.children.some((child) => child.type === 'in');
    return {
      row,
      lineRow: row,
      kind: 'for',
      variable: node.childForFieldName('variable')?.text ?? '',
      values: hasIn ? this.fieldNodes(node, 'value').map((value) => this.word(value)) : undefined,
      body: this.body(node.childForFieldName('body') as Node),
    };
  }

  private caseStatement(node: Node): Statement {
    const row = node.startPosition.row;
    const items: CaseItem[] = [];
    for (const item of node.namedChildren) {
      if (item?.type !== 'case_item') continue;
      const patterns = this.fieldNodes(item, 'pattern').map((pattern) => this.word(pattern));
      const terminator = (item.childForFieldName('terminator')?.type ?? ';;') as CaseItem['terminator'];
      const bodyNodes = item.children.filter(
        (child) => child.isNamed && item.children.indexOf(child) > lastPatternIndex(item)
      );
      items.push({ patterns, body: this.statements(bodyNodes), terminator });
    }
    return { row, lineRow: row, kind: 'case', value: this.word(node.childForFieldName('value') as Node), items };
  }

  private functionDefinition(node: Node): Statement {
    const row = node.startPosition.row;
    const body = node.childForFieldName('body') as Node;
    if (body.type === 'subshell') this.unsupported(body, 'サブシェルを本体にした関数（f() ( ... )）');
    const opening = body.type === 'compound_statement' ? body.child(0) : undefined;
    const headerEnd = opening?.startPosition.row ?? body.startPosition.row;
    let isAtomic = false;
    for (let headerRow = row; headerRow <= headerEnd; headerRow++) {
      if (this.atomicRows.has(headerRow)) {
        isAtomic = true;
        this.claimedAtomicRows.add(headerRow);
      }
    }
    return {
      row,
      lineRow: row,
      kind: 'function',
      name: node.childForFieldName('name')?.text ?? '',
      body: this.statement(body),
      isAtomic,
    };
  }

  private innerTest(node: Node): Node {
    return node.namedChildren.find((child) => child && child.type !== 'comment') as Node;
  }

  private testOf(node: Node): TestExpression {
    switch (node.type) {
      case 'unary_test': {
        return {
          kind: 'unary',
          operator: node.childForFieldName('operator')?.text ?? '',
          operand: this.word(node.childForFieldName('operand') as Node),
        };
      }
      case 'binary_test': {
        return {
          kind: 'binary',
          operator: node.childForFieldName('operator')?.text ?? '',
          left: this.word(node.childForFieldName('left') as Node),
          right: this.word(node.childForFieldName('right') as Node),
        };
      }
      case 'regex_test': {
        return {
          kind: 'regex',
          left: this.word(node.childForFieldName('left') as Node),
          right: this.word(node.childForFieldName('right') as Node),
        };
      }
      case 'negated_test': {
        return { kind: 'not', expression: this.testOf(this.innerTest(node)) };
      }
      case 'parenthesized_test': {
        return this.testOf(this.innerTest(node));
      }
      case 'logical_test': {
        const [left, right] = node.namedChildren.filter((child) => child?.type !== 'comment') as Node[];
        const operator = node.children.find((child) => child.type === '&&' || child.type === '||');
        return { kind: operator?.type === '||' ? 'or' : 'and', left: this.testOf(left), right: this.testOf(right) };
      }
      default: {
        return { kind: 'word', word: this.word(node) };
      }
    }
  }

  private optionalArithmetic(node: Node, field: string): ArithmeticSource | undefined {
    const expression = node.childForFieldName(field);
    return expression ? this.arithmeticOf(expression.startIndex, expression.endIndex, [expression], node) : undefined;
  }

  /** The arithmetic between a node's opening and closing delimiters. */
  private arithmeticInside(node: Node, open: string, close: string): ArithmeticSource {
    const children = node.children;
    const opening = children.find((child) => child.type === open);
    const closing = children.findLast((child) => child.type === close);
    const start = opening?.endIndex ?? node.startIndex;
    const end = closing?.startIndex ?? node.endIndex;
    const raw = this.masked.get(start);
    if (raw !== undefined) return { pieces: this.rawPieces(raw), row: node.startPosition.row };
    return this.arithmeticOf(
      start,
      end,
      children.filter((child) => child.isNamed),
      node
    );
  }

  /** The text from `start` to `end`, whose expansions run before the arithmetic evaluator reads the result. */
  private arithmeticOf(start: number, end: number, nodes: Node[], owner: Node): ArithmeticSource {
    const pieces: (string | WordPart)[] = [];
    let position = start;
    const visit = (node: Node): void => {
      if (EXPANSION_TYPES.has(node.type)) {
        if (node.startIndex > position) pieces.push(this.source.slice(position, node.startIndex));
        pieces.push(...this.wordParts(node));
        position = node.endIndex;
        return;
      }
      for (const child of node.children) visit(child);
    };
    for (const node of nodes) visit(node);
    if (end > position) pieces.push(this.source.slice(position, end));
    return { pieces, row: owner.startPosition.row };
  }

  /** Converts a word-like node: a word, a concatenation, a quoted string, or an expansion. */
  word(node: Node): Word {
    return { parts: mergeLiterals(this.wordParts(node)), row: node.startPosition.row, text: node.text };
  }

  // code-gauge-allow functionNcss 32 -- One case per word part node of the grammar.
  private wordParts(node: Node): WordPart[] {
    switch (node.type) {
      case 'word':
      case 'regex':
      case 'number':
      case 'variable_name': {
        return [{ kind: 'literal', text: node.text }];
      }
      case 'concatenation': {
        return node.children.flatMap((child) => (child.isNamed ? this.wordParts(child) : []));
      }
      case 'raw_string': {
        // An empty subscript holds a raw string the grammar inserted, which has no text.
        return node.text === '' ? [] : [{ kind: 'single', text: node.text.slice(1, -1) }];
      }
      case 'ansi_c_string': {
        return [{ kind: 'ansiC', text: decodeAnsiC(node.text.slice(2, -1)) }];
      }
      case 'string':
      case 'translated_string': {
        return [{ kind: 'double', parts: mergeLiterals(this.stringParts(node)) }];
      }
      case 'simple_expansion': {
        const name = node.namedChildren[0]?.text ?? '';
        return [{ kind: 'parameter', name, argument: [], text: node.text, braced: false }];
      }
      case 'expansion': {
        return [this.expansion(node)];
      }
      case 'command_substitution': {
        return [this.commandSubstitution(node)];
      }
      case 'arithmetic_expansion': {
        const brackets = node.children.some((child) => child.type === '$[');
        return [
          {
            kind: 'arithmeticExpansion',
            expression: brackets ? this.arithmeticInside(node, '$[', ']') : this.arithmeticInside(node, '$((', '))'),
          },
        ];
      }
      case 'process_substitution': {
        return this.unsupported(node, 'プロセス置換（<( ... )）');
      }
      case 'extglob_pattern': {
        return this.unsupported(node, '拡張パターン（@( ... ) など）');
      }
      default: {
        return this.fail(node, unexpectedTokenMessage(node.text));
      }
    }
  }

  /** The parts of a double-quoted string, whose text keeps the backslashes that quote `$`, `` ` ``, `"`, and `\`. */
  private stringParts(node: Node): WordPart[] {
    const parts: WordPart[] = [];
    for (const child of node.children) {
      if (!child.isNamed) continue;
      if (child.type === 'string_content') parts.push({ kind: 'literal', text: child.text });
      else parts.push(...this.wordParts(child));
    }
    return parts;
  }

  private commandSubstitution(node: Node): WordPart {
    const opening = node.child(0);
    if (opening && opening.type !== '$(' && opening.type !== '`') {
      this.unsupported(node, '現在のシェルで実行するコマンド置換（${ ...; }）');
    }
    const syntaxError = opening?.type === '`' ? this.backquoteErrors.get(node.startIndex) : undefined;
    if (syntaxError) return { kind: 'commandSubstitution', body: [], text: node.text, syntaxError };
    // Bash removes the backslashes before `$`, `` ` ``, and `\` in a backquoted body before reading it as commands.
    const inner = opening?.type === '`' ? node.text.slice(1, -1) : '';
    const body = /\\[$`\\]/.test(inner)
      ? this.reparse(inner.replaceAll(/\\([$`\\])/g, '$1'), node.startPosition.row)
      : this.statements(node.children.filter((child) => child.isNamed || child.type === '&'));
    return { kind: 'commandSubstitution', body, text: node.text };
  }

  private expansion(node: Node): ParameterExpansion {
    const parameter = node.childForFieldName('parameter');
    const operator = node.childForFieldName('operator')?.text;
    const prefix = node.childForFieldName('prefix')?.text as '#' | '!' | undefined;
    const argument = this.fieldNodes(node, 'argument').flatMap((child) => this.wordParts(child));
    const expansion: ParameterExpansion = {
      kind: 'parameter',
      name: '',
      argument: mergeLiterals(argument),
      text: node.text,
      braced: true,
    };
    if (operator !== undefined) expansion.operator = operator;
    if (prefix) expansion.prefix = prefix;
    if (!parameter) {
      // `${}` or text without a parameter, which Bash rejects only when it expands.
      expansion.name = '';
      return expansion;
    }
    if (parameter.type === 'subscript') {
      expansion.name = parameter.childForFieldName('name')?.text ?? '';
      if (parameter.children.filter((child) => child.type === '[').length > 1 && isChainedSubscript(parameter)) {
        expansion.name = '';
      }
      expansion.subscript = this.subscriptWord(parameter);
    } else expansion.name = parameter.text;
    return expansion;
  }
}

function thenWord(owner: Node): Node {
  return owner.children.find((child) => child.type === 'then') as Node;
}

/**
 * The row Bash reports for a statement's errors and `LINENO`: the line its parser was on when it made the command.
 * That is where the first word of a simple command ends, where `))` ends, and where the last operand of `[[` ends, or
 * its `]]` when `&&` or `||` joins the operands; a compound command keeps the row of its first word.
 */
function lineRowOf(node: Node): number {
  switch (node.type) {
    case 'command':
    case 'declaration_command': {
      return (node.namedChildren.find((child) => child?.type !== 'comment') ?? node).endPosition.row;
    }
    case 'variable_assignment':
    case 'arithmetic_command': {
      return node.endPosition.row;
    }
    case 'test_command': {
      const inner = node.namedChildren.find((child) => child && child.type !== 'comment');
      return inner && inner.type !== 'logical_test' ? inner.endPosition.row : node.endPosition.row;
    }
    default: {
      return node.startPosition.row;
    }
  }
}

/** The word after `after` that starts the next clause of an `if` or ends it: `elif`, `else`, or `fi`. */
function nextClauseWord(ifNode: Node, after: Node): Node | undefined {
  const words: Node[] = [];
  const visit = (node: Node): void => {
    for (const child of node.children) {
      if (['elif', 'else', 'fi'].includes(child.type)) words.push(child);
      else if (child.type === 'elif_clause' || child.type === 'else_clause') visit(child);
    }
  };
  visit(ifNode);
  return words.find((word) => word.startIndex >= after.endIndex);
}

/** Splits the text of `for ((init; condition; update))` at its two semicolons outside parentheses. */
function splitForHeader(raw: string): [string, string, string] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '(') depth++;
    else if (raw[i] === ')') depth--;
    else if (raw[i] === ';' && depth === 0 && parts.length < 2) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  while (parts.length < 3) parts.push('');
  return parts as [string, string, string];
}

/** Whether a subscript node holds `a[1][2]`, two subscripts in a row, rather than one with nested brackets. */
function isChainedSubscript(node: Node): boolean {
  let depth = 0;
  for (const child of node.children) {
    if (child.type === '[') depth++;
    else if (child.type === ']') {
      depth--;
      if (depth === 0 && child !== node.children.findLast((c) => c.type === ']')) return true;
    }
  }
  return false;
}

function lastPatternIndex(item: Node): number {
  let index = -1;
  for (let i = 0; i < item.childCount; i++) {
    if (item.fieldNameForChild(i) === 'pattern') index = i;
  }
  return index;
}

/** Joins adjacent literal parts, which the parser splits around zero-width tokens. */
function mergeLiterals(parts: WordPart[]): WordPart[] {
  const merged: WordPart[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (part.kind === 'literal' && last?.kind === 'literal') last.text += part.text;
    else merged.push(part.kind === 'literal' ? { ...part } : part);
  }
  return merged;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  e: 27,
  E: 27,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  "'": 39,
  '"': 34,
  '?': 63,
};

/** Decodes the escapes of `$'...'` into bytes, then reads them as UTF-8, as Bash in a UTF-8 locale does. */
export function decodeAnsiC(text: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\' || i + 1 >= text.length) {
      const character = String.fromCodePoint(text.codePointAt(i) as number);
      bytes.push(...encoder.encode(character));
      i += character.length - 1;
      continue;
    }
    const escaped = ansiCEscape(text, i + 1);
    bytes.push(...escaped.bytes);
    i = escaped.last;
  }
  // A NUL byte ends the string, as it ends a C string.
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(new Uint8Array(end === -1 ? bytes : bytes.slice(0, end)));
}

/** The bytes of the escape whose letter is at `index`, and the index of its last character. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per escape of $'...', as Bash's ansicstr reads them.
function ansiCEscape(text: string, index: number): { bytes: number[]; last: number } {
  const next = text[index];
  const rest = text.slice(index + 1);
  if (next in SIMPLE_ESCAPES) return { bytes: [SIMPLE_ESCAPES[next]], last: index };
  if (/[0-7]/.test(next)) {
    const digits = /^[0-7]{1,3}/.exec(text.slice(index))?.[0] ?? next;
    return { bytes: [Number.parseInt(digits, 8) & 0xff], last: index + digits.length - 1 };
  }
  // ksh93's `\x{HHH}` reads every hex digit, and Bash keeps the low byte.
  const braced = next === 'x' ? /^\{([0-9A-Fa-f]*)\}?/.exec(rest) : undefined;
  if (braced) return { bytes: [Number.parseInt(braced[1] || '0', 16) & 0xff], last: index + braced[0].length };
  const hex = next === 'x' || next === 'u' || next === 'U' ? hexDigits(rest, next) : undefined;
  if (hex && next === 'x') return { bytes: [Number.parseInt(hex, 16)], last: index + hex.length };
  if (hex) {
    const code = Number.parseInt(hex, 16);
    const valid = code <= 0x10_ff_ff && (code < 0xd8_00 || code > 0xdf_ff);
    return { bytes: valid ? [...new TextEncoder().encode(String.fromCodePoint(code))] : [], last: index + hex.length };
  }
  if (next === 'c' && index + 1 < text.length) {
    const control = text[index + 1];
    return {
      bytes: [control === '?' ? 127 : (control.toUpperCase().codePointAt(0) as number) & 0x1f],
      last: index + 1,
    };
  }
  return { bytes: [92, ...new TextEncoder().encode(next)], last: index };
}

/** The hex digits after `\x` (up to 2), `\u` (4), or `\U` (8), or `undefined` when none follows. */
function hexDigits(rest: string, letter: string): string | undefined {
  const max = letter === 'x' ? 2 : letter === 'u' ? 4 : 8;
  return new RegExp(`^[0-9A-Fa-f]{1,${max}}`).exec(rest)?.[0];
}
