import type { Answer, TraitSolver } from './traits';
import type { BuiltinAdt, Type } from './types';

const KEY_TRAITS: Partial<Record<BuiltinAdt, readonly string[]>> = {
  HashMap: ['Eq', 'Hash'],
  HashSet: ['Eq', 'Hash'],
  BTreeMap: ['Ord'],
  BTreeSet: ['Ord'],
  BinaryHeap: ['Ord'],
};

export function collectionKeyTraits(builtin: BuiltinAdt | undefined): readonly string[] {
  return builtin ? (KEY_TRAITS[builtin] ?? []) : [];
}

export function collectionKeyAnswer(solver: TraitSolver, type: Type & { kind: 'adt' }): Answer {
  let answer: Answer = 'yes';
  for (const name of collectionKeyTraits(type.def.builtin)) {
    const bound = solver.implements(type.args[0], { trait: solver.program.traitDef(name), args: [] });
    if (bound === 'no') return 'no';
    if (bound === 'unknown') answer = 'unknown';
  }
  return answer;
}
