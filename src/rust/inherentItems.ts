import type { Span } from './ast';
import { compileError, type Module, type Program } from './items';
import { type ImplDef, typeToString } from './types';

/**
 * Rejects a method or an associated constant that inherent impls define twice for a type both apply to (E0592): their
 * names share one namespace of the type, across `impl` blocks as within one. `overlap` tells whether two impls can
 * apply to one type, by their self types and their bounds.
 */
export function checkInherentItems(program: Program, overlap: (a: ImplDef, b: ImplDef) => boolean): void {
  const definers = new Map<string, ImplDef[]>();
  for (const impl of program.impls) {
    if (impl.trait || (impl.module as Module).isStd) continue;
    for (const [name, span] of itemsOf(impl)) {
      const previous = definers.get(name) ?? [];
      if (previous.some((other) => overlap(impl, other))) {
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
