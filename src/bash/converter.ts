// code-gauge-allow-file fileNcss -- Converts every node kind of the grammar in one converter, which shares the source and annotations.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  ArithmeticSource,
  Assignment,
  CaseItem,
  ParameterExpansion,
  Program,
  Redirect,
  Statement,
  StaticDeclarationOptions,
  TestExpression,
  Word,
  WordPart,
} from './ast';
import { DECLARATION_OPTIONS, type UnsupportedSyntaxKind, unsupportedSyntaxMessage } from './capabilities';
import { readRadixDigits, SIMPLE_ESCAPE_BYTES } from './quoting';
import { type AnalyzedBashSource, findForHeaderSemicolons } from './syntaxCheck';
import { isReservedCommand, unexpectedTokenMessage } from './syntaxErrors';
import { isIdentifier } from './variables';

/** The node types that expand inside a word, which arithmetic substitutes into its text. */
const EXPANSION_TYPES = new Set([
  'simple_expansion',
  'expansion',
  'command_substitution',
  'arithmetic_expansion',
  'string',
  'ansi_c_string',
  'translated_string',
]);

type FileRedirectOperator = Extract<Redirect, { kind: 'file' }>['operator'];

const FILE_REDIRECT_OPERATORS = new Set<string>(['<', '>', '>>', '>|', '<>', '&>', '&>>']);

export interface ConverterHooks {
  readonly rawPieces: (raw: string) => (string | WordPart)[];
  /** Parses the text of a backquoted command substitution that Bash reads again after removing backslashes. */
  readonly reparse: (text: string, row: number) => Statement[];
  readonly parseSubscriptParts?: (raw: string) => WordPart[];
  readonly parseBracedExpansion?: (slice: string, inDouble: boolean, row: number) => ParameterExpansion;
  /** Whether the text is a `${ ...; }` body read apart from the lines after it, which may hold its here-documents. */
  readonly readsApart?: boolean;
}

/** Whether a node lies in a `${ ...; }` or `${| ...; }`, whose body Bash reads apart from the lines after it. */
function insideCurrentShellSubstitution(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'command_substitution' && current.text.startsWith('${')) return true;
  }
  return false;
}

/** Converts the tree of a program into statements, consulting `capabilities.ts` for unsupported syntax. */
export class Converter {
  /** The rows of the `# atomic` annotations that a function's header holds. */
  readonly claimedAtomicRows = new Set<number>();
  /** The body of each here-document, by the start of its redirection, which the grammar puts after the command. */
  private readonly heredocBodies = new Map<number, Node>();
  /**
   * The here-documents that end without their delimiter line, with the row of the redirection, the line Bash's warning
   * names as where the body starts, the line it reports from, and the delimiter they wanted.
   */
  private readonly unterminatedHeredocs: { row: number; startLine: number; line: number; delimiter: string }[] = [];

  private get source(): string {
    return this.analyzed.grammarSource;
  }

  constructor(
    private readonly analyzed: AnalyzedBashSource,
    private readonly atomicRows: ReadonlySet<number>,
    private readonly hooks: ConverterHooks
  ) {}

  convertProgram(root: Node): Program {
    this.collectHeredocBodies(root);
    const units: Statement[][] = [];
    const unitEndRows: number[] = [];
    let unit: Statement[] = [];
    let previousEnd: number | undefined;
    let previousEndRow = 0;
    for (const child of root.children) {
      if (!child.isNamed) {
        if (child.type === '&') runInBackground(unit);
        continue;
      }
      if (child.type === 'comment') continue;
      if (child.type === 'heredoc_body') {
        previousEnd = child.endIndex;
        previousEndRow = child.endPosition.row;
        continue;
      }
      // Bash removes backslash-newline continuations before reading a logical line, and discards that line on error.
      if (previousEnd !== undefined && hasLogicalNewline(this.source.slice(previousEnd, child.startIndex))) {
        units.push(unit);
        unitEndRows.push(previousEndRow);
        unit = [];
      }
      unit.push(this.statement(child));
      previousEnd = child.endIndex;
      previousEndRow = logicalLineEndRow(this.source, child.endIndex, child.endPosition.row);
    }
    if (unit.length > 0) {
      units.push(unit);
      unitEndRows.push(previousEndRow);
    }
    const extglobRows = new Map<number, { row: number; line: string }>();
    const lines = this.analyzed.originalSource.split('\n');
    for (const row of [...this.analyzed.uncertainExtglobRows].toSorted((a, b) => a - b)) {
      const index = unitEndRows.findIndex((endRow) => endRow >= row);
      if (index !== -1 && !extglobRows.has(index)) extglobRows.set(index, { row, line: lines[row] ?? '' });
    }
    return { units, unitEndRows, extglobRows, readWarnings: this.readWarnings(unitEndRows) };
  }

  /**
   * The warnings Bash prints for here-documents the end of the input ends, at the line it is on then, as it reads the
   * unit holding them.
   */
  private readWarnings(unitEndRows: readonly number[]): Map<number, string[]> {
    const warnings = new Map<number, string[]>();
    for (const { row, startLine, line, delimiter } of this.unterminatedHeredocs) {
      const index = unitEndRows.findIndex((endRow) => endRow >= row);
      const unit = index === -1 ? unitEndRows.length - 1 : index;
      const message = `line ${line}: warning: here-document at line ${startLine} delimited by end-of-file (wanted \`${delimiter}')`;
      warnings.set(unit, [...(warnings.get(unit) ?? []), message]);
    }
    return warnings;
  }

