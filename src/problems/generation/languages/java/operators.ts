import type { Node } from '@willbooster/web-tree-sitter';

import type { Selector } from '../../types';
import { expressionType, isNumeric } from './sourceFacts';

export const operatorFamilies = {
  arithmeticOperator: ['+', '-', '*', '/', '%'],
  comparisonOperator: ['<', '<=', '>', '>=', '==', '!='],
  logicalOperator: ['&&', '||', '!'],
  assignmentOperator: ['=', '+=', '-=', '*=', '/=', '%='],
  updateOperator: ['++', '--'],
} as const;
export type OperatorSelector = keyof typeof operatorFamilies;
const alternatives: Record<string, string[]> = {
  '+': ['-', '*'],
  '-': ['+', '*'],
  '*': ['+', '/'],
  '/': ['*', '+'],
  '%': ['/', '*'],
  '<': ['<=', '>'],
  '<=': ['<', '>='],
  '>': ['>=', '<'],
  '>=': ['>', '<='],
  '==': ['!='],
  '!=': ['=='],
  '&&': ['||'],
  '||': ['&&'],
  '!': [''],
  '=': ['+=', '-='],
  '+=': ['-=', '='],
  '-=': ['+=', '='],
  '*=': ['/=', '='],
  '/=': ['*=', '='],
  '%=': ['/=', '='],
  '++': ['--'],
  '--': ['++'],
};

export function operatorFamily(text: string): OperatorSelector | undefined {
  return (Object.keys(operatorFamilies) as OperatorSelector[]).find((key) =>
    (operatorFamilies[key] as readonly string[]).includes(text)
  );
}

/** Keep errors within learned operator families; signs and String concatenation are not binary numeric arithmetic. */
export function operatorReplacements(node: Node, learned: readonly Selector[]): string[] {
  const family = operatorFamily(node.text);
  if (!family || !learned.includes(family)) return [];
  const expression = node.parent;
  if (!expression) return [];
  if (family === 'arithmeticOperator') {
    if (!isNumeric(expressionType(expression))) return [];
    if (expression.type === 'unary_expression') return node.text === '+' ? ['-'] : ['+'];
  }
  if (family === 'assignmentOperator') {
    const left = expression.childForFieldName('left');
    if (!learned.includes('arithmeticOperator') || !left || !isNumeric(expressionType(left))) return [];
  }
  return alternatives[node.text] ?? [];
}

/** Parent-range mutations cannot bypass operator permissions by removing or rewriting an unlearned child. */
export function operatorsLearned(node: Node, learned: readonly Selector[]): boolean {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!nodeOperatorsLearned(current, learned)) return false;
    if (['string_literal', 'character_literal'].includes(current.type)) continue;
    for (const child of current.namedChildren) if (child) stack.push(child);
  }
  return true;
}

function nodeOperatorsLearned(node: Node, learned: readonly Selector[]): boolean {
  if (!['binary_expression', 'unary_expression', 'assignment_expression', 'update_expression'].includes(node.type))
    return true;
  return node.children.every((child) => {
    if (!child || child.isNamed) return true;
    if (['&', '|', '^', '~', '<<', '>>', '>>>'].includes(child.text)) return false;
    const family = operatorFamily(child.text);
    return !family || learned.includes(family);
  });
}
