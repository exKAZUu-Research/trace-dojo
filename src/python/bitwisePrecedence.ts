import type { Node } from '@willbooster/web-tree-sitter';

import type { BinaryOperator, Expression } from './ast';

/** The binding strength of the bitwise operators in Python, weakest first. */
export const BITWISE_PRECEDENCE: Record<string, number> = { '|': 0, '^': 1, '&': 2 };

/** Groups operands joined by bitwise operators, left to right within one strength, from `level` up. */
export function groupBitwise(operands: Expression[], operators: Node[], level = 0): Expression {
  if (level > 2) return operands[0];
  const parts: { operands: Expression[]; operators: Node[] }[] = [{ operands: [], operators: [] }];
  const joins: Node[] = [];
  for (const [index, operand] of operands.entries()) {
    const part = parts.at(-1) as { operands: Expression[]; operators: Node[] };
    part.operands.push(operand);
    const operator = operators.at(index);
    if (operator === undefined) break;
    if (BITWISE_PRECEDENCE[operator.type] === level) {
      joins.push(operator);
      parts.push({ operands: [], operators: [] });
    } else {
      part.operators.push(operator);
    }
  }
  let result = groupBitwise(parts[0].operands, parts[0].operators, level + 1);
  for (const [index, join] of joins.entries()) {
    const right = groupBitwise(parts[index + 1].operands, parts[index + 1].operators, level + 1);
    result = { kind: 'binary', operator: join.type as BinaryOperator, left: result, right, row: result.row };
  }
  return result;
}
