import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';

export function cSyntaxDiagnostics(
  parser: Parser,
  source: string,
  root: Node,
  errors: SourceDiagnostic[],
  context: { headerTypes: readonly string[]; typeGroups: ReadonlySet<number>; errorOffset?: number }
): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const { headerTypes, typeGroups, errorOffset } = context;
  const budget = new ExecutionBudget();
  budget.spend(source.length);
  const failure = errorOffset === undefined ? firstRecovery(parser, source, budget) : undefined;
  if (!failure && errorOffset === undefined) return errors;
  const illegal = firstIllegalConstruct(root, headerTypes);
  const next = errorOffset === undefined ? nextToken(source, failure!) : { offset: errorOffset, row: errors[0].row };
  const earlyError = invalidCToken(root, source, headerTypes, typeGroups);
  if (earlyError && earlyError.startIndex < next.offset) {
    next.offset = earlyError.startIndex;
    next.row = earlyError.startPosition.row;
  }
  const semicolon = missingSemicolonRow(parser, source, root, next.offset, budget);
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
  root: Node,
  failureOffset: number,
  budget: ExecutionBudget
): number | undefined {
  const previous = previousToken(root, failureOffset, budget);
  if (!previous || ['return', ';', '{'].includes(previous.type)) return;
  const end = previous.endIndex;
  budget.spend(source.length);
  const patched = source.slice(0, end) + ';' + source.slice(end);
  const recovered = firstRecovery(parser, patched, budget);
  if (!recovered) return previous.endPosition.row;
  const next = nextToken(patched, recovered).offset;
  if (next - (next > end ? 1 : 0) > failureOffset) return previous.endPosition.row;
  return undefined;
}

function previousToken(root: Node, offset: number, budget: ExecutionBudget): Node | undefined {
  let previous: Node | undefined;
  const pending = [root];
  while (pending.length > 0) {
    budget.spend();
    const node = pending.pop()!;
    if (node.startIndex >= offset || node.isMissing) continue;
    if (node.childCount) pending.push(...node.children.toReversed());
    else if (node.endIndex <= offset && node.startIndex < node.endIndex) previous = node;
  }
  return previous;
}

function invalidCToken(
  root: Node,
  source: string,
  headerTypes: readonly string[],
  typeGroups: ReadonlySet<number>
): Node | undefined {
  const types = knownTypes(root, headerTypes);
  const invalid = [
    ...root
      .descendantsOfType('concatenated_string')
      .flatMap((node) =>
        node.namedChildren.filter((child) => child.type !== 'string_literal' && child.type !== 'comment')
      ),
    ...root
      .descendantsOfType('sizeof_expression')
      .flatMap((node) => invalidSizeofTokens(node, source, types, typeGroups)),
    ...root
      .descendantsOfType([
        'update_expression',
        'pointer_expression',
        'call_expression',
        'subscript_expression',
        'field_expression',
      ])
      .flatMap((node) => invalidPostfixTokens(node, typeGroups)),
  ];
  return invalid.toSorted((a, b) => a.startIndex - b.startIndex)[0];
}

function knownTypes(root: Node, headerTypes: readonly string[]): ReadonlySet<string> {
  const types = new Set(headerTypes);
  for (const definition of root.descendantsOfType('type_definition'))
    for (const name of definition.childrenForFieldName('declarator')) types.add(firstNamedLeaf(name).text);
  return types;
}

function invalidSizeofTokens(
  node: Node,
  source: string,
  types: ReadonlySet<string>,
  groups: ReadonlySet<number>
): Node[] {
  const value = node.childForFieldName('value');
  if (!value) return [];
  if (value.type === 'cast_expression') {
    const type = value.childForFieldName('type')?.childForFieldName('type');
    const children = value.children.filter((child) => child.type !== 'comment');
    const close = children.findIndex((child) => child.type === ')');
    const following = children[close + 1];
    return type &&
      following &&
      close !== -1 &&
      (type.type !== 'type_identifier' || types.has(source.slice(type.startIndex, type.endIndex).trim()))
      ? [following]
      : [];
  }
  let current = value;
  for (;;) {
    const operand = current.childForFieldName('argument') ?? current.childForFieldName('function');
    if (!operand) return [];
    if (groups.has(operand.startIndex)) {
      const token = postfixToken(current);
      return token ? [token] : [];
    }
    current = operand;
  }
}

function invalidPostfixTokens(node: Node, typeGroups: ReadonlySet<number>): Node[] {
  const operand = node.childForFieldName('argument') ?? node.childForFieldName('function');
  const operator = node.childForFieldName('operator');
  if (!operand) return [];
  const prefix = operator && operator.startIndex < operand.startIndex;
  if (operand.type === 'update_expression' && prefix && (node.type === 'update_expression' || operator.type === '&'))
    return [operator];
  if (prefix || !sizeofTypeOperand(operand, typeGroups)) return [];
  const token = postfixToken(node);
  return token ? [token] : [];
}

function postfixToken(node: Node): Node | undefined {
  return (
    node.childForFieldName('operator') ??
    node.childForFieldName('arguments') ??
    node.children.find((child) => child.type === '[')
  );
}

function sizeofTypeOperand(node: Node, typeGroups: ReadonlySet<number>): boolean {
  if (node.type !== 'sizeof_expression') return false;
  if (node.childForFieldName('type')) return true;
  const value = node.childForFieldName('value');
  return value !== null && typeGroups.has(value.startIndex);
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
