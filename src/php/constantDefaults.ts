// oxlint-disable unicorn/no-null -- PHP null is represented by JavaScript null.
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import type { ClassRef, Expr } from './ast';
import { boolValue, floatFitsInt, formatFloat, normalizeKeyString, numericPrefix } from './conversions';
import { compileConstant } from './native';
import { arithmetic, bitwise, compareScalar, toFloat, toInt } from './operators';
import { INT_MAX, INT_MIN, type Key, PhpArray, PhpObject, UNDEFINED_RESULT } from './values';

type Scalar = Extract<Expr, { k: 'lit' }>['v'];
export type Constant = Scalar | Map<Key, Constant>;
const UNKNOWN = Symbol('unevaluated default');
type Folded = Constant | typeof UNKNOWN;
export type ClassConstantLookup = (cls: ClassRef, name: string) => Constant | undefined;
type FoldBudget = Pick<ExecutionBudget, 'spend'>;
interface FoldContext {
  budget?: FoldBudget;
  compiler?: boolean;
  preserveNamedConstants?: boolean;
  preserveClassConstants?: boolean;
  classConstant?: ClassConstantLookup;
  className?: (cls: ClassRef) => string | undefined;
  magic?: (token: Extract<Expr, { k: 'magic' }>['name']) => string | undefined;
}

type BoundedFoldContext = FoldContext & { budget: FoldBudget };

export function foldedDefaultType(expression: Expr, context: FoldContext = {}): string | undefined {
  const value = foldedConstant(expression, context);
  return value === undefined ? undefined : constantTypeName(value);
}

export function constantTypeName(value: Constant): string {
  if (value instanceof Map) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return 'float';
  return typeof value === 'boolean' ? String(value) : 'string';
}

