import type { Span } from './ast';
import { compileError, type Module, type Program } from './items';
import { type AdtDef, type ImplDef, shallow } from './types';

/** Rejects a type that implements both `Copy` and `Drop`, derived or written (E0184). */
export function checkCopyDestructors(program: Program): void {
  const impls = program.impls.filter((impl) => !(impl.module as Module).isStd);
  const dropped = new Set(impls.filter((impl) => isImplOf(impl, 'Drop')).map(selfAdt));
  const copies: [AdtDef | undefined, Span][] = [
    ...program.adts.filter((def) => def.derives.has('Copy')).map((def): [AdtDef, Span] => [def, def.span]),
    ...impls
      .filter((impl) => isImplOf(impl, 'Copy'))
      .map((impl): [AdtDef | undefined, Span] => [selfAdt(impl), impl.span as Span]),
  ];
  for (const [def, span] of copies) {
    if (def && dropped.has(def))
      compileError(span, `Drop を実装した型 ${def.name} には、Copy を実装できません（E0184）。`);
  }
}

function isImplOf(impl: ImplDef, trait: string): boolean {
  return impl.trait?.trait.builtin === trait;
}

function selfAdt(impl: ImplDef): AdtDef | undefined {
  const self = shallow(impl.selfType);
  return self.kind === 'adt' ? self.def : undefined;
}
