// oxlint-disable unicorn/no-null -- PHP null is represented by JavaScript null.
import type { ClassRef, Expr } from './ast';
import { boolValue, floatFitsInt, formatFloat, normalizeKeyString, numericPrefix } from './conversions';
import { compileConstant } from './native';
import { arithmetic, bitwise, compareScalar, toFloat, toInt } from './operators';
import { INT_MAX, INT_MIN, type Key, PhpArray, PhpObject } from './values';

type Scalar = Extract<Expr, { k: 'lit' }>['v'];
export type Constant = Scalar | Map<Key, Constant>;
const UNKNOWN = Symbol('unevaluated default');
type Folded = Constant | typeof UNKNOWN;
export type ClassConstantLookup = (cls: ClassRef, name: string) => Constant | undefined;
interface FoldContext {
  compiler?: boolean;
  classConstant?: ClassConstantLookup;
  className?: (cls: ClassRef) => string | undefined;
}

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
  const value = fold(expression, context);
  return value === UNKNOWN ? undefined : value;
}

function fold(expression: Expr, context: FoldContext): Folded {
  switch (expression.k) {
    case 'lit': {
      return expression.v;
    }
    case 'const': {
      const value = compileConstant(expression.name.name);
      return value === undefined || value instanceof PhpArray || value instanceof PhpObject ? UNKNOWN : value;
    }
    case 'interp': {
      if (context.compiler) return UNKNOWN;
      let result = '';
      for (const part of expression.parts) {
        const value = typeof part === 'string' ? part : fold(part, context);
        if (value === UNKNOWN || value instanceof Map) return UNKNOWN;
        result += scalarString(value);
      }
      return result;
    }
    case 'cconst': {
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
      return binaryConstant(expression.op, left, fold(expression.r, context));
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

// code-gauge-allow functionNcss 35 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function arrayConstant(expression: Extract<Expr, { k: 'array' }>, context: FoldContext): Folded {
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

function binaryConstant(op: string, left: Constant, right: Folded): Folded {
  if (right === UNKNOWN) return UNKNOWN;
  if (op === 'xor') {
    const a = foldBool(left),
      b = foldBool(right);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a !== b;
  }
  if (['===', '!==', '==', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(op))
    return comparisonConstant(op, left, right);
  if (left instanceof Map || right instanceof Map) {
    if (op !== '+' || !(left instanceof Map) || !(right instanceof Map)) return UNKNOWN;
    const result = new Map(left);
    for (const [key, value] of right) if (!result.has(key)) result.set(key, value);
    return result;
  }
  if (op === '.') return scalarString(left) + scalarString(right);
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

function comparisonConstant(op: string, left: Constant, right: Constant): Folded {
  const reverse = op === '>' || op === '>=';
  const order = compareConstant(reverse ? right : left, reverse ? left : right, op === '===' || op === '!==');
  if (order === UNKNOWN) return UNKNOWN;
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

// code-gauge-allow functionCognitiveComplexity 28 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function compareConstant(left: Constant, right: Constant, strict: boolean): number | typeof UNKNOWN {
  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return Math.sign(left.size - right.size);
    const other = right.keys();
    for (const [key, value] of left) {
      if ((strict && key !== other.next().value) || !right.has(key)) return 1;
      const order = compareConstant(value, right.get(key) as Constant, strict);
      if (order !== 0) return order;
    }
    return 0;
  }
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
