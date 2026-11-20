import type { Expr, PathAst } from './ast';
import { lookupScalarConstant, lookupType, lowerType, type TypeScope } from './items';
import { castValue, floatArith, wrap } from './ops';
import {
  BOOL,
  CHAR,
  type ConstDef,
  F32,
  F64,
  INT_NAMES,
  intMax,
  intMin,
  type IntName,
  intType,
  type Type,
} from './types';
import type { Value } from './values';

export function constInteger(expr: Expr, scope: TypeScope): bigint | undefined {
  const length = constScalar(expr, scope, new Set(), intType('usize'))?.value;
  return typeof length === 'bigint' ? length : undefined;
}

interface ConstScalar {
  value: Value;
  type: Type;
}

function constScalar(expr: Expr, scope: TypeScope, resolving: Set<ConstDef>, expected?: Type): ConstScalar | undefined {
  switch (expr.kind) {
    case 'int': {
      const type = expr.suffix ? intType(expr.suffix as IntName) : expected?.kind === 'int' ? expected : intType('i32');
      return { value: expr.value, type };
    }
    case 'float': {
      const f32 = expr.suffix === 'f32' || (!expr.suffix && expected?.kind === 'float' && expected.name === 'f32');
      return { value: f32 ? expr.f32 : expr.value, type: f32 ? F32 : F64 };
    }
    case 'char': {
      return { value: expr.value, type: CHAR };
    }
    case 'bool': {
      return { value: expr.value, type: BOOL };
    }
    case 'path': {
      return constScalarPath(expr.path, scope, resolving);
    }
    case 'cast': {
      return constScalarCast(expr, scope, resolving);
    }
    case 'unary': {
      return constScalarUnary(expr, scope, resolving, expected);
    }
    case 'binary': {
      const left = constScalar(expr.left, scope, resolving, expected);
      const right = constScalar(expr.right, scope, resolving, left?.type ?? expected);
      return left && right ? constScalarBinary(expr.op, left, right) : undefined;
    }
    default: {
      return undefined;
    }
  }
}

function constScalarUnary(
  expr: Extract<Expr, { kind: 'unary' }>,
  scope: TypeScope,
  resolving: Set<ConstDef>,
  expected?: Type
): ConstScalar | undefined {
  const operand = constScalar(expr.operand, scope, resolving, expected);
  if (!operand) return;
  const { value, type } = operand;
  if (expr.op === '-' && (typeof value === 'bigint' || typeof value === 'number')) return { type, value: -value };
  if (expr.op === '!' && typeof value === 'boolean') return { type, value: !value };
  if (expr.op === '!' && typeof value === 'bigint' && type.kind === 'int')
    return { type, value: wrap(type.name, ~value) };
  return undefined;
}

function constScalarCast(
  expr: Extract<Expr, { kind: 'cast' }>,
  scope: TypeScope,
  resolving: Set<ConstDef>
): ConstScalar | undefined {
  const source = constScalar(expr.operand, scope, resolving);
  if (!source) return;
  const type = lowerType(expr.type, scope);
  if (type.kind === 'int') return { type, value: castValue(source.value, type) };
  const numeric = source.type.kind === 'int' || source.type.kind === 'float';
  if (type.kind === 'float' && numeric) return { type, value: castValue(source.value, type) };
  if (type.kind === 'char' && source.type.kind === 'int' && source.type.name === 'u8') {
    return { type, value: castValue(wrap('u8', source.value as bigint), type) };
  }
}

function constScalarBinary(op: string, left: ConstScalar, right: ConstScalar): ConstScalar | undefined {
  const { type, value: a } = left;
  const b = right.value;
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    const value = integerOperation(op, a, b);
    return value === undefined ? undefined : { type, value };
  }
  if (
    type.kind === 'float' &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    ['+', '-', '*', '/', '%'].includes(op)
  ) {
    return { type, value: floatArith(op, a, b, type.name === 'f32') };
  }
}

function constScalarPath(path: PathAst, scope: TypeScope, resolving: Set<ConstDef>): ConstScalar | undefined {
  const { segments } = path;
  if (segments.length === 2 && (INT_NAMES as string[]).includes(segments[0].name)) {
    const name = segments[0].name as IntName;
    const type = intType(name);
    if (segments[1].name === 'MAX') return { type, value: intMax(name) };
    if (segments[1].name === 'MIN') return { type, value: intMin(name) };
  }
  const found = lookupScalarConstant(path, scope);
  const value = found?.def.ast.value;
  if (!found || !value || resolving.has(found.def) || resolving.size >= 64) return;
  const { def, selfType } = found;
  const declared = def.ast.type;
  const binding =
    declared.kind === 'path' && declared.path.segments.length === 1
      ? lookupType(def.module, declared.path.segments[0].name, declared.span)
      : undefined;
  const expected = binding?.kind === 'prim' ? binding.type : undefined;
  resolving.add(def);
  try {
    return constScalar(
      value,
      { module: def.module, params: new Map(def.impl?.params.map((param) => [param.name, param])), selfType },
      resolving,
      expected
    );
  } finally {
    resolving.delete(def);
  }
}

function integerOperation(op: string, left: bigint, right: bigint): bigint | undefined {
  const operations: Record<string, () => bigint | undefined> = {
    '+': () => left + right,
    '-': () => left - right,
    '*': () => left * right,
    '/': () => (right === 0n ? undefined : left / right),
    '%': () => (right === 0n ? undefined : left % right),
    '<<': () => (right >= 0n && right < 128n ? left << right : undefined),
    '>>': () => (right >= 0n && right < 128n ? left >> right : undefined),
    '&': () => left & right,
    '|': () => left | right,
    '^': () => left ^ right,
  };
  return operations[op]?.();
}
