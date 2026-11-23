import { field, isOptionalChain, namedChildren, type Node } from './convertNodes';
import { decodeStringLiteral, decodeTemplateFragment } from './literals';

type Print = (node: Node) => string | undefined;

/** A literal V8's parser makes of an expression, folding operators on number and string literals. */
type Folded =
  | { kind: 'number'; value: number }
  | { kind: 'string'; text: string }
  | { kind: 'boolean'; value: boolean };

const INTERMEDIATE = '(intermediate value)';
const WORD_OPERATORS = new Set(['typeof', 'void', 'delete']);

/**
 * How V8's CallPrinter prints an operator expression: after the parser's constant folding, fully parenthesized, with
 * a chain of one binary operator flat, `!=` as the negated `==`, an assignment as its target, and a conditional, a
 * template, or a sequence by its parts; `undefined` for another expression.
 */
export function printedOperation(node: Node, print: Print): string | undefined {
  const folded = fold(node);
  if (folded) return printedLiteral(folded);
  const operand = (child: Node): string => (isOptionalChain(child) ? undefined : print(child)) ?? INTERMEDIATE;
  switch (node.type) {
    case 'binary_expression': {
      return printedBinary(node, operand);
    }
    case 'unary_expression': {
      const operator = field(node, 'operator').text;
      return `(${operator}${WORD_OPERATORS.has(operator) ? ' ' : ''}${operand(field(node, 'argument'))})`;
    }
    case 'update_expression': {
      const argument = field(node, 'argument');
      const operator = node.children.find((child) => child.type === '++' || child.type === '--')?.type ?? '';
      const prefix = node.startIndex < argument.startIndex;
      return `(${prefix ? operator : ''}${operand(argument)}${prefix ? '' : operator})`;
    }
    case 'sequence_expression': {
      return `(${sequence(node).map(operand).join(' , ')})`;
    }
    case 'assignment_expression':
    case 'augmented_assignment_expression': {
      return print(field(node, 'left'));
    }
    case 'ternary_expression': {
      return INTERMEDIATE.repeat(3);
    }
    case 'template_string': {
      return namedChildren(node)
        .filter((child) => child.type === 'template_substitution')
        .map((child) => operand(namedChildren(child)[0]))
        .join('');
    }
    default: {
      return undefined;
    }
  }
}

function printedBinary(node: Node, operand: (child: Node) => string): string {
  const operator = field(node, 'operator').text;
  const negated = operator === '!=' ? '==' : operator === '!==' ? '===' : undefined;
  if (negated) return `(!(${operand(field(node, 'left'))} ${negated} ${operand(field(node, 'right'))}))`;
  return `(${chain(node, operator).map(operand).join(` ${operator} `)})`;
}

/**
 * The operands of a left-nested chain of one binary operator, which V8 parses as one n-ary operation even through
 * parentheses around its left part.
 */
export function chain(node: Node, operator: string): Node[] {
  let left = field(node, 'left');
  while (left.type === 'parenthesized_expression') left = namedChildren(left)[0];
  const continues = left.type === 'binary_expression' && field(left, 'operator').text === operator && !fold(left);
  return [...(continues ? chain(left, operator) : [left]), field(node, 'right')];
}

function sequence(node: Node): Node[] {
  return namedChildren(node).flatMap((child) => (child.type === 'sequence_expression' ? sequence(child) : [child]));
}

function fold(node: Node): Folded | undefined {
  switch (node.type) {
    case 'number': {
      if (node.text.endsWith('n')) return undefined;
      return { kind: 'number', value: Number(node.text.replaceAll('_', '')) };
    }
    case 'string':
    case 'template_string': {
      const text = stringLiteralValue(node);
      return text === undefined ? undefined : { kind: 'string', text };
    }
    case 'true':
    case 'false': {
      return { kind: 'boolean', value: node.type === 'true' };
    }
    case 'parenthesized_expression': {
      return fold(namedChildren(node)[0]);
    }
    case 'unary_expression': {
      return foldUnary(field(node, 'operator').text, node);
    }
    case 'binary_expression': {
      return foldBinary(field(node, 'operator').text, fold(field(node, 'left')), fold(field(node, 'right')));
    }
    default: {
      return undefined;
    }
  }
}

function foldUnary(operator: string, node: Node): Folded | undefined {
  const argument = field(node, 'argument');
  if (operator === '!') {
    const truthy = literalTruthiness(argument);
    return truthy === undefined ? undefined : { kind: 'boolean', value: !truthy };
  }
  const folded = fold(argument);
  if (folded?.kind !== 'number') return undefined;
  if (operator === '-') return { kind: 'number', value: -folded.value };
  if (operator === '+') return folded;
  // oxlint-disable-next-line no-bitwise -- Folds `~` on a number literal as V8's parser does.
  return operator === '~' ? { kind: 'number', value: ~folded.value } : undefined;
}

/** Whether a literal is truthy, as V8 folds `!` on it, including `null`, which no other operator folds. */
function literalTruthiness(node: Node): boolean | undefined {
  if (node.type === 'null') return false;
  const folded = fold(node);
  if (!folded) return undefined;
  if (folded.kind === 'boolean') return folded.value;
  return folded.kind === 'number' ? folded.value !== 0 && !Number.isNaN(folded.value) : folded.text !== '';
}

const NUMBER_OPERATIONS: Record<string, (left: number, right: number) => number> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '/': (left, right) => left / right,
  '%': (left, right) => left % right,
  '**': (left, right) => left ** right,
  /* oxlint-disable no-bitwise -- Folds bitwise operators on number literals as V8's parser does. */
  '&': (left, right) => left & right,
  '|': (left, right) => left | right,
  '^': (left, right) => left ^ right,
  '<<': (left, right) => left << right,
  '>>': (left, right) => left >> right,
  '>>>': (left, right) => left >>> right,
  /* oxlint-enable no-bitwise */
};

function foldBinary(operator: string, left: Folded | undefined, right: Folded | undefined): Folded | undefined {
  if (left?.kind === 'number' && right?.kind === 'number') {
    const operation = NUMBER_OPERATIONS[operator];
    return operation ? { kind: 'number', value: operation(left.value, right.value) } : undefined;
  }
  if (operator === '+' && left?.kind === 'string' && right?.kind === 'string')
    return { kind: 'string', text: left.text + right.text };
  return undefined;
}

function printedLiteral(folded: Folded): string {
  if (folded.kind === 'string') return `"${folded.text}"`;
  return String(folded.value);
}

/** The value of a string literal or of a template literal without substitutions, its escapes decoded. */
export function stringLiteralValue(node: Node): string | undefined {
  if (node.type === 'string') return decodeStringLiteral(node.text);
  if (node.type !== 'template_string' || namedChildren(node).some((child) => child.type === 'template_substitution'))
    return undefined;
  return decodeTemplateFragment(node.text.slice(1, -1));
}
