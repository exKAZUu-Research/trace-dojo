import type { Expr, PathAst } from './ast';
import { FLOAT_LIMITS } from './floatLimits';
import { lookupScalarConstant, lookupType, lowerType, type TypeScope } from './items';
import { castValue, floatArith, intArith, wrap } from './ops';
import { RustPanic } from './runtime';
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
  sameType,
  type Type,
} from './types';

export function constInteger(expr: Expr, scope: TypeScope, expected = intType('usize')): bigint | undefined {
  try {
    const scalar = constScalar(expr, scope, { visiting: new Set(), values: new Map(), hints: new WeakMap() }, expected);
    return scalar && sameType(scalar.type, expected) && typeof scalar.value === 'bigint' ? scalar.value : undefined;
  } catch (error) {
    if (error instanceof RustPanic) return undefined;
    throw error;
  }
}

interface ConstScalar {
  value: bigint | number | string | boolean;
  type: Type;
}

interface ConstEvaluation {
  visiting: Set<ConstDef>;
  values: Map<ConstDef, ConstScalar | undefined>;
  hints: WeakMap<Expr, Type | undefined>;
}

function constScalar(
  expr: Expr,
  scope: TypeScope,
  state: ConstEvaluation,
  expected?: Type,
  evaluate = true
): ConstScalar | undefined {
  switch (expr.kind) {
    case 'int': {
      const type = expr.suffix ? intType(expr.suffix as IntName) : expected?.kind === 'int' ? expected : intType('i32');
      return checkedLiteral(expr.value, type);
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
      return constScalarPath(expr.path, scope, state);
    }
    case 'cast': {
      return constScalarCast(expr, scope, state, evaluate);
    }
    case 'unary': {
      return constScalarUnary(expr, scope, state, expected, evaluate);
    }
    case 'binary': {
      return constScalarBinary(expr, scope, state, expected, evaluate);
    }
    default: {
      return undefined;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Signed literals, integer overflow and boolean negation follow different rules.
function constScalarUnary(
  expr: Extract<Expr, { kind: 'unary' }>,
  scope: TypeScope,
  state: ConstEvaluation,
  expected: Type | undefined,
  evaluate: boolean
): ConstScalar | undefined {
  if (expr.op === '-' && expr.operand.kind === 'int') {
    const { suffix, value } = expr.operand;
    const type = suffix ? intType(suffix as IntName) : (expected ?? intType('i32'));
    return type.kind === 'int' && type.name.startsWith('i') ? checkedLiteral(-value, type) : undefined;
  }
  const operand = constScalar(expr.operand, scope, state, expected, evaluate);
  if (!operand) return;
  const { value, type } = operand;
  if (expr.op === '-' && type.kind === 'int' && type.name.startsWith('i')) {
    return { type, value: evaluate ? intArith('-', type.name, 0n, value as bigint, expr.span) : 0n };
  }
  if (expr.op === '-' && typeof value === 'number') return { type, value: -value };
  if (expr.op === '!' && typeof value === 'boolean') return { type, value: !value };
  if (expr.op === '!' && typeof value === 'bigint' && type.kind === 'int')
    return { type, value: wrap(type.name, ~value) };
  return undefined;
}

function constScalarCast(
  expr: Extract<Expr, { kind: 'cast' }>,
  scope: TypeScope,
  state: ConstEvaluation,
  evaluate: boolean
): ConstScalar | undefined {
  const source = constScalar(expr.operand, scope, state, undefined, evaluate);
  if (!source) return;
  const type = lowerType(expr.type, scope);
  if (type.kind === 'int') return castScalar(source, type);
  const numeric = source.type.kind === 'int' || source.type.kind === 'float';
  if (type.kind === 'float' && numeric) return castScalar(source, type);
  if (type.kind === 'char' && source.type.kind === 'int' && source.type.name === 'u8') {
    return castScalar(source, type);
  }
}

function castScalar(source: ConstScalar, type: Type): ConstScalar {
  return { type, value: castValue(source.value, type) as ConstScalar['value'] };
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const BITWISE = new Set(['&', '|', '^']);

function constScalarBinary(
  expr: Extract<Expr, { kind: 'binary' }>,
  scope: TypeScope,
  state: ConstEvaluation,
  expected: Type | undefined,
  evaluate: boolean
): ConstScalar | undefined {
  const { left, right, op } = expr;
  const logical = op === '&&' || op === '||';
  const compare = COMPARISONS.has(op);
  const shift = op === '<<' || op === '>>';
  const typeHint = logical
    ? BOOL
    : (scalarHint(left, scope, state) ??
      (shift ? undefined : scalarHint(right, scope, state)) ??
      (compare ? undefined : expected));
  const lhs = constScalar(left, scope, state, typeHint, evaluate);
  if (!lhs) return;
  const skip = logical && (op === '&&' ? lhs.value === false : lhs.value === true);
  const rhs = constScalar(right, scope, state, shift ? undefined : lhs.type, evaluate && !skip);
  if (!rhs || (!shift && !sameType(lhs.type, rhs.type))) return;
  return binaryValue(expr, lhs, rhs, evaluate);
}

function binaryValue(
  expr: Extract<Expr, { kind: 'binary' }>,
  { type, value: a }: ConstScalar,
  { value: b }: ConstScalar,
  evaluate: boolean
): ConstScalar | undefined {
  const { op } = expr;
  if (COMPARISONS.has(op)) return { type: BOOL, value: compareScalars(op, a, b) };
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    const value = booleanOperation(op, a, b);
    return value === undefined ? undefined : { type, value };
  }
  if (
    type.kind === 'int' &&
    typeof a === 'bigint' &&
    typeof b === 'bigint' &&
    (ARITHMETIC.has(op) || BITWISE.has(op) || op === '<<' || op === '>>')
  ) {
    return { type, value: evaluate ? intArith(op, type.name, a, b, expr.span) : 0n };
  }
  if (type.kind === 'float' && typeof a === 'number' && typeof b === 'number' && ARITHMETIC.has(op)) {
    return { type, value: floatArith(op, a, b, type.name === 'f32') };
  }
}

function booleanOperation(op: string, a: boolean, b: boolean): boolean | undefined {
  if (op === '&&' || op === '&') return a && b;
  if (op === '||' || op === '|') return a || b;
  if (op === '^') return a !== b;
}

function compareScalars(op: string, a: ConstScalar['value'], b: ConstScalar['value']): boolean {
  if (op === '==') return a === b;
  if (op === '!=') return a !== b;
  const left = orderedScalar(a);
  const right = orderedScalar(b);
  if (op === '<') return left < right;
  if (op === '<=') return left <= right;
  if (op === '>') return left > right;
  return left >= right;
}

function orderedScalar(value: ConstScalar['value']): number | bigint {
  if (typeof value === 'string') return value.codePointAt(0) ?? 0;
  return typeof value === 'boolean' ? Number(value) : value;
}

function checkedLiteral(value: bigint, type: Type): ConstScalar | undefined {
  if (type.kind !== 'int' || value < intMin(type.name) || value > intMax(type.name)) return;
  return { type, value };
}

function scalarHint(expr: Expr, scope: TypeScope, state: ConstEvaluation): Type | undefined {
  if (state.hints.has(expr)) return state.hints.get(expr);
  const hint = inferScalarHint(expr, scope, state);
  state.hints.set(expr, hint);
  return hint;
}

// code-gauge-allow functionCognitiveComplexity 17 -- Literal suffixes and arithmetic operands contribute different type hints.
function inferScalarHint(expr: Expr, scope: TypeScope, state: ConstEvaluation): Type | undefined {
  switch (expr.kind) {
    case 'int': {
      return expr.suffix ? intType(expr.suffix as IntName) : undefined;
    }
    case 'float': {
      return expr.suffix ? (expr.suffix === 'f32' ? F32 : F64) : undefined;
    }
    case 'cast': {
      return lowerType(expr.type, scope);
    }
    case 'path': {
      const builtin = builtinScalar(expr.path, scope);
      if (builtin) return builtin.type;
      const entry = lookupScalarConstant(expr.path, scope);
      return entry && declaredScalarType(entry.def);
    }
    case 'unary': {
      return scalarHint(expr.operand, scope, state);
    }
    case 'binary': {
      if (COMPARISONS.has(expr.op) || expr.op === '&&' || expr.op === '||') return BOOL;
      return (
        scalarHint(expr.left, scope, state) ??
        (expr.op === '<<' || expr.op === '>>' ? undefined : scalarHint(expr.right, scope, state))
      );
    }
    default: {
      return undefined;
    }
  }
}

function builtinScalar(path: PathAst, scope: TypeScope): ConstScalar | undefined {
  const { segments } = path;
  if (segments.length === 2 && (INT_NAMES as string[]).includes(segments[0].name)) {
    const name = segments[0].name as IntName;
    const type = intType(name);
    if (segments[1].name === 'MAX') return { type, value: intMax(name) };
    if (segments[1].name === 'MIN') return { type, value: intMin(name) };
  }
  if (segments.length === 2) {
    const primitive = lookupType(scope.module, segments[0].name, path.span);
    const type = primitive?.kind === 'prim' ? primitive.type : undefined;
    const value = FLOAT_LIMITS[segments[1].name];
    if (type?.kind === 'float' && value) return { type, value: value[type.name] };
  }
}

function constScalarPath(path: PathAst, scope: TypeScope, state: ConstEvaluation): ConstScalar | undefined {
  const builtin = builtinScalar(path, scope);
  if (builtin) return builtin;
  const found = lookupScalarConstant(path, scope);
  if (!found || state.visiting.has(found.def) || state.visiting.size >= 64) return;
  const { def, selfType } = found;
  const cached = !def.impl?.params.length;
  if (cached && state.values.has(def)) return state.values.get(def);
  const result = evaluateNamedScalar(def, selfType, state);
  if (cached) state.values.set(def, result);
  return result;
}

function declaredScalarType(def: ConstDef): Type | undefined {
  const declared = def.ast.type;
  const binding =
    declared.kind === 'path' && declared.path.segments.length === 1
      ? lookupType(def.module, declared.path.segments[0].name, declared.span)
      : undefined;
  return binding?.kind === 'prim' ? binding.type : undefined;
}

function evaluateNamedScalar(
  def: ConstDef,
  selfType: Type | undefined,
  state: ConstEvaluation
): ConstScalar | undefined {
  const expected = declaredScalarType(def);
  const value = def.ast.value;
  if (!value) {
    const limit = FLOAT_LIMITS[def.name];
    return expected?.kind === 'float' && limit ? { type: expected, value: limit[expected.name] } : undefined;
  }
  state.visiting.add(def);
  try {
    const result = constScalar(
      value,
      { module: def.module, params: new Map(def.impl?.params.map((param) => [param.name, param])), selfType },
      state,
      expected
    );
    return result && (!expected || sameType(result.type, expected)) ? result : undefined;
  } finally {
    state.visiting.delete(def);
  }
}
