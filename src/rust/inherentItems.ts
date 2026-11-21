import type { Span } from './ast';
import type { Unifier } from './infer';
import { compileError, type Module, type Program } from './items';
import { freshVar, type ImplDef, type Subst, substitute, typeToString } from './types';

/**
 * Rejects a method or an associated constant that inherent impls of overlapping types define twice (E0592): their
 * names share one namespace of the type, across `impl` blocks as within one.
 */
export function checkInherentItems(program: Program, unifier: Unifier): void {
  const definers = new Map<string, ImplDef[]>();
  for (const impl of program.impls) {
    if (impl.trait || (impl.module as Module).isStd) continue;
    for (const [name, span] of itemsOf(impl)) {
      const previous = definers.get(name) ?? [];
      if (previous.some((other) => overlap(unifier, impl, other))) {
        compileError(span, `${name} は、型 ${typeToString(impl.selfType)} に2回定義されています。`);
      }
      definers.set(name, [...previous, impl]);
    }
  }
}

function itemsOf(impl: ImplDef): [string, Span][] {
  const methods = [...impl.methods].map(([name, fn]): [string, Span] => [name, fn.ast?.span ?? (impl.span as Span)]);
  return [...methods, ...[...impl.consts].map(([name, def]): [string, Span] => [name, def.ast.span])];
}

function fresh(impl: ImplDef): Subst {
  return new Map(impl.params.map((param) => [param, freshVar()]));
}

function overlap(unifier: Unifier, a: ImplDef, b: ImplDef): boolean {
  const snapshot = unifier.snapshot();
  try {
    return unifier.unify(substitute(a.selfType, fresh(a)), substitute(b.selfType, fresh(b)));
  } finally {
    unifier.rollback(snapshot);
  }
}
