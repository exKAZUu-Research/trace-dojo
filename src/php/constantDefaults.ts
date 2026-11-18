// oxlint-disable unicorn/no-null -- PHP null is represented by JavaScript null.
import type { Expr } from './ast';
import { floatFitsInt, normalizeKeyString, numericPrefix, toBool } from './conversions';
import { arithmetic, bitwise, compareScalar, toFloat, toInt } from './operators';
import { INT_MAX, INT_MIN, type Key } from './values';

type Scalar = Extract<Expr, { k: 'lit' }>['v'];
type Constant = Scalar | Map<Key, Constant>;
const UNKNOWN = Symbol('unevaluated default');
type Folded = Constant | typeof UNKNOWN;

export function foldedDefaultType(expression: Expr): string | undefined {
  const value = fold(expression);
  if (value === UNKNOWN) return undefined;
  if (value instanceof Map) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return 'float';
  return typeof value === 'boolean' ? String(value) : 'string';
}

// code-gauge-allow functionNcss 58 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function fold(expression: Expr): Folded {
  switch (expression.k) {
    case 'lit': {
      return expression.v;
    }
    case 'interp': {
      let result = '';
      for (const part of expression.parts) {
        const value = typeof part === 'string' ? part : fold(part);
        if (value === UNKNOWN || value instanceof Map) return UNKNOWN;
        const text = scalarString(value);
        if (text === UNKNOWN) return UNKNOWN;
        result += text;
      }
      return result;
    }
    case 'cconst': {
      return expression.name.toLowerCase() === 'class' && expression.cls.k === 'named' ? expression.cls.name : UNKNOWN;
    }
    case 'idx': {
      const base = fold(expression.base);
      const index = expression.index ? fold(expression.index) : UNKNOWN;
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
      return arrayConstant(expression);
    }
    case 'unary': {
      return unaryConstant(expression.op, fold(expression.e));
    }
    case 'bin': {
      const left = fold(expression.l);
      if (left === UNKNOWN) return UNKNOWN;
      if (expression.op === '??') return left ?? fold(expression.r);
      if (['&&', 'and'].includes(expression.op) && !truth(left)) return false;
      if (['||', 'or'].includes(expression.op) && truth(left)) return true;
      return binaryConstant(expression.op, left, fold(expression.r));
    }
    case 'cond': {
      const test = fold(expression.test);
      if (test === UNKNOWN) return UNKNOWN;
      if (!truth(test)) return fold(expression.alternate);
      if (expression.consequent) return fold(expression.consequent);
      return test;
    }
    case 'cast': {
      return castConstant(expression.type, fold(expression.e));
    }
    default: {
      return UNKNOWN;
    }
  }
}

// code-gauge-allow functionNcss 35 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function arrayConstant(expression: Extract<Expr, { k: 'array' }>): Folded {
  const result = new Map<Key, Constant>();
  let next = INT_MIN;
  const append = (value: Constant): boolean => {
    if (next > INT_MAX) return false;
    if (next === INT_MIN) next = 0n;
    result.set(next++, value);
    return true;
  };
  for (const item of expression.items) {
    const value = fold(item.value);
    if (value === UNKNOWN || item.byRef) return UNKNOWN;
    if (item.spread) {
      if (!(value instanceof Map)) return UNKNOWN;
      for (const [key, slot] of value) {
        if (typeof key === 'string') result.set(key, slot);
        else if (!append(slot)) return UNKNOWN;
      }
    } else if (item.key) {
      const key = constantKey(fold(item.key));
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

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function unaryConstant(op: string, value: Folded): Folded {
  if (value === UNKNOWN) return UNKNOWN;
  if (op === '!') return !truth(value);
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

// code-gauge-allow functionNcss 32 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function binaryConstant(op: string, left: Constant, right: Folded): Folded {
  if (right === UNKNOWN) return UNKNOWN;
  if (['&&', 'and', '||', 'or'].includes(op)) return truth(right);
  if (op === 'xor') return truth(left) !== truth(right);
  if (['===', '!==', '==', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(op))
    return comparisonConstant(op, left, right);
  if (left instanceof Map || right instanceof Map) {
    if (op !== '+' || !(left instanceof Map) || !(right instanceof Map)) return UNKNOWN;
    const result = new Map(left);
    for (const [key, value] of right) if (!result.has(key)) result.set(key, value);
    return result;
  }
  if (op === '.') {
    const a = scalarString(left),
      b = scalarString(right);
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : a + b;
  }
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
  const order = compareConstant(left, right, op === '===' || op === '!==');
  if (order === UNKNOWN) return UNKNOWN;
  const results: Record<string, boolean> = {
    '===': order === 0,
    '==': order === 0,
    '!==': order !== 0,
    '!=': order !== 0,
    '<>': order !== 0,
    '<': order < 0,
    '<=': order <= 0,
    '>': order > 0,
    '>=': order >= 0,
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
    return Number(truth(left)) - Number(truth(right));
  if (left instanceof Map) return 1;
  if (right instanceof Map) return -1;
  return compareScalar(left, right);
}

// code-gauge-allow functionCognitiveComplexity 26 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function castConstant(type: string, value: Folded): Folded {
  if (value === UNKNOWN) return UNKNOWN;
  if (type === 'array') return value instanceof Map ? value : value === null ? new Map() : new Map([[0n, value]]);
  if (type === 'bool') return truth(value);
  if (value instanceof Map)
    return type === 'int' ? (value.size > 0 ? 1n : 0n) : type === 'float' ? (value.size > 0 ? 1 : 0) : UNKNOWN;
  if (type === 'string') return scalarString(value);
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

function truth(value: Constant): boolean {
  return value instanceof Map ? value.size > 0 : toBool(value);
}

function scalarString(value: Scalar): string | typeof UNKNOWN {
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  if (value === null || typeof value === 'boolean') return value ? '1' : '';
  return UNKNOWN;
}
