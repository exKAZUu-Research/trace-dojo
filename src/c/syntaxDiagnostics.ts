import type { Node, Parser } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';

export function cSyntaxDiagnostics(
  parser: Parser,
  source: string,
  root: Node,
  errors: SourceDiagnostic[],
  headerTypes: readonly string[]
): SourceDiagnostic[] {
  if (errors.length === 0) return errors;
  const failure = firstRecovery(parser, source);
  if (!failure) return errors;
  const illegal = firstIllegalConstruct(root, headerTypes);
  const row = failure.missingSemicolon ? failure.row : nextTokenRow(source, failure.row, failure.column);
  if (illegal && illegal.startPosition.row <= row)
    return [{ row: illegal.startPosition.row, message: 'ここには関数の定義や文を書けません。' }];
  return [{ row, message: failure.missingSemicolon ? '「;」が足りません。' : errors[0].message }];
}

interface RecoveryPosition {
  row: number;
  column: number;
  missingSemicolon: boolean;
}

// code-gauge-allow functionCognitiveComplexity 18 -- The logger callback tracks one recovery cycle and its parser versions; splitting it distributes that state.
function firstRecovery(parser: Parser, source: string): RecoveryPosition | undefined {
  const previous = parser.getLogger();
  const positions = new Map<string, { row: number; column: number }>();
  const budget = new ExecutionBudget();
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
      if (position) failure = { ...position, missingSemicolon: false };
    }
    if (failure && message.startsWith('recover_with_missing symbol:;,')) failure.missingSemicolon = true;
  });
  try {
    const tree = parser.parse(source);
    tree?.delete();
  } finally {
    parser.setLogger(previous ?? false);
  }
  return failure;
}

function nextTokenRow(source: string, row: number, column: number): number {
  const lines = source.split('\n');
  let at = lines.slice(0, row).reduce((length, line) => length + line.length + 1, 0) + column;
  let nextRow = row;
  while (at < source.length && /\s/.test(source[at])) {
    if (source[at] === '\n') nextRow++;
    at++;
  }
  return at === source.length ? lines.length - (source.endsWith('\n') ? 2 : 1) : nextRow;
}

function firstIllegalConstruct(root: Node, headerTypes: readonly string[]): Node | undefined {
  const typedefs = new Set(headerTypes);
  for (const definition of root.descendantsOfType('type_definition')) {
    for (const name of definition.childrenForFieldName('declarator')) typedefs.add(firstNamedLeaf(name).text);
  }
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