export function foldedConstant(expression: Expr, context: FoldContext): Constant | undefined {
  const value = fold(expression, boundedContext(context));
  return value === UNKNOWN ? undefined : value;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
export function selectConstantBranch(expression: Expr, context: FoldContext): Expr {
  const bounded = boundedContext(context);
  let current = expression;
  while (true) {
    if (current.k === 'cond') {
      const condition = foldBool(fold(current.test, bounded));
      if (condition === UNKNOWN) return current;
      current = condition ? (current.consequent ?? current.test) : current.alternate;
    } else if (current.k === 'bin' && current.op === '??') {
      const value = fold(current.l, bounded);
      if (value === UNKNOWN) return current;
      current = value === null ? current.r : current.l;
    } else return current;
  }
}

function boundedContext(context: FoldContext): BoundedFoldContext {
  return { ...context, budget: context.budget ?? new ExecutionBudget() };
}

function fold(expression: Expr, context: BoundedFoldContext): Folded {
  context.budget.spend();
  switch (expression.k) {
    case 'lit': {
      return expression.v;
    }
    case 'magic': {
      return context.magic?.(expression.name) ?? UNKNOWN;
    }
    case 'const': {
      if (context.preserveNamedConstants) return UNKNOWN;
      const value = compileConstant(expression.name.name);
      return value === undefined ||
        value === UNDEFINED_RESULT ||
        value instanceof PhpArray ||
        value instanceof PhpObject
        ? UNKNOWN
        : value;
    }
    case 'interp': {
      return interpolatedConstant(expression.parts, context);
    }
    case 'cconst': {
      if (context.preserveClassConstants) return UNKNOWN;
      if (expression.className) {
        if (expression.cls.k === 'named') return expression.cls.name;
        return context.className?.(expression.cls) ?? UNKNOWN;
      }
      const name = typeof expression.name === 'string' ? expression.name : fold(expression.name, context);
      if (typeof name !== 'string') return UNKNOWN;
      const value = context.classConstant?.(expression.cls, name);
      return value === undefined ? UNKNOWN : value;
    }
    case 'idx': {
      if (context.compiler) return UNKNOWN;
      const base = fold(expression.base, context);
      const index = expression.index ? fold(expression.index, context) : UNKNOWN;
      if (base === UNKNOWN) return UNKNOWN;
      const key =
        base instanceof Map
          ? typeof index === 'bigint' || typeof index === 'string'
            ? constantKey(index)
            : UNKNOWN
          : stringOffset(index);
      if (key === UNKNOWN) return UNKNOWN;
      if (base instanceof Map) return base.get(key) ?? (base.has(key) ? null : UNKNOWN);
      if (typeof base !== 'string' || typeof key !== 'bigint') return UNKNOWN;
      return key >= 0n && key < BigInt(base.length) ? base[Number(key)] : UNKNOWN;
    }
    case 'array': {
      return arrayConstant(expression, context);
    }
    case 'unary': {
      const value = fold(expression.e, context);
      if (context.compiler && expression.op === '!' && typeof value === 'number') return UNKNOWN;
      return unaryConstant(expression.op, value);
    }
    case 'bin': {
      const left = fold(expression.l, context);
      if (left === UNKNOWN) return UNKNOWN;
      if (expression.op === '??') return context.compiler ? UNKNOWN : (left ?? fold(expression.r, context));
      if (['&&', 'and', '||', 'or'].includes(expression.op)) {
        const condition = foldBool(left);
        if (condition === UNKNOWN) return UNKNOWN;
        const conjunction = expression.op === '&&' || expression.op === 'and';
        return condition === conjunction ? foldBool(fold(expression.r, context)) : condition;
      }
      return binaryConstant(expression.op, left, fold(expression.r, context), context.budget);
    }
    case 'cond': {
      if (context.compiler) return UNKNOWN;
      const test = fold(expression.test, context);
      const condition = foldBool(test);
      if (test === UNKNOWN || condition === UNKNOWN) return UNKNOWN;
      if (!condition) return fold(expression.alternate, context);
      if (expression.consequent) return fold(expression.consequent, context);
      return test;
    }
    case 'cast': {
      if (context.compiler) return UNKNOWN;
      return castConstant(expression.type, fold(expression.e, context));
    }
    default: {
      return UNKNOWN;
    }
  }
}

function interpolatedConstant(parts: (string | Expr)[], context: BoundedFoldContext): Folded {
  if (context.compiler) return UNKNOWN;
  let result = '';
  for (const part of parts) {
    const value = typeof part === 'string' ? part : fold(part, context);
    if (value === UNKNOWN || value instanceof Map) return UNKNOWN;
    const text = scalarString(value);
    if (result.length + text.length > LIMITS.maxStringLength) return UNKNOWN;
    context.budget.spend(1 + Math.ceil(text.length / 64));
    result += text;
  }
  return result;
}

// code-gauge-allow functionNcss 36 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function arrayConstant(expression: Extract<Expr, { k: 'array' }>, context: BoundedFoldContext): Folded {
  const result = new Map<Key, Constant>();
  let next = INT_MIN;
  const append = (value: Constant): boolean => {
    if (next > INT_MAX) return false;
    if (next === INT_MIN) next = 0n;
    result.set(next++, value);
    return true;
  };
  for (const item of expression.items) {
    const value = fold(item.value, context);
    if (value === UNKNOWN || item.byRef) return UNKNOWN;
    if (item.spread) {
      if (!(value instanceof Map)) return UNKNOWN;
      context.budget.spend(value.size);
      for (const [key, slot] of value) {
        if (typeof key === 'string') result.set(key, slot);
        else if (!append(slot)) return UNKNOWN;
      }
    } else if (item.key) {
      const key = constantKey(fold(item.key, context));
      if (key === UNKNOWN) return UNKNOWN;
      result.set(key, value);
      if (typeof key === 'bigint' && key >= next) next = key + 1n;
    } else if (!append(value)) return UNKNOWN;
  }
  return result;
}

function stringOffset(value: Folded): bigint | typeof UNKNOWN {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string') return UNKNOWN;
  const parsed = numericPrefix(value);
  return parsed && typeof parsed.value === 'bigint' ? parsed.value : UNKNOWN;
}

