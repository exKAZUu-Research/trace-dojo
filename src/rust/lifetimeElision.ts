import type { FnItem } from './ast';
import { compileError } from './items';
import { type FnDef, shallow, type Type } from './types';

/**
 * Requires a lifetime that the return type leaves out to be decided by the parameters, as rustc does (E0106): it is
 * that of `&self` or `&mut self`, or else of the only place for a lifetime in the parameters' types.
 */
export function checkElidedReturnLifetime(fn: FnDef, ast: FnItem): void {
  if (fn.selfMode === 'ref' || fn.selfMode === 'mutRef') return;
  if (lifetimePlaces(fn.ret, true) === 0) return;
  let inputs = 0;
  for (const type of fn.paramTypes) inputs += lifetimePlaces(type, false);
  if (inputs === 1) return;
  compileError(
    ast.ret?.span ?? ast.span,
    '戻り値の型の参照には、ライフタイムを書いてください（引数の参照が1つではないので、どの引数から借りた値を返すのか決まりません）。'
  );
}

/** Counts the places for a lifetime in a type: all of them, or only those left out. */
function lifetimePlaces(type: Type, onlyElided: boolean): number {
  const t = shallow(type);
  // A trait object and a function pointer elide lifetimes by rules of their own.
  if (t.kind === 'dyn' || t.kind === 'fn') return 0;
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

function childTypesOf(t: Type): Type[] {
  if (t.kind === 'tuple') return t.elems;
  return t.kind === 'array' || t.kind === 'slice' ? [t.elem] : [];
}
