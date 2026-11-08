import type { Node } from '@willbooster/web-tree-sitter';

import { GenerationLimitError, MAX_REPLACEMENTS } from '../../limits';
import type { Selector } from '../../types';
import { operatorReplacements, operatorsLearned } from './operators';
import { expressionType, isVariableUse, isVoidMethod, relatedClasses, visibleBindings } from './sourceFacts';

const turtleMethods = [
  ['forward', 'backward', 'turnLeft', 'turnRight'],
  ['前に進む', '後に戻る', '左を向く', '右を向く'],
];
export type Role = 'expression' | 'operator' | 'keyword' | 'type' | 'name' | 'arguments' | 'modifier' | 'statement';

/** Each edit has its own learning prerequisites, independent of which selector exposed the range. */
export function replacementsFor(node: Node, role: Role, text: string, learned: readonly Selector[]): string[] {
  if (role === 'operator') return operatorReplacements(node, learned);
  if (role === 'keyword') return jumpChanges(node, learned);
  if (role === 'modifier') return learned.includes('modifier') ? modifierChanges(node) : [];
  if (role === 'type') return typeChanges(node, text, learned);
  if (role === 'name') return methodChanges(node, text, learned);
  if (!operatorsLearned(node, learned)) return [];
  if (role === 'statement') return statementChanges(node, learned);
  if (role === 'arguments') return invocationLearned(node.parent, learned) ? argumentChanges(node, text) : [];
  return [...new Set(expressionChanges(node, text, learned))].filter((value) => value !== text);
}

function expressionChanges(node: Node, text: string, learned: readonly Selector[]): string[] {
  const results: string[] = [];
  if (learned.includes('literal')) results.push(...literalChanges(node, learned));
  // Reference confusion uses compatible visible bindings, never arbitrary constants or unknown types.
  if (learned.includes('variableReference') && node.type === 'identifier' && isVariableUse(node)) {
    const type = expressionType(node);
    if (type)
      results.push(
        ...visibleBindings(node)
          .filter((b) => b.type === type)
          .map((b) => b.name)
      );
  }
  if (learned.includes('logicalOperator')) results.push(...logicalChanges(node));
  if (learned.includes('member') && learned.includes('variableReference')) results.push(...shadowChanges(node));
  if (invocationLearned(node, learned)) results.push(...invocationChanges(node, learned));
  if (learned.includes('array') && node.type === 'array_access') {
    const array = node.childForFieldName('array'),
      index = node.childForFieldName('index');
    const nestedIndex = array?.childForFieldName('index'),
      nestedArray = array?.childForFieldName('array');
    if (index && nestedIndex && nestedArray) results.push(`${nestedArray.text}[${index.text}][${nestedIndex.text}]`);
  }
  return results.filter((value) => value !== text);
}

function statementChanges(node: Node, learned: readonly Selector[]): string[] {
  if (!isVoidMethod(node) || !learned.includes('return')) return [];
  return node.type === 'return_statement' ? [''] : learned.includes('throw') ? ['return'] : [];
}

/** Omitting this matters only when a local or parameter shadows this exact field. */
function shadowChanges(node: Node): string[] {
  if (node.type !== 'field_access' || node.childForFieldName('object')?.text !== 'this') return [];
  const field = node.childForFieldName('field')?.text;
  const type = expressionType(node);
  return field && type && visibleBindings(node).some((b) => b.kind !== 'field' && b.name === field && b.type === type)
    ? [field]
    : [];
}

/** Off-by-one/count mistakes are bounded decimal ints; preserve radix, suffix and precision by skipping unsupported literals. */
function literalChanges(node: Node, learned: readonly Selector[]): string[] {
  if (node.type === 'true' || node.type === 'false') return [node.type === 'true' ? 'false' : 'true'];
  if (node.type !== 'decimal_integer_literal' || !/^\d+$/.test(node.text)) return [];
  const n = Number(node.text);
  if (!Number.isSafeInteger(n) || n > 2_147_483_647) return [];
  return [n + 1, n - 1, 0, 1, 2]
    .filter((value) => value <= 2_147_483_647 && (value >= 0 || learned.includes('arithmeticOperator')))
    .map(String);
}

/** Dropping a conjunct/disjunct or negation tests Boolean reasoning, even when an if header owns the candidate. */
function logicalChanges(node: Node): string[] {
  if (expressionType(node) !== 'boolean') return [];
  const operator = node.childForFieldName('operator')?.text ?? node.children.find((child) => child?.text === '!')?.text;
  if (node.type === 'binary_expression' && (operator === '&&' || operator === '||')) {
    const left = node.childForFieldName('left'),
      right = node.childForFieldName('right');
    return left && right ? [left.text, right.text] : [];
  }
  if (node.type === 'unary_expression' && operator === '!') {
    const operand = node.childForFieldName('operand') ?? node.namedChildren.at(-1);
    return operand ? [operand.text] : [];
  }
  return [];
}

