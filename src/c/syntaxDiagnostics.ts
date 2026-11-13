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
  const budget = new ExecutionBudget();
  budget.spend(source.length);
  const failure = firstRecovery(parser, source, budget);
  if (!failure) return errors;
  const illegal = firstIllegalConstruct(root, headerTypes);
  const next = nextToken(source, failure);
  const semicolon = missingSemicolonRow(parser, source, next.offset, budget);
  const row = semicolon ?? next.row;
  if (illegal && illegal.startPosition.row <= row)
    return [{ row: illegal.startPosition.row, message: 'ここには関数の定義や文を書けません。' }];
  return [{ row, message: semicolon !== undefined ? '「;」が足りません。' : errors[0].message }];
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
  failureOffset: number,
  budget: ExecutionBudget
): number | undefined {
  const prefix = source.slice(0, failureOffset);
  const lines = prefix.split('\n');
  let offset = prefix.lastIndexOf('\n');
  for (let row = lines.length - 2; row >= 0; row--) {
    const line = lines[row].trimEnd();
    const end = offset - lines[row].length + line.length;
    offset -= lines[row].length + 1;
    if (line.endsWith(';')) return;
    if (!line || line.endsWith('{') || /\breturn$/.test(line)) continue;
    budget.spend(source.length);
    const patched = source.slice(0, end) + ';' + source.slice(end);
    const recovered = firstRecovery(parser, patched, budget);
    if (!recovered) return row;
    const next = nextToken(patched, recovered).offset;
    if (next - (next > end ? 1 : 0) > failureOffset) return row;
  }
  return undefined;
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