function constantKey(value: Folded): Key | typeof UNKNOWN {
  if (value === UNKNOWN || value instanceof Map) return UNKNOWN;
  if (typeof value === 'string') return normalizeKeyString(value);
  if (typeof value === 'bigint') return value;
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 1n : 0n;
  return Number.isInteger(value) && floatFitsInt(value) ? BigInt(value) : UNKNOWN;
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function unaryConstant(op: string, value: Folded): Folded {
  if (value === UNKNOWN) return UNKNOWN;
  if (op === '!') {
    const condition = foldBool(value);
    return condition === UNKNOWN ? UNKNOWN : !condition;
  }
  if (value instanceof Map) return UNKNOWN;
  if (op === '~') {
    if (typeof value === 'bigint') return ~value;
    if (typeof value === 'number' && Number.isInteger(value) && floatFitsInt(value)) return ~BigInt(value);
    if (typeof value === 'string')
      return value
        .split('')
        .map((byte) => String.fromCodePoint((byte.codePointAt(0) as number) ^ 255))
        .join('');
    return UNKNOWN;
  }
  const number = numericConstant(value);
  if (number === UNKNOWN || (op !== '+' && op !== '-')) return UNKNOWN;
  const result = op === '-' ? -number : number;
  return typeof result === 'bigint' && (result < INT_MIN || result > INT_MAX) ? Number(result) : result;
}

// code-gauge-allow functionNcss 37 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function binaryConstant(op: string, left: Constant, right: Folded, budget: FoldBudget): Folded {
  if (right === UNKNOWN) return UNKNOWN;
  if (op === 'xor') {
    const a = foldBool(left),
      b = foldBool(right);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a !== b;
  }
  if (['===', '!==', '==', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(op))
    return comparisonConstant(op, left, right, budget);
  if (left instanceof Map || right instanceof Map) {
    if (op !== '+' || !(left instanceof Map) || !(right instanceof Map)) return UNKNOWN;
    budget.spend(left.size + right.size);
    const result = new Map(left);
    for (const [key, value] of right) if (!result.has(key)) result.set(key, value);
    return result;
  }
  if (op === '.') return concatenateConstant(left, right, budget);
  const a = numericConstant(left),
    b = numericConstant(right);
  if (['&', '|', '^'].includes(op) && typeof left === 'string' && typeof right === 'string')
    return bitwise(op, left, right) as Scalar;
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (['&', '|', '^', '<<', '>>', '%'].includes(op)) {
    if (
      !integerOperand(a) ||
      !integerOperand(b) ||
      ((op === '<<' || op === '>>') && b < 0) ||
      (op === '%' && Number(b) === 0)
    )
      return UNKNOWN;
    return (op === '%' ? arithmetic(op, a, b) : bitwise(op, a, b)) as Scalar;
  }
  if (
    !['+', '-', '*', '/', '**'].includes(op) ||
    (op === '/' && Number(b) === 0) ||
    (op === '**' && Number(a) === 0 && b < 0)
  )
    return UNKNOWN;
  return arithmetic(op, a, b) as Scalar;
}

function concatenateConstant(left: Scalar, right: Scalar, budget: FoldBudget): Folded {
  const a = scalarString(left);
  const b = scalarString(right);
  const length = a.length + b.length;
  if (length > LIMITS.maxStringLength) return UNKNOWN;
  budget.spend(1 + Math.ceil(length / 64));
  return a + b;
}

function comparisonConstant(op: string, left: Constant, right: Constant, budget: FoldBudget): Folded {
  const reverse = op === '>' || op === '>=';
  const order = compareConstant(reverse ? right : left, reverse ? left : right, op === '===' || op === '!==', budget);
  const results: Record<string, boolean> = {
    '===': order === 0,
    '==': order === 0,
    '!==': order !== 0,
    '!=': order !== 0,
    '<>': order !== 0,
    '<': order < 0,
    '<=': order <= 0,
    '>': order < 0,
    '>=': order <= 0,
  };
  return results[op] ?? BigInt(order);
}

type ConstantArray = Map<Key, Constant>;
interface ConstantComparison {
  left: ConstantArray;
  right: ConstantArray;
  entries: MapIterator<[Key, Constant]>;
  keys: MapIterator<Key>;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function compareConstant(left: Constant, right: Constant, strict: boolean, budget: FoldBudget): number {
  const complete = new WeakMap<ConstantArray, WeakSet<ConstantArray>>();
  const stack: ConstantComparison[] = [];
  let pair: [Constant, Constant] | undefined = [left, right];
  for (;;) {
    if (pair) {
      budget.spend();
      const order = compareConstantPair(pair, strict, complete, stack, budget);
      if (order !== 0) return order;
    }
    const frame = stack.at(-1);
    if (!frame) return 0;
    const next = frame.entries.next();
    if (next.done) {
      let equal = complete.get(frame.left);
      if (!equal) {
        equal = new WeakSet();
        complete.set(frame.left, equal);
      }
      equal.add(frame.right);
      stack.pop();
      pair = undefined;
      continue;
    }
    const [key, value] = next.value;
    if ((strict && key !== frame.keys.next().value) || !frame.right.has(key)) return 1;
    pair = [value, frame.right.get(key) as Constant];
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function compareConstantPair(
  pair: [Constant, Constant],
  strict: boolean,
  complete: WeakMap<ConstantArray, WeakSet<ConstantArray>>,
  stack: ConstantComparison[],
  budget: FoldBudget
): number {
  const [left, right] = pair;
  if (left instanceof Map && right instanceof Map) {
    if (left === right || complete.get(left)?.has(right)) return 0;
    if (left.size !== right.size) return Math.sign(left.size - right.size);
    stack.push({ left, right, entries: left.entries(), keys: right.keys() });
    return 0;
  }
  const stringBytes = (typeof left === 'string' ? left.length : 0) + (typeof right === 'string' ? right.length : 0);
  if (stringBytes > 0) budget.spend(Math.ceil(stringBytes / 64));
  if (strict) return typeof left === typeof right && left === right ? 0 : 1;
  if (
    (left === null || right === null || typeof left === 'boolean' || typeof right === 'boolean') &&
    (left instanceof Map || right instanceof Map)
  )
    return Number(constantTruth(left)) - Number(constantTruth(right));
  if (left instanceof Map) return 1;
  if (right instanceof Map) return -1;
  return compareScalar(left, right);
}

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function castConstant(type: string, value: Folded): Folded {
  if (value === UNKNOWN) return UNKNOWN;
  if (type === 'array') return value instanceof Map ? value : value === null ? new Map() : new Map([[0n, value]]);
  if (type === 'bool') return foldBool(value);
  if (value instanceof Map)
    return type === 'int' ? (value.size > 0 ? 1n : 0n) : type === 'float' ? (value.size > 0 ? 1 : 0) : UNKNOWN;
  if (type === 'string') return typeof value === 'number' ? UNKNOWN : scalarString(value);
  if (type === 'float') return toFloat(value);
  if (type === 'int' && (typeof value !== 'number' || floatFitsInt(value))) return toInt(value);
  return UNKNOWN;
}

function numericConstant(value: Scalar): bigint | number | typeof UNKNOWN {
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  if (value === null || typeof value === 'boolean') return value ? 1n : 0n;
  const parsed = numericPrefix(value);
  return parsed?.whole ? parsed.value : UNKNOWN;
}

function integerOperand(value: bigint | number): boolean {
  return typeof value === 'bigint' || (Number.isInteger(value) && floatFitsInt(value));
}

function foldBool(value: Folded): boolean | typeof UNKNOWN {
  if (value === UNKNOWN || (typeof value === 'number' && Number.isNaN(value))) return UNKNOWN;
  return constantTruth(value);
}

export function constantTruth(value: Constant): boolean {
  return value instanceof Map ? value.size > 0 : boolValue(value);
}

function scalarString(value: Scalar): string {
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return formatFloat(value);
  return value ? '1' : '';
}