function typeChanges(node: Node, text: string, learned: readonly Selector[]): string[] {
  if (node.parent?.type === 'object_creation_expression' && learned.includes('construction'))
    return relatedClasses(node, text);
  if (
    node.parent?.namedChildren.some(
      (child) => child?.type === 'variable_declarator' && child.childForFieldName('dimensions')
    )
  )
    return [];
  // Narrow fractional storage to int; do not introduce double into an integer-only exercise.
  if (
    learned.includes('variableDeclaration') &&
    learned.includes('arithmeticOperator') &&
    ['local_variable_declaration', 'field_declaration'].includes(node.parent?.type ?? '')
  )
    return text === 'double' ? ['int'] : [];
  return [];
}

function methodChanges(node: Node, text: string, learned: readonly Selector[]): string[] {
  if (!learned.includes('call') || node.parent?.type !== 'method_invocation') return [];
  const receiver = node.parent.childForFieldName('object');
  if (!receiver || expressionType(receiver) !== 'Turtle') return [];
  return (turtleMethods.find((group) => group.includes(text)) ?? []).filter((value) => value !== text);
}

function modifierChanges(node: Node): string[] {
  const declaration = node.parent?.parent;
  if (!declaration) return [];
  const member = ['method_declaration', 'field_declaration'].includes(declaration.type);
  // Static omission changes shared state/dispatch; access changes and final omission test member/local restrictions.
  if (node.text === 'static' && member) return [''];
  if (member && (node.text === 'public' || node.text === 'private'))
    return [node.text === 'public' ? 'private' : 'public'];
  if (node.text === 'final' && (member || declaration.type === 'local_variable_declaration')) return [''];
  return [];
}

function jumpChanges(node: Node, learned: readonly Selector[]): string[] {
  if (!learned.includes('break') || !learned.includes('continue') || !['break', 'continue'].includes(node.text))
    return [];
  if (node.parent?.namedChildren.some((child) => child?.type === 'identifier')) return [];
  for (let scope = node.parent?.parent; scope; scope = scope.parent) {
    if (['class_body', 'lambda_expression', 'method_declaration', 'constructor_declaration'].includes(scope.type))
      return [];
    if (node.text === 'break' && scope.type === 'switch_expression') return [];
    if (['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'].includes(scope.type))
      return [node.text === 'break' ? 'continue' : 'break'];
  }
  return [];
}

function invocationLearned(node: Node | null | undefined, learned: readonly Selector[]): boolean {
  return (
    !!node &&
    (node.type === 'object_creation_expression'
      ? learned.includes('construction')
      : ['method_invocation', 'explicit_constructor_invocation'].includes(node.type) && learned.includes('call'))
  );
}

function invocationChanges(node: Node, learned: readonly Selector[]): string[] {
  const results: string[] = [];
  const args = node.childForFieldName('arguments');
  if (args)
    for (const value of argumentChanges(args, args.text.slice(1, -1)))
      results.push(patch(node, args.startIndex + 1, args.endIndex - 1, value));
  const type = node.childForFieldName('type');
  if (type && learned.includes('construction'))
    for (const name of relatedClasses(node, type.text)) results.push(patch(node, type.startIndex, type.endIndex, name));
  return results;
}

/** Missing arguments and pair swaps model arity/order mistakes; the interpreter checks whether they affect the exercise. */
function argumentChanges(node: Node, text: string): string[] {
  const args = node.namedChildren.filter((child): child is Node => !!child && !child.type.endsWith('comment'));
  const count = args.length;
  if (1 + count + (count * (count - 1)) / 2 > MAX_REPLACEMENTS)
    throw new GenerationLimitError('Too many argument permutations');
  const values = args.map((child) => child.text),
    results = [''];
  for (let i = 0; i < values.length; i++) {
    results.push(values.filter((_, index) => index !== i).join(', '));
    for (let j = i + 1; j < values.length; j++) {
      const swapped = [...values];
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
      results.push(swapped.join(', '));
    }
  }
  return [...new Set(results)].filter((value) => value !== text);
}
function patch(node: Node, start: number, end: number, replacement: string): string {
  return node.text.slice(0, start - node.startIndex) + replacement + node.text.slice(end - node.startIndex);
}
