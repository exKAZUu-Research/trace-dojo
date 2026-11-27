import type { Node, Parser, Tree } from '@willbooster/web-tree-sitter';

import { type SourceDiagnostic, sourceDiagnostic } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import { parseTree } from '../interpreter/treeSitter';
import { hasToken, isConstructorName } from './checker/syntax';

const INVALID_DECORATOR = 'デコレーターはここでは無効です。';
const OVERLOAD_DECORATOR = 'デコレーターが装飾できるのは、オーバーロードではなく、メソッドの実装のみです。';

/**
 * Blanks leading `@decorator` spans on `method_signature` and `abstract_method_signature` class members that the
 * tree-sitter grammar cannot parse, recording tsc's placement diagnostic for each repaired signature.
 */
export function repairDecoratedSignatures(
  parser: Parser,
  source: string,
  budget: ExecutionBudget
): { source: string; diagnostics: SourceDiagnostic[] } {
  if (!source.includes('@')) return { source, diagnostics: [] };
  const progress = (): void => budget.spend();
  let current = source;
  let tree = parseTree(parser, current, progress);
  if (!tree.rootNode.hasError) {
    tree.delete();
    return { source, diagnostics: [] };
  }
  const rejected = new Set<number>();
  const diagnostics: SourceDiagnostic[] = [];
  try {
    while (tree.rootNode.hasError) {
      const step = repairNextSignature(parser, current, tree, rejected, progress);
      if (!step) break;
      diagnostics.push(step.diagnostic);
      tree.delete();
      tree = step.tree;
      current = step.source;
    }
    return { source: current, diagnostics };
  } finally {
    tree.delete();
  }
}

function repairNextSignature(
  parser: Parser,
  current: string,
  tree: Tree,
  rejected: Set<number>,
  progress: () => void
): { source: string; tree: Tree; diagnostic: SourceDiagnostic } | undefined {
  for (const body of tree.rootNode.descendantsOfType('class_body')) {
    if (!body?.hasError) continue;
    const { children } = body;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!child || rejected.has(child.startIndex)) continue;
      const decorators = candidateDecorators(children, index);
      if (!decorators) continue;
      progress();
      const start = decorators[0].startIndex;
      const end = decorators.at(-1)!.endIndex;
      const candidate =
        current.slice(0, start) + current.slice(start, end).replaceAll(/[^\r\n]/g, ' ') + current.slice(end);
      const nextTree = parseTree(parser, candidate, progress);
      const member = repairedSignature(nextTree.rootNode, body.startIndex, start, end);
      if (member) {
        return {
          source: candidate,
          tree: nextTree,
          diagnostic: signatureDiagnostic(decorators[0], member),
        };
      }
      nextTree.delete();
      rejected.add(start);
    }
  }
  return undefined;
}

function candidateDecorators(children: (Node | null)[], index: number): Node[] | undefined {
  const child = children[index];
  if (!child) return undefined;
  if (child.type === 'decorator') return directDecorators(children, index);
  const decorators = leadingMemberDecorators(child);
  if (decorators.length === 0 || decorators[0].startIndex !== child.startIndex) return undefined;
  return child.hasError || hasErrorOrMissing(children[index + 1]) ? decorators : undefined;
}

function directDecorators(children: (Node | null)[], index: number): Node[] | undefined {
  const decorators: Node[] = [];
  let cursor = index;
  while (children[cursor]?.type === 'decorator' && !children[cursor]!.hasError) {
    decorators.push(children[cursor]!);
    cursor++;
  }
  return decorators.length > 0 && hasErrorOrMissing(children[cursor]) ? decorators : undefined;
}

function leadingMemberDecorators(member: Node): Node[] {
  const decorators: Node[] = [];
  for (const inner of member.namedChildren) {
    if (inner?.type === 'decorator' && !inner.hasError) decorators.push(inner);
    else break;
  }
  return decorators;
}

function hasErrorOrMissing(node: Node | null | undefined): boolean {
  return Boolean(node?.hasError || node?.isMissing);
}

function repairedSignature(root: Node, bodyStart: number, start: number, end: number): Node | undefined {
  const nextBody = root.descendantsOfType('class_body').find((body) => body?.startIndex === bodyStart);
  const member = nextBody?.namedChildren.find((child) => child && child.startIndex >= end && child.type !== 'comment');
  if (!nextBody || !member || member.hasError) return undefined;
  if (member.type !== 'method_signature' && member.type !== 'abstract_method_signature') return undefined;
  const cleanGap = nextBody.children.every(
    (child) => !child || child.endIndex <= start || child.startIndex >= member.startIndex || !hasErrorOrMissing(child)
  );
  return cleanGap ? member : undefined;
}

function signatureDiagnostic(firstDecorator: Node, member: Node): SourceDiagnostic {
  const invalid =
    hasToken(member, 'get') || hasToken(member, 'set') || isConstructorName(member.childForFieldName('name'));
  return sourceDiagnostic(
    firstDecorator.startPosition.row,
    firstDecorator.startIndex,
    invalid ? INVALID_DECORATOR : OVERLOAD_DECORATOR
  );
}
