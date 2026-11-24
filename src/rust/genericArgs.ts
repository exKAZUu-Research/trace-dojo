import type { Expr, TypeAst } from './ast';
import { constInteger } from './constExpressions';
import { compileError, lowerType, type TypeScope } from './items';
import { type AdtDef, arrayOfLength, constValueType, substitute, type Type, type TypeParam } from './types';

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
  if (ast.value.kind === 'bool' || ast.value.kind === 'char') return constValueType(ast.value.value);
  const value = constInteger(ast.value, scope);
  if (value === undefined) compileError(ast.span, '定数の型引数には、整数のリテラルか定数の式を書いてください。');
  return constValueType(value);
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

/** The const parameter an expression names (`N` of `[T; N]`), if it names one. */
export function constParamOf(expr: Expr, scope: Pick<TypeScope, 'params'>): TypeParam | undefined {
  const inner = expr.kind === 'block' && expr.stmts.length === 0 ? expr.tail : expr;
  if (inner?.kind !== 'path' || inner.path.segments.length !== 1) return undefined;
  const param = scope.params.get(inner.path.segments[0].name);
  return param?.constType ? param : undefined;
}
