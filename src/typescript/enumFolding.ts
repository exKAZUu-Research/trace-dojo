import { nameOf, type Node } from '../javascript/convertNodes';
import { numberArithmetic } from '../javascript/expressionEvaluator';
import { decodeStringLiteral } from '../javascript/literals';

/**
 * What tsx's esbuild knows of an enum member's value as it compiles the enum: a number it folded, a string, or
 * nothing, as for a member whose initializer reads a variable.
 */
export type FoldedValue = { kind: 'number'; value: number } | { kind: 'string' } | undefined;

const arithmeticOperators = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);

/**
 * The value esbuild folds an enum initializer to: number and string literals, template literals (always strings),
 * arithmetic on folded numbers, and members of the enums compiled before, by their enum's name and theirs.
 */
export function foldEnumValue(node: Node, enums: Map<string, Map<string, FoldedValue>>): FoldedValue {
  switch (node.type) {
    case 'number': {
      return { kind: 'number', value: Number(node.text.replaceAll('_', '')) };
    }
    case 'string':
    case 'template_string': {
      return { kind: 'string' };
    }
    case 'parenthesized_expression': {
      return node.namedChildren[0] ? foldEnumValue(node.namedChildren[0], enums) : undefined;
    }
    case 'unary_expression': {
      return foldUnary(node, enums);
    }
    case 'binary_expression': {
      return foldBinary(node, enums);
    }
    case 'member_expression':
    case 'subscript_expression': {
      return foldedMember(node, enums);
    }
    default: {
      return undefined;
    }
  }
}

function foldUnary(node: Node, enums: Map<string, Map<string, FoldedValue>>): FoldedValue {
  const operator = node.childForFieldName('operator')?.text;
  const operand = foldEnumValue(node.childForFieldName('argument') as Node, enums);
  if (operand?.kind !== 'number') return undefined;
  if (operator === '-') return { kind: 'number', value: -operand.value };
  if (operator === '+') return operand;
  return operator === '~' ? { kind: 'number', value: ~operand.value } : undefined;
}

function foldBinary(node: Node, enums: Map<string, Map<string, FoldedValue>>): FoldedValue {
  const operator = node.childForFieldName('operator')?.text ?? '';
  const left = foldEnumValue(node.childForFieldName('left') as Node, enums);
  const right = foldEnumValue(node.childForFieldName('right') as Node, enums);
  if (operator === '+' && left && right && (left.kind === 'string' || right.kind === 'string'))
    return { kind: 'string' };
  if (left?.kind !== 'number' || right?.kind !== 'number' || !arithmeticOperators.has(operator)) return undefined;
  return { kind: 'number', value: numberArithmetic(operator, left.value, right.value) };
}

/** `E.A` or `E["A"]`, a member of an enum compiled before. */
function foldedMember(node: Node, enums: Map<string, Map<string, FoldedValue>>): FoldedValue {
  const object = node.childForFieldName('object');
  const key = node.type === 'member_expression' ? node.childForFieldName('property') : node.childForFieldName('index');
  if (object?.type !== 'identifier' || !key) return undefined;
  const name = key.type === 'string' ? decodeStringLiteral(key.text) : nameOf(key);
  return enums.get(nameOf(object))?.get(name);
}

/** What a member without an initializer is: 0 first, one more than a folded number before it, or else undefined. */
export function countedEnumValue(previous: FoldedValue, isFirst: boolean): FoldedValue {
  if (isFirst) return { kind: 'number', value: 0 };
  return previous?.kind === 'number' ? { kind: 'number', value: previous.value + 1 } : undefined;
}