  /**
   * Notes a here-document that ends without its delimiter line: Bash names the line it was on as it began reading the
   * body (`startLine`), and reports from the line where the substitution closed it (`closedRow`) or else the last
   * line of the input, which a final newline does not add to.
   */
  private noteUnterminatedHeredoc(
    row: number,
    startLine: number | undefined,
    delimiter: string,
    closedRow: number | undefined
  ): void {
    const source = this.analyzed.originalSource;
    const lastLine = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    this.unterminatedHeredocs.push({
      row,
      startLine: startLine ?? lastLine,
      line: closedRow === undefined ? lastLine : closedRow + 1,
      delimiter: delimiter.replaceAll(/['"\\]/g, ''),
    });
  }

  /**
   * Pairs each here-document redirection with its body: the first body not yet paired that starts after it within
   * the same command substitution (or the program), as Bash reads a substitution's here-documents apart.
   */
  private collectHeredocBodies(root: Node): void {
    const redirects: Node[] = [];
    const bodies: Node[] = [];
    const pending: Node[] = [root];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (node.type === 'heredoc_redirect') redirects.push(node);
      else if (node.type === 'heredoc_body') bodies.push(node);
      for (let i = node.childCount - 1; i >= 0; i--) pending.push(node.child(i) as Node);
    }
    const paired = new Set<Node>();
    for (const redirect of redirects.toSorted((a, b) => a.startIndex - b.startIndex)) {
      const scope = substitutionScopeOf(redirect);
      const body = bodies
        .filter((candidate) => !paired.has(candidate) && candidate.startIndex >= redirect.endIndex)
        .filter((candidate) => substitutionScopeOf(candidate) === scope)
        .toSorted((a, b) => a.startIndex - b.startIndex)[0];
      if (!body) continue;
      paired.add(body);
      this.heredocBodies.set(redirect.startIndex, body);
    }
  }

  private fail(node: Node, message: string): never {
    throw new CompileError([{ row: node.startPosition.row, message }]);
  }

  private unsupported(node: Node, kind: UnsupportedSyntaxKind): never {
    this.fail(node, unsupportedSyntaxMessage(kind));
  }

  private statements(nodes: Node[]): Statement[] {
    const result: Statement[] = [];
    for (const node of nodes) {
      if (!node.isNamed) {
        if (node.type === '&') runInBackground(result);
        continue;
      }
      if (node.type === 'comment' || node.type === 'heredoc_body') continue;
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

  // code-gauge-allow functionNcss -- One case per statement node of the grammar, each delegating to its own converter.
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
        return this.variableAssignment(node, base);
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
        return this.arithmeticForStatement(node, base);
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
        return this.redirectedStatement(node, base);
      }
      case 'pipeline': {
        return this.pipeline(node, base);
      }
      case 'subshell': {
        return { ...base, kind: 'subshell', body: this.nonEmpty(node, this.statements(node.children)) };
      }
      case 'coproc_command': {
        const nameNode = node.childForFieldName('name');
        const redirectNodes = this.fieldNodes(node, 'redirect');
        // The grammar puts a compound body's redirections beside the body, which apply to it as to any compound
        // command.
        const bodyNode = node.namedChildren.findLast(
          (child) =>
            child !== null &&
            child.type !== 'comment' &&
            child.id !== nameNode?.id &&
            !redirectNodes.some((redirect) => redirect.id === child.id)
        ) as Node;
        const converted = this.statement(bodyNode);
        const redirects = redirectNodes.map((redirect) => this.redirect(redirect));
        const body: Statement =
          redirects.length === 0 ? converted : { ...base, kind: 'redirected', body: converted, redirects };
        return { ...base, kind: 'coproc', name: nameNode?.text ?? 'COPROC', body };
      }
      case 'timed_command': {
        return this.unsupported(node, 'time');
      }
      default: {
        return this.fail(node, unexpectedTokenMessage(node.text.split(/\s/)[0] || node.type));
      }
    }
  }

  private redirectedStatement(node: Node, base: { row: number; lineRow: number }): Statement {
    const bodyNode = node.childForFieldName('body');
    const redirects = this.fieldNodes(node, 'redirect').map((redirect) => this.redirect(redirect));
    if (!bodyNode) return { ...base, kind: 'command', assignments: [], words: [], redirects };
    const converted = this.statement(bodyNode);
    if (converted.kind === 'command' || converted.kind === 'declaration' || converted.kind === 'function') {
      return { ...converted, redirects: [...converted.redirects, ...redirects] };
    }
    return { ...base, kind: 'redirected', body: converted, redirects };
  }

