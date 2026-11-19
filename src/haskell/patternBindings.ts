import { tupleCon, UNIT_CON } from './builtinTypes';
import type { Core } from './core';
import type { ConValue } from './values';

export function patternResult(values: Core[], start = 0, end = values.length): Core {
  if (start === end) return { k: 'con', con: UNIT_CON, args: [] };
  if (end - start === 1) return values[start];
  const middle = Math.floor((start + end) / 2);
  return {
    k: 'con',
    con: tupleCon(2),
    args: [patternResult(values, start, middle), patternResult(values, middle, end)],
  };
}

export function patternProjection(matched: Core, index: number, count: number): Core {
  if (count === 1) return matched;
  return {
    k: 'app',
    fn: {
      k: 'prim',
      prim: {
        name: 'patternProjection',
        arity: 1,
        strict: 'all',
        fn: ([value], runtime) => {
          let result = value;
          let start = 0;
          let end = count;
          while (end - start > 1) {
            runtime.spend();
            const middle = Math.floor((start + end) / 2);
            const fields = (runtime.machine.force(result) as ConValue).fields;
            if (index < middle) {
              result = fields[0];
              end = middle;
            } else {
              result = fields[1];
              start = middle;
            }
          }
          return result;
        },
      },
    },
    args: [matched],
  };
}
