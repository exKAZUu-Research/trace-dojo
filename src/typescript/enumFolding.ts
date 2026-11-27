import { nameOf, type Node } from '../javascript/convertNodes';
import { numberArithmetic } from '../javascript/expressionEvaluator';
import { decodeStringLiteral, decodeTemplateFragment } from '../javascript/literals';

/**
 * What tsx's esbuild knows of an enum member's value as it compiles the enum: a number it folded, a string, or
 * nothing, as for a member whose initializer reads a variable.
 */
export type FoldedValue = { kind: 'number'; value: number } | { kind: 'string'; value?: string } | undefined;

/** The folded members of the enum a name refers to where an initializer is, if it is an enum compiled before. */
export type EnumsInScope = (name: string) => Map<string, FoldedValue> | undefined;

const arithmeticOperators = new Set(['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>']);

/**
 * The value esbuild folds an enum initializer to: number and string literals, template literals (always strings),
 * string-producing operations, arithmetic on folded numbers, and earlier members of the same enum or of enums compiled before.
 */
export function foldEnumValue(node: Node, enums: EnumsInScope): FoldedValue {
  switch (node.type) {
    case 'number': {
      return { kind: 'number', value: Number(node.text.replaceAll('_', '')) };
    }
    case 'string': {
      return { kind: 'string', value: decodeStringLiteral(node.text) };
    }
    case 'template_string': {
      return foldTemplate(node, enums);
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
    case 'ternary_expression': {
      return foldTernary(node, enums);
    }
    case 'sequence_expression': {
      const last = node.namedChildren.at(-1);
      return last && foldEnumValue(last, enums)?.kind === 'string' ? { kind: 'string' } : undefined;
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

function foldTemplate(node: Node, enums: EnumsInScope): FoldedValue {
  let value = '';
  for (const child of node.children) {
    if (child.type === 'string_fragment' || child.type === 'escape_sequence') {
      value += decodeTemplateFragment(child.text.replaceAll(/\r\n?/g, '\n'));
    } else if (child.type === 'template_substitution') {
      const inner = child.namedChildren[0] ? foldEnumValue(child.namedChildren[0], enums) : undefined;
      if (inner?.value === undefined) return { kind: 'string' };
      value += String(inner.value);
    }
  }
  return { kind: 'string', value };
}

function foldUnary(node: Node, enums: EnumsInScope): FoldedValue {
  const operator = node.childForFieldName('operator')?.text;
  if (operator === 'typeof') return { kind: 'string' };
  const operand = foldEnumValue(node.childForFieldName('argument') as Node, enums);
  if (operand?.kind !== 'number') return undefined;
  if (operator === '-') return { kind: 'number', value: -operand.value };
  if (operator === '+') return operand;
  return operator === '~' ? { kind: 'number', value: ~operand.value } : undefined;
}

function foldBinary(node: Node, enums: EnumsInScope): FoldedValue {
  const operator = node.childForFieldName('operator')?.text ?? '';
  const left = foldEnumValue(node.childForFieldName('left') as Node, enums);
  const right = foldEnumValue(node.childForFieldName('right') as Node, enums);
  if (operator === '+' && (left?.kind === 'string' || right?.kind === 'string')) {
    const value = left?.value !== undefined && right?.value !== undefined ? `${left.value}${right.value}` : undefined;
    return { kind: 'string', value };
  }
  if (left?.kind !== 'number' || right?.kind !== 'number' || !arithmeticOperators.has(operator)) return undefined;
  return { kind: 'number', value: numberArithmetic(operator, left.value, right.value) };
}

function foldTernary(node: Node, enums: EnumsInScope): FoldedValue {
  const consequent = node.childForFieldName('consequence');
  const alternate = node.childForFieldName('alternative');
  return consequent &&
    alternate &&
    foldEnumValue(consequent, enums)?.kind === 'string' &&
    foldEnumValue(alternate, enums)?.kind === 'string'
    ? { kind: 'string' }
    : undefined;
}

/** `E.A` or `E["A"]`, a member of an enum compiled before. */
function foldedMember(node: Node, enums: EnumsInScope): FoldedValue {
  const object = node.childForFieldName('object');
  if (object?.type !== 'identifier') return undefined;
  const name = memberKeyName(node);
  return name === undefined ? undefined : enums(nameOf(object))?.get(name);
}

export function memberKeyName(node: Node): string | undefined {
  if (node.type === 'member_expression') {
    const property = node.childForFieldName('property');
    return property ? nameOf(property) : undefined;
  }
  const index = node.childForFieldName('index');
  if (!index) return undefined;
  if (index.type === 'string') return decodeStringLiteral(index.text);
  if (index.type !== 'template_string' || index.namedChildren.some((child) => child.type === 'template_substitution'))
    return undefined;
  return decodeTemplateFragment(index.text.slice(1, -1));
}

/** What a member without an initializer is: 0 first, one more than a folded number before it, or else undefined. */
export function countedEnumValue(previous: FoldedValue, isFirst: boolean): FoldedValue {
  if (isFirst) return { kind: 'number', value: 0 };
  return previous?.kind === 'number' ? { kind: 'number', value: previous.value + 1 } : undefined;
}
