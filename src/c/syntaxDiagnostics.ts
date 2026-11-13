import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import {
  aggregateDeclarationFollowers,
  declaratorFollowers,
  sizeofTypeFollowers,
  type SourceToken,
  sourceTokens,
  type TypeScope,
} from './syntaxTokens';

export function cSyntaxDiagnostics(
  parser: Parser,
  source: string,
  root: Node,
  errors: SourceDiagnostic[],
  context: { headerTypes: readonly string[]; typeScopes: readonly TypeScope[]; errorOffset?: number }
): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const { headerTypes, typeScopes, errorOffset } = context;
  const budget = new ExecutionBudget();
  budget.spend(source.length);
  const failure = errorOffset === undefined ? firstRecovery(parser, source, budget) : undefined;
  if (!failure && errorOffset === undefined) return errors;
  const illegal = firstIllegalConstruct(root, headerTypes);
  const next = errorOffset === undefined ? nextToken(source, failure!) : { offset: errorOffset, row: errors[0].row };
  const tokens = sourceTokens(source, budget);
  const names = knownTypes(root, headerTypes);
  const earlyError = invalidCToken(root);
  if (earlyError && earlyError.startIndex < next.offset) {
    next.offset = earlyError.startIndex;
    next.row = earlyError.startPosition.row;
  }
  const candidates = [
    ...sizeofTypeFollowers(tokens, typeScopes, names, budget),
    ...aggregateDeclarationFollowers(tokens, typeScopes, names, budget),
    ...declaratorFollowers(
      tokens,
      root.descendantsOfType(['pointer_declarator', 'macro_specifier']).map((node) => node.startIndex),
      typeScopes,
      names,
      budget
    ),
  ]
    .filter((token) => token.start < next.offset)
    .toSorted((a, b) => a.start - b.start);
  let semicolon: number | undefined;
  for (const candidate of candidates) {
    semicolon = missingSemicolonRow(parser, source, tokens, candidate.start, budget);
    if (semicolon !== undefined) break;
  }
  semicolon ??= missingSemicolonRow(parser, source, tokens, next.offset, budget);
  const row = semicolon ?? next.row;
  if (illegal && illegal.startPosition.row <= row)
    return [{ row: illegal.startPosition.row, message: 'ここには関数の定義や文を書けません。' }];
  return [{ row, message: semicolon !== undefined ? '「;」が足りません。' : errors[0].message }];
}

export class CSyntaxError extends CompileError {
  readonly offset: number;

  constructor(node: Node, message: string) {
    super([{ row: node.startPosition.row, message }]);
    this.offset = node.startIndex;
  }
}

interface RecoveryPosition {
  row: number;
  column: number;
}

// code-gauge-allow functionCognitiveComplexity 17 -- One callback tracks the parser versions and first recovery cycle while its logger is installed.
function firstRecovery(parser: Parser, source: string, budget: ExecutionBudget): RecoveryPosition | undefined {
  const previous = parser.getLogger();
  const positions = new Map<string, { row: number; column: number }>();
  let failure: RecoveryPosition | undefined;
  let settled = false;
  // Branch-local failures are speculative; capture the parser's first resumed recovery cycle.
  // Tree-sitter's logger reports byte columns; this runtime supplies UTF-16 input.
  parser.setLogger((message, isLex) => {
    if (settled || isLex) return;
    budget.spend();
    const process = /^process version:(\d+), .*row:(\d+), col:(\d+)/.exec(message);
    if (process) {
      if (failure) settled = true;
      else positions.set(process[1], { row: Number(process[2]), column: Number(process[3]) / 2 });
      return;
    }
    const resume = /^resume version:(\d+)/.exec(message);
    if (resume && !failure) {
      const position = positions.get(resume[1]);
      if (position) failure = position;
    }
  });
  try {
    const tree = parser.parse(source);
    if (tree && !tree.rootNode.hasError) failure = undefined;
    tree?.delete();
  } finally {
    parser.setLogger(previous ?? false);
  }
  return failure;
}

function nextToken(source: string, position: RecoveryPosition): { offset: number; row: number } {
  const lines = source.split('\n');
  let at = lines.slice(0, position.row).reduce((length, line) => length + line.length + 1, 0) + position.column;
  let row = position.row;
  while (at < source.length && /\s/.test(source[at])) {
    if (source[at] === '\n') row++;
    at++;
  }
  return { offset: at, row: at === source.length ? lines.length - (source.endsWith('\n') ? 2 : 1) : row };
}

function missingSemicolonRow(
  parser: Parser,
  source: string,
  tokens: SourceToken[],
  failureOffset: number,
  budget: ExecutionBudget
): number | undefined {
  const previous = tokens.findLast((token) => token.end <= failureOffset);
  if (!previous || ['return', ';', '{'].includes(previous.token.text)) return;
  const end = previous.end;
  budget.spend(source.length);
  const patched = source.slice(0, end) + ';' + source.slice(end);
  const recovered = firstRecovery(parser, patched, budget);
  if (!recovered) return previous.token.row;
  const next = nextToken(patched, recovered).offset;
  if (next - (next > end ? 1 : 0) > failureOffset) return previous.token.row;
  return undefined;
}

function invalidCToken(root: Node): Node | undefined {
  const invalid = [
    ...root
      .descendantsOfType('concatenated_string')
      .flatMap((node) =>
        node.namedChildren.filter((child) => child.type !== 'string_literal' && child.type !== 'comment')
      ),
    ...root.descendantsOfType(['update_expression', 'pointer_expression']).flatMap((node) => invalidLvalueToken(node)),
  ];
  return invalid.toSorted((a, b) => a.startIndex - b.startIndex)[0];
}

function invalidLvalueToken(node: Node): Node[] {
  const operand = node.childForFieldName('argument');
  const operator = node.childForFieldName('operator');
  if (!operand || !operator) return [];
  const prefix = operator.startIndex < operand.startIndex;
  return operand.type === 'update_expression' && prefix && (node.type === 'update_expression' || operator.type === '&')
    ? [operator]
    : [];
}

function knownTypes(root: Node, headerTypes: readonly string[]): ReadonlySet<string> {
  const types = new Set(headerTypes);
  for (const definition of root.descendantsOfType('type_definition'))
    for (const name of definition.childrenForFieldName('declarator')) types.add(firstNamedLeaf(name).text);
  return types;
}

function firstIllegalConstruct(root: Node, headerTypes: readonly string[]): Node | undefined {
  const typedefs = knownTypes(root, headerTypes);
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'function_definition' && node.parent?.type === 'compound_statement') return node;
    if (
      node.parent?.type === 'translation_unit' &&
      node.type.endsWith('_statement') &&
      !typedefs.has(firstNamedLeaf(node).text)
    )
      return node;
    pending.push(...node.namedChildren.toReversed());
  }
  return undefined;
}

function firstNamedLeaf(node: Node): Node {
  let leaf = node;
  while (leaf.firstNamedChild) leaf = leaf.firstNamedChild;
  return leaf;
}