  private pipeline(node: Node, base: { row: number; lineRow: number }): Statement {
    const commands: Statement[] = [];
    for (const child of node.children) {
      if (child.type === '|&') {
        const previous = commands.pop() as Statement;
        commands.push(withStandardErrorToOutput(previous, child.startPosition.row));
      } else if (child.isNamed && child.type !== 'comment') commands.push(this.statement(child));
    }
    return { ...base, kind: 'pipeline', commands };
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
    const { assignments, leadingWords } = this.splitPrefixAssignments(this.fieldNodes(node, 'assignment'));
    const nameNode = node.childForFieldName('name');
    const words = [...leadingWords];
    if (nameNode) words.push(this.word(nameNode.namedChildren.at(-1) as Node));
    const redirects: Redirect[] = [];
    const { children } = node;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const field = node.fieldNameForChild(index);
      if (field === 'redirect') redirects.push(this.redirect(child));
      else if (field === 'argument') words.push(this.word(child));
    }
    return { row, lineRow: lineRowOf(node), kind: 'command', assignments, words, redirects };
  }

  private declaration(node: Node): Statement {
    const row = node.startPosition.row;
    const { assignments, leadingWords } = this.splitPrefixAssignments(this.fieldNodes(node, 'assignment'));
    const redirects = this.fieldNodes(node, 'redirect').map((redirect) => this.redirect(redirect));
    if (leadingWords.length > 0) {
      const words = [...leadingWords];
      const nameNode = node.childForFieldName('name');
      if (nameNode) words.push(this.word(nameNode));
      for (const arg of this.fieldNodes(node, 'argument')) {
        words.push(arg.type === 'variable_assignment' ? this.assignmentAsWord(arg) : this.word(arg));
      }
      return { row, lineRow: lineRowOf(node), kind: 'command', assignments, words, redirects };
    }
    const name = node.childForFieldName('name')?.text ?? '';
    const args = this.fieldNodes(node, 'argument').map((argument) => {
      if (argument.type !== 'variable_assignment') return this.word(argument);
      return this.isAsciiAssignment(argument) ? this.assignment(argument) : this.assignmentAsWord(argument);
    });
    const normalized = normalizeStaticDeclaration(name, args);
    return {
      row,
      lineRow: lineRowOf(node),
      kind: 'declaration',
      name,
      assignments,
      words: args,
      ...(normalized
        ? {
            staticOptions: normalized.staticOptions,
            args: normalized.operandArgs,
          }
        : { args }),
      redirects,
    };
  }

  private variableAssignment(node: Node, base: { row: number; lineRow: number }): Statement {
    return this.isAsciiAssignment(node)
      ? { ...base, kind: 'command', assignments: [this.assignment(node)], words: [], redirects: [] }
      : { ...base, kind: 'command', assignments: [], words: [this.assignmentAsWord(node)], redirects: [] };
  }

  private arithmeticForStatement(node: Node, base: { row: number; lineRow: number }): Statement {
    const opening = node.children.find((child) => child.type === '((');
    const raw = opening ? this.analyzed.deferredArithmetic.get(opening.endIndex) : undefined;
    const restored = raw === undefined || !opening ? undefined : this.restoreQuotes(raw, opening.endIndex);
    const parts = restored === undefined ? undefined : splitForHeader(restored);
    const part = (index: number, field: string): ArithmeticSource | undefined => {
      if (!parts) return this.optionalArithmetic(node, field);
      return parts[index].trim() === '' ? undefined : { pieces: this.hooks.rawPieces(parts[index]), row: base.row };
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

  private splitPrefixAssignments(nodes: Node[]): { assignments: Assignment[]; leadingWords: Word[] } {
    const assignments: Assignment[] = [];
    const leadingWords: Word[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (leadingWords.length === 0 && this.isAsciiAssignment(nodes[i])) {
        assignments.push(this.assignment(nodes[i]));
      } else {
        leadingWords.push(this.assignmentAsWord(nodes[i]));
      }
    }
    return { assignments, leadingWords };
  }

  private isAsciiAssignment(node: Node): boolean {
    const nameNode = node.childForFieldName('name') as Node;
    const base = nameNode.type === 'subscript' ? nameNode.childForFieldName('name') : nameNode;
    return Boolean(base && isIdentifier(this.restoreQuotes(base.text, base.startIndex)));
  }

  private assignmentAsWord(node: Node): Word {
    const valueNode = node.childForFieldName('value');
    if (valueNode?.type === 'array') this.fail(valueNode, unexpectedTokenMessage('('));
    const nameNode = node.childForFieldName('name') as Node;
    const op = this.source.startsWith('+=', nameNode.endIndex) ? '+=' : '=';
    const parts: WordPart[] = [];
    if (nameNode.type === 'subscript') {
      const base = nameNode.childForFieldName('name') as Node;
      parts.push(
        { kind: 'literal', text: `${this.restoreQuotes(base.text, base.startIndex)}[` },
        ...this.subscriptWord(nameNode).parts,
        { kind: 'literal', text: `]${op}` }
      );
    } else {
      parts.push({ kind: 'literal', text: `${this.restoreQuotes(nameNode.text, nameNode.startIndex)}${op}` });
    }
    if (valueNode) parts.push(...this.wordParts(valueNode));
    return {
      parts: mergeLiterals(parts),
      row: node.startPosition.row,
      text: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
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
      text: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
    };
    if (nameNode.type === 'subscript') assignment.subscript = this.subscriptWord(nameNode);
    if (valueNode?.type === 'array') assignment.array = this.arrayElements(valueNode);
    else if (valueNode) assignment.value = this.word(valueNode);
    return assignment;
  }

  /**
   * Reconstructs compound-assignment elements, joining words the grammar split at spaces inside `[subscript]=value`.
   */
  private arrayElements(arrayNode: Node): Word[] {
    const nodes = arrayNode.namedChildren.filter((child): child is Node => Boolean(child) && child.type !== 'comment');
    const words = nodes.map((node) => this.word(node));
    const elements: Word[] = [];
    for (let i = 0; i < words.length; i++) {
      const end = keyedSpanEnd(words, i);
      if (end === undefined || end === i) {
        elements.push(this.restoreMaskedKeyedElement(words[i], nodes[i].startIndex, nodes[i].endIndex));
        continue;
      }
      const parts: WordPart[] = [...words[i].parts];
      for (let j = i + 1; j <= end; j++) {
        const gap = this.source.slice(nodes[j - 1].endIndex, nodes[j].startIndex).replaceAll('\\\n', '');
        if (gap) parts.push({ kind: 'literal', text: gap });
        parts.push(...words[j].parts);
      }
      const joined: Word = {
        parts: mergeLiterals(parts),
        row: words[i].row,
        text: this.analyzed.originalSource.slice(nodes[i].startIndex, nodes[end].endIndex),
      };
      elements.push(this.restoreMaskedKeyedElement(joined, nodes[i].startIndex, nodes[end].endIndex));
      i = end;
    }
    return elements;
  }

  private restoreMaskedKeyedElement(word: Word, startIndex: number, endIndex: number): Word {
    if (this.source[startIndex] !== '[') return word;
    const maskedSub = this.analyzed.deferredArithmetic.get(startIndex + 1);
    const [first, ...restParts] = word.parts;
    if (maskedSub === undefined || first?.kind !== 'literal') return word;
    const prefixLen = 1 + maskedSub.length;
    if (first.text.length <= prefixLen || first.text[prefixLen] !== ']') return word;
    const restoredSub = this.restoreQuotes(maskedSub, startIndex + 1);
    const subParts = this.hooks.parseSubscriptParts
      ? this.hooks.parseSubscriptParts(restoredSub)
      : [{ kind: 'single' as const, text: restoredSub }];
    return {
      parts: [
        { kind: 'literal', text: '[' },
        ...subParts,
        { kind: 'literal', text: first.text.slice(prefixLen) },
        ...restParts,
      ],
      row: word.row,
      text: this.analyzed.originalSource.slice(startIndex, endIndex),
    };
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
    return {
      parts: mergeLiterals(parts),
      row: node.startPosition.row,
      text: this.analyzed.originalSource.slice(start, end),
    };
  }

  /** Converts a redirection, whose `{name}`, if the syntax check found one before it, names its descriptor. */
  private redirect(node: Node, fdVariable = this.analyzed.descriptorVariables.get(node.startIndex)): Redirect {
    const descriptorText = node.childForFieldName('descriptor')?.text;
    const variable = fdVariable === undefined ? {} : { fdVariable };
    if (node.type === 'heredoc_redirect') {
      return {
        fd: Number(descriptorText ?? 0),
        ...variable,
        kind: 'text',
        body: this.heredocBody(node),
        appendsNewline: false,
      };
    }
    if (node.type === 'herestring_redirect') {
      const value = node.childForFieldName('value') ?? node.namedChildren.at(-1);
      return {
        fd: Number(descriptorText ?? 0),
        ...variable,
        kind: 'text',
        body: this.word(value as Node),
        appendsNewline: true,
      };
    }
    const operator = node.childForFieldName('operator')?.type ?? '';
    const destinations = this.fieldNodes(node, 'destination');
    const readsByDefault = operator.startsWith('<') && operator !== '<<<';
    const fd = descriptorText === undefined ? (readsByDefault ? 0 : 1) : Number(descriptorText);
    if (operator === '>&-' || operator === '<&-') return { fd, ...variable, kind: 'close' };
    if (destinations.length !== 1) this.fail(node, unexpectedTokenMessage('newline'));
    const target = this.word(destinations[0]);
    if (operator === '>&' || operator === '<&') {
      return { fd, ...variable, kind: 'duplicate', operator, target, hasDescriptor: descriptorText !== undefined };
    }
    if (!FILE_REDIRECT_OPERATORS.has(operator)) this.fail(node, unexpectedTokenMessage(operator));
    return { fd, ...variable, kind: 'file', operator: operator as FileRedirectOperator, target };
  }

  /** The text of a here-document, which expands like a double-quoted string unless its delimiter is quoted. */
  // code-gauge-allow functionCognitiveComplexity -- Handles quoted and unquoted delimiters, `<<-` tab stripping, and the body's first newline together.
  private heredocBody(redirect: Node): Word {
    const body = this.heredocBodies.get(redirect.startIndex);
    const row = redirect.startPosition.row;
    const stripsTabs = redirect.childForFieldName('operator')?.type === '<<-';
    const delimiter = redirect.childForFieldName('delimiter')?.text ?? '';
    if (!body) {
      // The body is missing because the input ends before its first line, or because it lies on the lines after a
      // substitution that closed first, which Bash 5.3 reads with a warning and this environment does not.
      if (this.hooks.readsApart || insideCurrentShellSubstitution(redirect) || !this.inputEndsBefore(redirect)) {
        return this.unsupported(redirect, 'outerHeredocBody');
      }
      // Bash begins reading the body at the end of the input, where it stops at once.
      this.noteUnterminatedHeredoc(row, undefined, delimiter, undefined);
      return { parts: [], row, text: '' };
    }
    const end = body.namedChildren.find((child) => child?.type === 'heredoc_end');
    const contentEnd = end?.startIndex ?? body.endIndex;
    // The grammar ends a body the end of the input ends with an empty `heredoc_end`, and one in a substitution at the
    // delimiter followed by the `)` closing it, both of which Bash warns of.
    const source = this.analyzed.originalSource;
    // The end of a backquoted substitution ends its delimiter line.
    const endsAtDelimiterLine =
      end !== undefined && end.startIndex < end.endIndex && /^[ \t]*(\n|`|$)/.test(source.slice(end.endIndex));
    const closedRow = end !== undefined && end.startIndex < end.endIndex ? end.startPosition.row : undefined;
    if (!endsAtDelimiterLine) {
      const startLine = source[body.startIndex] === '\n' ? body.startPosition.row + 1 : body.startPosition.row;
      this.noteUnterminatedHeredoc(row, startLine, delimiter, closedRow);
    }
    // Bash reads a body line by line, so a last line the end of the input cuts off still ends with a newline.
    const content = source.slice(body.startIndex, contentEnd);
    // A last line of blanks only is a line too; only the newline after the redirection line is no line of the body.
    const bodyText = content.replace(/^\n/, '');
    const endsCut = !endsAtDelimiterLine && closedRow === undefined && bodyText !== '' && !bodyText.endsWith('\n');
    const lastNewline: WordPart[] = endsCut ? [{ kind: 'single', text: '\n' }] : [];
    const strip = (text: string, atLineStart: boolean): string =>
      stripsTabs ? text.replaceAll(atLineStart ? /(^|\n)\t+/g : /(\n)\t+/g, '$1') : text;
    if (/['"\\]/.test(delimiter)) {
      const raw = this.analyzed.originalSource.slice(body.startIndex, contentEnd).replace(/^\n/, '');
      return { parts: [{ kind: 'single', text: strip(raw, true) }, ...lastNewline], row, text: raw };
    }
    const parts: WordPart[] = [];
    let atStart = true;
    for (const child of body.namedChildren) {
      if (!child || child.type === 'heredoc_end') continue;
      if (child.type === 'heredoc_content') {
        const raw = this.restoreQuotes(child.text, child.startIndex);
        const text = atStart ? raw.replace(/^\n/, '') : raw;
        parts.push({ kind: 'single', text: unescapeHeredoc(strip(text, atStart)) });
      } else parts.push({ kind: 'double', parts: this.wordParts(child), rawText: child.text });
      atStart = false;
    }
    return {
      parts: [...parts, ...lastNewline],
      row,
      text: this.analyzed.originalSource.slice(body.startIndex, contentEnd),
    };
  }

  /**
   * Whether the input ends before the first line a here-document's body could start on: nothing follows the line of
   * its redirection, or the bodies of here-documents before it read to the end of the input.
   */
  private inputEndsBefore(redirect: Node): boolean {
    const source = this.analyzed.originalSource;
    const lineEnd = source.indexOf('\n', redirect.endIndex);
    let readTo = lineEnd === -1 ? source.length : lineEnd + 1;
    for (const body of this.heredocBodies.values()) {
      if (body.startIndex > redirect.startIndex) readTo = Math.max(readTo, body.endIndex);
    }
    return source.slice(readTo).trim() === '';
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
    const hasIn = node.children.some((child) => child.type === 'in');
    const varNode = node.childForFieldName('variable');
    const variable = varNode
      ? this.analyzed.originalSource.slice(varNode.startIndex, varNode.endIndex).replaceAll('\\\n', '')
      : '';
    return {
      row,
      lineRow: row,
      kind: 'for',
      variable,
      values: hasIn ? this.fieldNodes(node, 'value').map((value) => this.word(value)) : undefined,
      body: this.body(node.childForFieldName('body') as Node),
      ...(node.childForFieldName('keyword')?.type === 'select' ? { select: true } : {}),
    };
  }

  private caseStatement(node: Node): Statement {
    const row = node.startPosition.row;
    const items: CaseItem[] = [];
    for (const item of node.namedChildren) {
      if (item?.type !== 'case_item') continue;
      const patterns = this.fieldNodes(item, 'pattern').map((pattern) => this.word(pattern));
      const terminator = (item.childForFieldName('terminator')?.type ?? ';;') as CaseItem['terminator'];
      const patternEnd = lastPatternIndex(item);
      const bodyNodes = item.children.filter(
        (child, index) => index > patternEnd && (child.isNamed || child.type === '&')
      );
      items.push({ patterns, body: this.statements(bodyNodes), terminator });
    }
    return { row, lineRow: row, kind: 'case', value: this.word(node.childForFieldName('value') as Node), items };
  }

  private functionDefinition(node: Node): Statement {
    const row = node.startPosition.row;
    const body = node.childForFieldName('body') as Node;
    const opening = body.type === 'compound_statement' ? body.child(0) : undefined;
    const headerEnd = opening?.startPosition.row ?? body.startPosition.row;
    let isAtomic = false;
    for (let headerRow = row; headerRow <= headerEnd; headerRow++) {
      if (this.atomicRows.has(headerRow)) {
        isAtomic = true;
        this.claimedAtomicRows.add(headerRow);
      }
    }
    const nameNode = node.childForFieldName('name');
    const name = nameNode
      ? this.analyzed.originalSource.slice(nameNode.startIndex, nameNode.endIndex).replaceAll('\\\n', '')
      : '';
    return {
      row,
      lineRow: row,
      kind: 'function',
      name,
      body: this.statement(body),
      isAtomic,
      redirects: [],
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
        return { kind: 'group', expression: this.testOf(this.innerTest(node)) };
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
    const raw = this.analyzed.deferredArithmetic.get(start);
    if (raw !== undefined) {
      return { pieces: this.hooks.rawPieces(this.restoreQuotes(raw, start)), row: node.startPosition.row };
    }
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
        if (node.startIndex > position) {
          pieces.push(this.restoreQuotes(this.source.slice(position, node.startIndex), position));
        }
        pieces.push(...this.wordParts(node));
        position = node.endIndex;
        return;
      }
      for (const child of node.children) visit(child);
    };
    for (const node of nodes) visit(node);
    if (end > position) pieces.push(this.restoreQuotes(this.source.slice(position, end), position));
    return { pieces, row: owner.startPosition.row };
  }

  private restoreQuotes(text: string, startIndex: number): string {
    const { literalQuotes, declarationFunctionStarts, originalSource } = this.analyzed;
    const hasQuote = literalQuotes.size > 0 && text.includes('\u001F');
    const hasFnStart = declarationFunctionStarts.size > 0 && text.includes('_');
    if (!hasQuote && !hasFnStart) return text;
    let out = '';
    for (let i = 0; i < text.length; i++) {
      out += restoreNormalizedChar(text[i], startIndex + i, originalSource, literalQuotes, declarationFunctionStarts);
    }
    return out;
  }

  /** Converts a word-like node: a word, a concatenation, a quoted string, or an expansion. */
  word(node: Node): Word {
    return {
      parts: mergeLiterals(this.wordParts(node)),
      row: node.startPosition.row,
      text: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
    };
  }

  // code-gauge-allow functionNcss -- One case per word part node of the grammar.
  private wordParts(node: Node): WordPart[] {
    switch (node.type) {
      case 'word':
      case 'regex':
      case 'number':
      case 'variable_name': {
        return [{ kind: 'literal', text: this.restoreQuotes(node.text, node.startIndex) }];
      }
      case 'concatenation': {
        return node.children.flatMap((child) => (child.isNamed ? this.wordParts(child) : []));
      }
      case 'raw_string': {
        // An empty subscript holds a raw string the grammar inserted, which has no text.
        return node.text === '' ? [] : [{ kind: 'single', text: node.text.slice(1, -1) }];
      }
      case 'ansi_c_string': {
        return [
          {
            kind: 'ansiC',
            text: decodeAnsiC(node.text.slice(2, -1)),
            rawText: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
          },
        ];
      }
      case 'string':
      case 'translated_string': {
        const quoteStart = node.type === 'translated_string' ? node.startIndex + 1 : node.startIndex;
        return [
          {
            kind: 'double',
            parts: mergeLiterals(this.stringParts(node)),
            rawText: this.analyzed.originalSource.slice(quoteStart, node.endIndex),
          },
        ];
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
            rawText: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
          },
        ];
      }
      case 'process_substitution': {
        return [
          {
            kind: 'processSubstitution',
            direction: node.child(0)?.type === '>(' ? '>' : '<',
            body: this.statements(node.children.filter((child) => child.isNamed || child.type === '&')),
            text: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
          },
        ];
      }
      case 'extglob_pattern': {
        return this.extglobParts(node);
      }
      default: {
        return this.fail(node, unexpectedTokenMessage(node.text));
      }
    }
  }

  /**
   * The parts of an extended pattern group whose alternatives hold quotes or expansions (`@($x|b)`): its operator,
   * `|`, `)`, and the blanks between words stay literal, while each alternative's words expand.
   */
  private extglobParts(node: Node): WordPart[] {
    const parts: WordPart[] = [];
    let position = node.startIndex;
    for (const [index, child] of node.children.entries()) {
      if (child.startIndex > position) {
        parts.push({
          kind: 'literal',
          text: this.restoreQuotes(this.source.slice(position, child.startIndex), position),
        });
      }
      if (node.fieldNameForChild(index) === 'alternative') parts.push(...this.wordParts(child));
      else parts.push({ kind: 'literal', text: this.restoreQuotes(child.text, child.startIndex) });
      position = child.endIndex;
    }
    return parts;
  }

  /** The parts of a double-quoted string, whose text keeps the backslashes that quote `$`, `` ` ``, `"`, and `\`. */
  private stringParts(node: Node): WordPart[] {
    const parts: WordPart[] = [];
    for (const child of node.children) {
      if (!child.isNamed) continue;
      if (child.type === 'string_content') {
        parts.push({ kind: 'literal', text: this.restoreQuotes(child.text, child.startIndex) });
      } else parts.push(...this.wordParts(child));
    }
    return parts;
  }

  private commandSubstitution(node: Node): WordPart {
    const opening = node.child(0);
    const row = node.startPosition.row;
    if (opening?.type === '${') {
      return {
        kind: 'commandSubstitution',
        body: this.statements(node.children.filter((child) => child.isNamed || child.type === '&')),
        text: this.restoreQuotes(node.text, node.startIndex),
        row,
        mode: this.source[node.startIndex + 2] === '|' ? 'reply' : 'current',
      };
    }
    const text =
      opening?.type === '`'
        ? this.analyzed.originalSource.slice(node.startIndex, node.endIndex)
        : this.restoreQuotes(node.text, node.startIndex);
    const syntaxError = opening?.type === '`' ? this.analyzed.backquoteErrors.get(node.startIndex) : undefined;
    if (syntaxError) return { kind: 'commandSubstitution', body: [], text, row, syntaxError };
    // Bash removes the backslashes before `$`, `` ` ``, and `\` in a backquoted body before reading it as commands.
    const inner = opening?.type === '`' ? text.slice(1, -1) : '';
    const body = /\\[$`\\]/.test(inner)
      ? this.hooks.reparse(inner.replaceAll(/\\([$`\\])/g, '$1'), row)
      : this.statements(node.children.filter((child) => child.isNamed || child.type === '&'));
    return { kind: 'commandSubstitution', body, text, row };
  }

  private expansion(node: Node): ParameterExpansion {
    const deferred = this.analyzed.deferredExpansions.get(node.startIndex);
    if (deferred && this.hooks.parseBracedExpansion) {
      return this.hooks.parseBracedExpansion(deferred.slice, deferred.inDouble, node.startPosition.row);
    }
    const parameter = node.childForFieldName('parameter');
    const operator = node.childForFieldName('operator')?.text;
    const prefix = node.childForFieldName('prefix')?.text as '#' | '!' | undefined;
    const argument = this.fieldNodes(node, 'argument').flatMap((child) => this.wordParts(child));
    const expansion: ParameterExpansion = {
      kind: 'parameter',
      name: '',
      argument: mergeLiterals(argument),
      text: this.analyzed.originalSource.slice(node.startIndex, node.endIndex),
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

/** Makes the last statement run in the background, as the `&` after it does. */
function runInBackground(statements: Statement[]): void {
  const last = statements.pop();
  if (last) statements.push({ row: last.row, lineRow: last.lineRow, kind: 'background', body: last });
}

/** A command whose standard error also goes to its output, after its own redirections, as `|&` makes it. */
function withStandardErrorToOutput(statement: Statement, row: number): Statement {
  const copy: Redirect = {
    fd: 2,
    kind: 'duplicate',
    operator: '>&',
    target: { parts: [{ kind: 'literal', text: '1' }], row, text: '1' },
    hasDescriptor: true,
  };
  if (statement.kind === 'command' || statement.kind === 'declaration' || statement.kind === 'redirected') {
    return { ...statement, redirects: [...statement.redirects, copy] };
  }
  return { row: statement.row, lineRow: statement.lineRow, kind: 'redirected', body: statement, redirects: [copy] };
}

function restoreNormalizedChar(
  ch: string,
  index: number,
  originalSource: string,
  literalQuotes: ReadonlySet<number>,
  declarationFunctionStarts: ReadonlySet<number>
): string {
  if (ch === '\u001F' && literalQuotes.has(index)) return originalSource[index];
  if (ch === '_' && declarationFunctionStarts.has(index)) return originalSource[index];
  return ch;
}

function normalizeStaticDeclaration(
  builtin: string,
  args: (Word | Assignment)[]
): { staticOptions: StaticDeclarationOptions; operandArgs: (Word | Assignment)[] } | undefined {
  const allowed = DECLARATION_OPTIONS[builtin];
  if (allowed === undefined) return undefined;
  const set = new Set<string>();
  const unset = new Set<string>();
  let hasPlusOption = false;
  let invalidOption: string | undefined;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if ('append' in arg) break;
    if (arg.parts.length !== 1 || arg.parts[0].kind !== 'literal' || /[\\{~*?[]/.test(arg.parts[0].text)) {
      return undefined;
    }
    const token = arg.parts[0].text;
    if (token === '--') {
      index++;
      break;
    }
    if (!/^[-+]./.test(token)) break;
    const sign = token[0] as '-' | '+';
    if (sign === '+') hasPlusOption = true;
    invalidOption = scanStaticOptionFlags(token, sign, allowed, set, unset, invalidOption);
  }
  return {
    staticOptions: {
      set: [...set],
      unset: [...unset],
      hasPlusOption,
      ...(invalidOption ? { invalidOption } : {}),
    },
    operandArgs: args.slice(index),
  };
}

function scanStaticOptionFlags(
  token: string,
  sign: '-' | '+',
  allowed: string,
  set: Set<string>,
  unset: Set<string>,
  invalidOption: string | undefined
): string | undefined {
  for (const ch of token.slice(1)) {
    if (!allowed.includes(ch)) return invalidOption ?? `${sign}${ch}`;
    if (ch === 'I' || ch === 'p') set.add(ch);
    else if (sign === '+') {
      unset.add(ch);
      set.delete(ch);
    } else if (!unset.has(ch)) set.add(ch);
  }
  return invalidOption;
}

function thenWord(owner: Node): Node {
  return owner.children.find((child) => child.type === 'then') as Node;
}

/**
 * The row Bash reports for a statement's errors and `LINENO`: the line its parser was on when it made the command.
 * That is where the first word of a simple command ends, where `))` ends, and where the last operand of `[[` ends, or
 * its `]]` when `&&` or `||` joins the operands, and where the redirections of a compound command end; another
 * compound command keeps the row of its first word.
 */
function lineRowOf(node: Node): number {
  switch (node.type) {
    case 'command':
    case 'declaration_command': {
      const first = node.namedChildren.find((child) => child?.type !== 'comment') ?? node;
      // A redirection node reaches the next line, where its destination word does not.
      const word = first.type === 'file_redirect' ? (first.namedChildren.at(-1) ?? first) : first;
      return word.endPosition.row;
    }
    case 'variable_assignment':
    case 'arithmetic_command': {
      return node.endPosition.row;
    }
    case 'test_command': {
      const inner = node.namedChildren.find((child) => child && child.type !== 'comment');
      return inner && inner.type !== 'logical_test' ? inner.endPosition.row : node.endPosition.row;
    }
    case 'redirected_statement': {
      // The parser has read the redirections when a top-level compound command runs them, so their errors name
      // the line of the last one's destination.
      const last = node.childrenForFieldName('redirect').at(-1);
      return (last?.namedChildren.at(-1) ?? last ?? node).endPosition.row;
    }
    default: {
      return node.startPosition.row;
    }
  }
}

/** The start of the command substitution that holds a node, or -1 for the program itself. */
function substitutionScopeOf(node: Node): number {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'command_substitution' || parent.type === 'process_substitution') return parent.startIndex;
  }
  return -1;
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

/** Splits the text of `for ((init; condition; update))` at its two semicolons outside quotes, expansions, and `(...)`. */
function splitForHeader(raw: string): [string, string, string] {
  const [first, second] = findForHeaderSemicolons(raw);
  if (first === undefined) return [raw, '', ''];
  if (second === undefined) return [raw.slice(0, first), raw.slice(first + 1), ''];
  return [raw.slice(0, first), raw.slice(first + 1, second), raw.slice(second + 1)];
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

/** Whether source text between two top-level statements crosses an unescaped newline (ending a logical line). */
function hasLogicalNewline(gap: string): boolean {
  for (let i = 0; i < gap.length; i++) {
    if (gap[i] === '\\') i++;
    else if (gap[i] === '#') {
      while (i < gap.length && gap[i] !== '\n') i++;
      if (i < gap.length) return true;
    } else if (gap[i] === '\n') return true;
  }
  return false;
}

/** Advances a statement's end row across any trailing `\\\n` continuations before its logical line ends. */
function logicalLineEndRow(source: string, endIndex: number, endRow: number): number {
  let row = endRow;
  for (let i = endIndex; i < source.length; i++) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === ';') continue;
    if (c === '\\' && source[i + 1] === '\n') {
      row++;
      i++;
      continue;
    }
    break;
  }
  return row;
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

/** The last word index of a `[subscript]=value` element starting at `start`, or `undefined` if not keyed. */
// code-gauge-allow functionCognitiveComplexity -- Tracks nested unescaped brackets across split words until the closing `]=` or `]+=`.
function keyedSpanEnd(words: Word[], start: number): number | undefined {
  const [first] = words[start].parts;
  if (first?.kind !== 'literal' || !first.text.startsWith('[')) return undefined;
  let depth = 0;
  for (let w = start; w < words.length; w++) {
    for (const part of words[w].parts) {
      if (part.kind !== 'literal') continue;
      for (let i = 0; i < part.text.length; i++) {
        const c = part.text[i];
        if (c === '\\') i++;
        else if (c === '[') depth++;
        else if (c === ']' && --depth === 0) {
          const after = part.text.slice(i + 1);
          return after.startsWith('=') || after.startsWith('+=') ? w : undefined;
        }
      }
    }
  }
  return undefined;
}

const ANSI_C_ESCAPES: Record<string, number> = {
  ...SIMPLE_ESCAPE_BYTES,
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
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(end === -1 ? bytes : bytes.slice(0, end)));
}

/** The bytes of the escape whose letter is at `index`, and the index of its last character. */
// code-gauge-allow functionCognitiveComplexity -- Handles simple escapes, octal, braced/fixed hex, Unicode, and \cX escapes in $'...'.
function ansiCEscape(text: string, index: number): { bytes: number[]; last: number } {
  const next = text[index];
  const rest = text.slice(index + 1);
  if (Object.hasOwn(ANSI_C_ESCAPES, next)) return { bytes: [ANSI_C_ESCAPES[next]], last: index };
  if (/[0-7]/.test(next)) {
    const { value, count } = readRadixDigits(text, index, 3, 8);
    return { bytes: [value & 0xff], last: index + count - 1 };
  }
  const braced = next === 'x' ? /^\{([0-9A-Fa-f]*)\}?/.exec(rest) : undefined;
  if (braced) return { bytes: [Number.parseInt(braced[1] || '0', 16) & 0xff], last: index + braced[0].length };
  if (next === 'x' || next === 'u' || next === 'U') {
    const { value, count } = readRadixDigits(text, index + 1, next === 'x' ? 2 : next === 'u' ? 4 : 8, 16);
    if (count > 0) {
      if (next === 'x') return { bytes: [value & 0xff], last: index + count };
      const valid = value <= 0x10_ff_ff && (value < 0xd8_00 || value > 0xdf_ff);
      return {
        bytes: valid ? [...new TextEncoder().encode(String.fromCodePoint(value))] : [],
        last: index + count,
      };
    }
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

/** Removes the backslashes that quote `$`, `` ` ``, and a backslash in a here-document, and joins its continued lines. */
function unescapeHeredoc(text: string): string {
  return text.replaceAll(/\\([$`\\\n])/g, (_, c: string) => (c === '\n' ? '' : c));
}
