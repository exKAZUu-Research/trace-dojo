import type { Constant, Expression } from './ast';

/**
 * A text equal for two literal mapping-pattern keys exactly when Python finds the keys equal, as CPython's compiler
 * compares them to refuse a duplicate; undefined for a key only the running program can compare, such as `a.b`.
 */
export function literalKeyId(key: Expression): string | undefined {
  if (key.kind === 'constant') return constantId(key.value, 1);
  if (key.kind === 'unary' && key.operator === '-' && key.operand.kind === 'constant') {
    return constantId(key.operand.value, -1);
  }
  return undefined;
}

function constantId(constant: Constant, sign: 1 | -1): string | undefined {
  switch (constant.kind) {
    case 'int': {
      return `n:${constant.value * BigInt(sign)}`;
    }
    case 'float': {
      return realId(constant.value * sign);
    }
    case 'imaginary': {
      return complexId(0, constant.value * sign);
    }
    case 'bool': {
      return `n:${constant.value ? 1 : 0}`;
    }
    case 'str': {
      return `s:${constant.value}`;
    }
    case 'none': {
      return 'None';
    }
    default: {
      return undefined;
    }
  }
}

function complexId(real: number, imag: number): string {
  return imag === 0 ? realId(real) : `c:${real},${imag}`;
}

/** Equal ints and floats are equal keys, so an integral float shares its int's text. */
function realId(value: number): string {
  return Number.isInteger(value) ? `n:${BigInt(value)}` : `n:${value}`;
}
