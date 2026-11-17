import { PANIC, panic } from '../arith';
import type { Span } from '../ast';
import { parseZig } from '../parse';
import { type Frame, withHeldValues } from '../runtime';
import { known, type SemaApi, type TExpr } from '../semaBase';
import { BOOL, fnType, type Type } from '../types';
import { FnValue, type Slice, type Value } from '../values';
import { BLOCK_SORT_SOURCE } from './blockSortSource';
import { nativeFunction } from './native';

let file: ReturnType<typeof parseZig> | undefined;

export function blockSorter(
  sema: SemaApi,
  element: Type,
  args: readonly [TExpr, TExpr],
  compare: ReturnType<SemaApi['functionOf']>,
  transferCost: number,
  span: Span
): (frame: Frame, items: Slice, context: Value) => void {
  file ??= parseZig(BLOCK_SORT_SOURCE);
  const predicate = fnType([args[1].type, element, element], BOOL);
  const comparison = new FnValue(
    nativeFunction('std.sort.block.compare', [...predicate.params], BOOL, (args, caller) =>
      withHeldValues(caller, args, () => {
        const lt = compareWithTransfers(compare, caller, args, transferCost);
        const gt = compareWithTransfers(compare, caller, [args[0], args[2], args[1]], transferCost);
        if (lt && gt) panic(PANIC.unreachable);
        return lt;
      })
    )
  );
  const fn = sema.libraryFunction(file, element, 'block', [args[0].type, args[1].type, predicate], span, {
    args: [...args, known(predicate, comparison, span)],
  });
  return (frame, items, context) => {
    sema.callFunction(fn, [items, context, comparison], frame);
  };
}

function compareWithTransfers(
  compare: ReturnType<SemaApi['functionOf']>,
  frame: Frame,
  args: Value[],
  cost: number
): boolean {
  frame.runtime.spend(cost * 2);
  return compare.call(frame, args) as boolean;
}
