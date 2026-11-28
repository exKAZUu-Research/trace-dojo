import type { FnItem, Span } from './ast';
import { compileError, type Module } from './items';
import { childTypes, type FnDef, shallow, type TraitRef, type Type } from './types';

/**
 * Requires a lifetime that the return type leaves out to be decided by the parameters, as rustc does (E0106): it is
 * that of `&self` or `&mut self`, or else of the only place for a lifetime in the parameters' types.
 */
export function checkElidedReturnLifetime(fn: FnDef, ast: FnItem): void {
  for (const [index, type] of fn.paramTypes.entries()) checkFnSugarElision(type, ast.params[index].span);
  checkFnSugarElision(fn.ret, ast.ret?.span ?? ast.span);
  // An argument of `impl Fn() -> &str` is a type parameter with the bound.
  for (const param of fn.params) checkFnSugarBounds(param.bounds, ast.span);
  if (fn.selfMode === 'ref' || fn.selfMode === 'mutRef') return;
  if (lifetimePlaces(fn.ret, true) === 0) return;
  let inputs = 0;
  for (const type of fn.paramTypes) inputs += lifetimePlaces(type, false);
  if (inputs === 1) return;
  compileError(
    ast.ret?.span ?? ast.span,
    inputs === 0
      ? '戻り値の型の参照には、ライフタイムを書いてください（引数に参照がないので、借りる元がありません）（E0106）。'
      : '戻り値の型の参照には、ライフタイムを書いてください（引数の参照が1つではないので、どの引数から借りた値を返すのか決まりません）（E0106）。'
  );
}

/** Counts the places for a lifetime in a type: all of them, or only those left out. */
function lifetimePlaces(type: Type, onlyElided: boolean): number {
  const t = shallow(type);
  // A function pointer elides lifetimes by rules of its own, as the `Fn(..) -> ..` form of a bound does.
  if (t.kind === 'fn') return 0;
  if (t.kind === 'dyn' || t.kind === 'opaque') {
    return boundTypes(t).reduce((places, part) => places + lifetimePlaces(part, onlyElided), 0);
  }
  const written =
    t.kind === 'ref'
      ? [t.lifetime]
      : t.kind === 'adt'
        ? Array.from({ length: t.def.lifetimeParams?.length ?? 0 }, (_, index) => t.lifetimes?.[index])
        : [];
  let places = written.filter((lifetime) => !onlyElided || lifetime === undefined || lifetime === "'_").length;
  const parts = t.kind === 'ref' ? [t.target] : t.kind === 'adt' ? t.args : childTypesOf(t);
  for (const part of parts) places += lifetimePlaces(part, onlyElided);
  return places;
}

/** The types that the bounds of a trait object or an `impl Trait` name: their arguments and the associated types they set. */
function boundTypes(t: Extract<Type, { kind: 'dyn' | 'opaque' }>): Type[] {
  const bounds = t.kind === 'dyn' ? [t.trait] : t.opaque.bounds;
  return bounds.flatMap((bound) => [
    ...bound.args,
    ...(bound.item ? [bound.item] : []),
    ...(bound.assoc?.values() ?? []),
  ]);
}

/**
 * Requires the output of each `Fn(..) -> ..` bound in a type to elide its lifetimes from the bound's own inputs, as
 * rustc does whatever the function around it has: `Fn() -> &str` and `Fn(&str, &str) -> &str` are E0106.
 */
function checkFnSugarElision(type: Type, span: Span): void {
  const t = shallow(type);
  if (t.kind === 'dyn' || t.kind === 'opaque') {
    checkFnSugarBounds(t.kind === 'dyn' ? [t.trait] : t.opaque.bounds, span);
    for (const part of boundTypes(t)) checkFnSugarElision(part, span);
    return;
  }
  const parts = t.kind === 'ref' ? [t.target] : t.kind === 'adt' ? t.args : childTypesOf(t);
  for (const part of parts) checkFnSugarElision(part, span);
}

function checkFnSugarBounds(bounds: readonly TraitRef[], span: Span): void {
  for (const { fnSig } of bounds) {
    if (!fnSig || lifetimePlaces(fnSig.ret, true) === 0) continue;
    const inputs = fnSig.params.reduce((places, param) => places + lifetimePlaces(param, false), 0);
    if (inputs !== 1) compileError(span, 'Fn(..) -> .. の戻り値の参照には、ライフタイムを書いてください（E0106）。');
  }
}

function childTypesOf(t: Type): Type[] {
  if (t.kind === 'tuple') return t.elems;
  return t.kind === 'array' || t.kind === 'slice' ? [t.elem] : [];
}

/** Requires each lifetime of a field's type to be written and declared, as rustc does for a type's fields. */
export function checkFieldLifetimes(type: Type, span: Span, declared: string[]): void {
  const t = shallow(type);
  if (t.kind === 'ref') checkFieldLifetime(t.lifetime, span, declared);
  if (t.kind === 'dyn' && t.lifetime) checkFieldLifetime(t.lifetime, span, declared);
  if (t.kind === 'adt' && !(t.def.module as Module | undefined)?.isStd) {
    const expected = t.def.lifetimeParams?.length ?? 0;
    const lifetimes = t.lifetimes ?? [];
    if (lifetimes.length !== expected) {
      compileError(span, `フィールドの型 ${t.def.name} には、ライフタイムを ${expected} 個書いてください。`);
    }
    for (const lifetime of lifetimes) checkFieldLifetime(lifetime, span, declared);
  }
  const stored = t.kind === 'dyn' ? t.trait.args : childTypes(t);
  for (const child of stored) checkFieldLifetimes(child, span, declared);
}

function checkFieldLifetime(lifetime: string | undefined, span: Span, declared: string[]): void {
  if (!lifetime || lifetime === "'_") compileError(span, 'フィールドの型には、ライフタイムを書いてください（E0106）。');
  if (lifetime !== "'static" && !declared.includes(lifetime)) {
    compileError(span, `ライフタイム ${lifetime} が宣言されていません。`);
  }
}
