import { normalize } from './infer';
import { type Layout, NONE, type Outlives, relate } from './regions';
import { resolve, sameType, shallow, type Type } from './types';

/**
 * Lets the borrows of an error that `?` returns as it is flow into the function's result. A conversion by `From` makes
 * a value of another type, which owns what it holds.
 */
export function relateReturnedError(
  outlives: Outlives,
  operandType: Type | undefined,
  returnType: Type | undefined,
  operand: Layout,
  result: Layout
): void {
  const from = operandType && normalize(shallow(operandType));
  const to = returnType && normalize(shallow(returnType));
  if (from?.kind !== 'adt' || to?.kind !== 'adt' || from.def.builtin !== 'Result' || to.def.builtin !== 'Result')
    return;
  if (!sameType(resolve(from.args[1], true), resolve(to.args[1], true))) return;
  if (operand.kind === 'adt' && result.kind === 'adt')
    relate(outlives, operand.args[1] ?? NONE, result.args[1] ?? NONE);
}
