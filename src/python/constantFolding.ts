import type { BinaryOperator, Constant, Expression } from './ast';
import { newBytes, PyBytes } from './bytesValues';
import { newComplex } from './complexNumbers';
import { getItem, isTruthy } from './objects';
import { binaryOp, unaryOp } from './operators';
import { strLength } from './strings';
import { Ellipsis, newTuple, None, sliceClass } from './types';
import { PyError, PySlice, PyTuple, type PyValue } from './values';

// The limits of CPython's compiler (flowgraph.c) on the constants it folds.
const MAX_INT_BITS = 128n;
const MAX_COLLECTION_SIZE = 256n;
const MAX_STR_SIZE = 4096n;
const MAX_TOTAL_ITEMS = 1024n;

/** The values CPython's compiler folds expressions to, or undefined when it leaves any of them to run time. */
export function foldConstants(expressions: Expression[]): PyValue[] | undefined {
  const values: PyValue[] = [];
  for (const expression of expressions) {
    const value = foldConstant(expression);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of expression CPython's compiler folds.
// code-gauge-allow functionNcss 35 -- One case per kind of expression CPython's compiler folds.
function foldConstant(expression: Expression): PyValue | undefined {
  switch (expression.kind) {
    case 'constant': {
      return constantValue(expression.value);
    }
    case 'fstring': {
      return expression.parts.every((part) => typeof part === 'string') ? expression.parts.join('') : undefined;
    }
    case 'tuple': {
      if (expression.elements.some((element) => element.kind === 'starred')) return undefined;
      const items = foldConstants(expression.elements as Expression[]);
      return items && newTuple(items);
    }
    case 'unary': {
      const operand = foldConstant(expression.operand);
      // CPython does not fold `~` of a bool, which warns at run time.
      if (operand === undefined || (expression.operator === '~' && typeof operand === 'boolean')) return undefined;
      return unlessRaising(() => unaryOp(expression.operator, operand));
    }
    case 'not': {
      // CPython folds `not` only over a literal (or another folded `not`), not over a folded operation.
      if (!['constant', 'fstring', 'not'].includes(expression.operand.kind)) return undefined;
      const operand = foldConstant(expression.operand);
      return operand === undefined ? undefined : !isTruthy(operand);
    }
    case 'binary': {
      const left = foldConstant(expression.left);
      const right = left === undefined ? undefined : foldConstant(expression.right);
      if (left === undefined || right === undefined || !isSafeToFold(expression.operator, left, right)) {
        return undefined;
      }
      return unlessRaising(() => binaryOp(expression.operator, left, right));
    }
    case 'subscript': {
      const object = foldConstant(expression.object);
      const index = object === undefined ? undefined : foldIndex(expression.index);
      if (object === undefined || index === undefined) return undefined;
      return unlessRaising(() => getItem(object, index));
    }
    default: {
      return undefined;
    }
  }
}

export function constantValue(constant: Constant): PyValue {
  switch (constant.kind) {
    case 'int':
    case 'float':
    case 'str':
    case 'bool': {
      return constant.value;
    }
    case 'none': {
      return None;
    }
    case 'ellipsis': {
      return Ellipsis;
    }
    case 'imaginary': {
      return newComplex(0, constant.value);
    }
    case 'bytes': {
      return newBytes(constant.value);
    }
  }
}

function foldIndex(index: Expression): PyValue | undefined {
  if (index.kind !== 'slice') return foldConstant(index);
  // A slice is a constant only when its bounds are literals: CPython builds any other slice at run time.
  const bounds: PyValue[] = [];
  for (const bound of [index.lower, index.upper, index.step]) {
    if (bound && bound.kind !== 'constant') return undefined;
    bounds.push(bound ? constantValue(bound.value) : None);
  }
  return new PySlice(sliceClass, bounds[0], bounds[1], bounds[2]);
}

function unlessRaising(run: () => PyValue): PyValue | undefined {
  try {
    return run();
  } catch (error) {
    if (error instanceof PyError) return undefined;
    throw error;
  }
}

/** Whether CPython's compiler computes the operation, which it refuses for results that could be large. */
function isSafeToFold(operator: BinaryOperator, left: PyValue, right: PyValue): boolean {
  switch (operator) {
    case '*': {
      return isSafeProduct(left, right);
    }
    case '**': {
      const [base, exponent] = [intOf(left), intOf(right)];
      if (base === undefined || exponent === undefined || base === 0n || exponent <= 0n) return true;
      return bitLength(base) <= MAX_INT_BITS / exponent;
    }
    case '<<': {
      const [value, shift] = [intOf(left), intOf(right)];
      if (value === undefined || shift === undefined || value === 0n || shift === 0n) return true;
      return shift >= 0n && shift <= MAX_INT_BITS && bitLength(value) <= MAX_INT_BITS - shift;
    }
    case '%': {
      return typeof left !== 'string';
    }
    default: {
      return true;
    }
  }
}

function isSafeProduct(left: PyValue, right: PyValue): boolean {
  const [a, b] = [intOf(left), intOf(right)];
  if (a !== undefined && b !== undefined) {
    return a === 0n || b === 0n || bitLength(a) + bitLength(b) <= MAX_INT_BITS;
  }
  const count = a ?? b;
  const repeated = a === undefined ? left : right;
  if (count === undefined) return true;
  if (repeated instanceof PyTuple) {
    const size = BigInt(repeated.items.length);
    if (size === 0n) return true;
    if (count < 0n || count > MAX_COLLECTION_SIZE / size) return false;
    return count === 0n || itemsWithin(repeated, MAX_TOTAL_ITEMS / count) >= 0n;
  }
  if (typeof repeated === 'string' || repeated instanceof PyBytes) {
    const size = BigInt(typeof repeated === 'string' ? strLength(repeated) : repeated.length);
    return size === 0n || (count >= 0n && count <= MAX_STR_SIZE / size);
  }
  return true;
}

/** What remains of `limit` after counting the items of a tuple and of the tuples nested in it; negative when exceeded. */
function itemsWithin(value: PyValue, limit: bigint): bigint {
  if (!(value instanceof PyTuple)) return limit;
  let remaining = limit - BigInt(value.items.length);
  for (const item of value.items) {
    if (remaining < 0n) break;
    remaining = itemsWithin(item, remaining);
  }
  return remaining;
}

function intOf(value: PyValue): bigint | undefined {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  return typeof value === 'bigint' ? value : undefined;
}

function bitLength(value: bigint): bigint {
  return value === 0n ? 0n : BigInt((value < 0n ? -value : value).toString(2).length);
}
