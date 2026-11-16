import { PANIC, panic } from '../arith';
import type { Span } from '../ast';
import type { FunctionInstance } from '../functions';
import { parseZig } from '../parse';
import { type Frame, withHeldValues } from '../runtime';
import type { SemaApi } from '../semaBase';
import { BOOL, fnType, sliceOf, type Type } from '../types';
import { FnValue, type Slice, type Value } from '../values';
import { BLOCK_SORT_SOURCE } from './blockSortSource';
import { nativeFunction } from './native';

let file: ReturnType<typeof parseZig> | undefined;

export function blockSortFunction(sema: SemaApi, element: Type, context: Type, span: Span): FunctionInstance {
  file ??= parseZig(BLOCK_SORT_SOURCE);
  return sema.libraryFunction(
    file,
    element,
    'block',
    [sliceOf(element, false), context, fnType([context, element, element], BOOL)],
    span
  );
}

export function runBlockSort(
  sema: SemaApi,
  fn: FunctionInstance,
  frame: Frame,
  items: Slice,
  context: Value,
  call: (args: Value[]) => Value
): void {
  const predicate = fn.params[2];
  if (predicate.kind !== 'fn') throw new Error('Invalid block sort predicate');
  const compare = new FnValue(
    nativeFunction('std.sort.block.compare', [...predicate.params], BOOL, (args, caller) =>
      withHeldValues(caller, args, () => {
        const lt = call(args) as boolean;
        const gt = call([args[0], args[2], args[1]]) as boolean;
        if (lt && gt) panic(PANIC.unreachable);
        return lt;
      })
    )
  );
  sema.callFunction(fn, [items, context, compare], frame);
}
