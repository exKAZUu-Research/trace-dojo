import { compareValues } from '../ops';
import type { Type } from '../types';
import { CellPlace, DONE, type IterValue, type Value } from '../values';
import { dropItem, foldingView, nextOf } from './iterators';
import { call, type NativeContext, none, some } from './support';

/**
 * `max_by` and `min_by`: `compare(the best so far, the next)` for each next element, as `cmp::max_by` and
 * `cmp::min_by` call it; `max` keeps the next on `Equal` and `min` keeps the best so far.
 */
export function extreme(
  ctx: NativeContext,
  iter: IterValue,
  compare: (a: Value, b: Value) => number,
  sign: 1 | -1
): Value {
  const first = nextOf(iter);
  if (first === DONE) return none(ctx);
  const best = new CellPlace(first);
  const rest = foldingView(iter);
  return ctx.runtime.withRoots([best], () => {
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(rest);
      if (item === DONE) return some(ctx, best.value);
      const keep = ctx.runtime.withRoots([item], () => keepsBest(compare(best.value, item), sign));
      // The element that loses goes at once.
      dropItem(ctx, keep ? item : best.value);
      if (!keep) best.value = item;
    }
  });
}

/** `max_by_key` and `min_by_key`: each key once, in order, compared as `extreme` compares the elements. */
export function extremeByKey(ctx: NativeContext, iter: IterValue, f: Value, keyType: Type, sign: 1 | -1): Value {
  const first = nextOf(iter);
  if (first === DONE) return none(ctx);
  let best = first;
  let bestKey = ctx.runtime.withRoots([first], () => call(ctx, f, [first]));
  const rest = foldingView(iter);
  const retained = [best, bestKey];
  return ctx.runtime.withRoots(retained, () => {
    for (;;) {
      ctx.runtime.spend();
      const item = nextOf(rest);
      if (item === DONE) return some(ctx, best);
      const keep = ctx.runtime.withRoots([item], () => {
        const key = call(ctx, f, [item]);
        return ctx.runtime.withRoots([key], () => {
          if (keepsBest(compareValues(keyType, bestKey, key) ?? 0, sign)) return true;
          bestKey = key;
          return false;
        });
      });
      // The element that loses goes at once.
      const [winner, loser] = keep ? [best, item] : [item, best];
      dropItem(ctx, loser);
      best = winner;
      retained[0] = best;
      retained[1] = bestKey;
    }
  });
}

function keepsBest(order: number, sign: 1 | -1): boolean {
  return sign === 1 ? order > 0 : order <= 0;
}
