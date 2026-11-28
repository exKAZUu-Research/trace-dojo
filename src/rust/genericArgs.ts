import type { Expr, TypeAst } from './ast';
import { constInteger, constScalarValue } from './constExpressions';
import { compileError, lowerType, type TypeScope } from './items';
import {
  type AdtDef,
  arrayOfLength,
  constValueType,
  shallow,
  substitute,
  type Type,
  type TypeParam,
  typeToString,
  USIZE,
} from './types';

/** `[T; N]`, whose length is a constant or a const parameter. */
export function lowerArrayType(ast: Extract<TypeAst, { kind: 'array' }>, scope: TypeScope): Type {
  const lengthParam = constParamOf(ast.len, scope);
  if (lengthParam) return arrayOfLength(lowerType(ast.elem, scope), { kind: 'param', param: lengthParam });
  const length = constInteger(ast.len, scope);
  if (length === undefined || length < 0n) {
    compileError(ast.span, '配列の長さには、整数のリテラルか定数の式を書いてください。');
  }
  return { kind: 'array', elem: lowerType(ast.elem, scope), len: Number(length) };
}

/** A value given to a const parameter: a const parameter, a `bool` or `char` literal, or an integer constant. */
export function lowerConstArg(ast: Extract<TypeAst, { kind: 'constArg' }>, scope: TypeScope): Type {
  const param = constParamOf(ast.value, scope);
  if (param) return { kind: 'param', param };
  // `{ 2 + 1 }` is the constant expression inside its braces.
  const expr =
    ast.value.kind === 'block' && ast.value.stmts.length === 0 && ast.value.tail ? ast.value.tail : ast.value;
  const expected = ast.type ? lowerType(ast.type, scope) : undefined;
  if (expr.kind === 'bool' || expr.kind === 'char') {
    if (expected && shallow(expected).kind !== expr.kind) {
      compileError(ast.span, `型が合いません（${typeToString(expected)} が必要ですが、${expr.kind} です）。`);
    }
    return constValueType(expr.value);
  }
  // The value has the type of the const parameter it is given to (`usize` where that is not known yet).
  const value = constScalarValue(expr, scope, expected ?? USIZE);
  if (value === undefined) compileError(ast.span, '定数の型引数には、リテラルか定数の式を書いてください。');
  return constValueType(value);
}

/**
 * A written type argument for a parameter: a lone name given to a const parameter (`M::<SIZE>`) names a constant,
 * which the parser cannot tell from a type.
 */
export function argumentFor(arg: TypeAst, param: TypeParam | undefined): TypeAst {
  if (!param?.constType) return arg;
  if (arg.kind === 'constArg') return { ...arg, type: param.constType };
  if (arg.kind !== 'path' || arg.path.segments.length !== 1 || arg.path.segments[0].args) return arg;
  const value = { kind: 'path', path: arg.path, span: arg.span } as Expr;
  return { kind: 'constArg', value, span: arg.span, type: param.constType };
}

export function withDefaultArgs(def: AdtDef, written: Type[]): Type[] {
  if (written.length >= def.params.length || def.builtin) return written;
  const missing = def.params.slice(written.length);
  if (!missing.every((param) => param.defaultType)) return written;
  const subst = new Map(def.params.slice(0, written.length).map((param, index) => [param, written[index]]));
  const args = [...written];
  for (const param of missing) {
    const type = substitute(param.defaultType as Type, subst);
    subst.set(param, type);
    args.push(type);
  }
  return args;
}

export function constParamOf(expr: Expr, scope: Pick<TypeScope, 'params'>): TypeParam | undefined {
  const inner = expr.kind === 'block' && expr.stmts.length === 0 ? expr.tail : expr;
  if (inner?.kind !== 'path' || inner.path.segments.length !== 1) return undefined;
  const param = scope.params.get(inner.path.segments[0].name);
  return param?.constType ? param : undefined;
}
