import type { TExpr } from './semaBase';
import { compileTimeReadable, ErrorValue, NULL, Slice, Some, type Value, ZArray, ZStruct, ZUnion } from './values';

export interface ValueFacts {
  readonly exact?: { readonly value: Value };
  readonly length?: bigint;
  readonly fields?: ReadonlyMap<number, ValueFacts>;
  readonly payload?: ValueFacts;
}

export function valueFactsOf(expression: TExpr): ValueFacts | undefined {
  const exact = staticResultOf(expression);
  if (exact) return { exact };
  if (expression.valueFacts || expression.knownLength !== undefined)
    return { ...expression.valueFacts, length: expression.knownLength ?? expression.valueFacts?.length };
  return undefined;
}

export function aggregateFacts(
  elements: readonly TExpr[],
  spend: () => void,
  positions?: readonly number[]
): ValueFacts | undefined {
  const fields = new Map<number, ValueFacts>();
  for (const [index, element] of elements.entries()) {
    spend();
    const facts = valueFactsOf(element);
    if (facts) fields.set(positions?.[index] ?? index, facts);
  }
  return fields.size > 0 ? { fields } : undefined;
}

export function fieldFacts(facts: ValueFacts | undefined, index: number): ValueFacts | undefined {
  const value = facts?.exact?.value;
  if (value instanceof ZArray) return { exact: { value: value.get(index) } };
  if (value instanceof ZStruct) return { exact: { value: value.slots[index] } };
  if (value instanceof ZUnion) return value.tag === index ? { exact: { value: value.slots[0] } } : undefined;
  if (value instanceof Slice && compileTimeReadable(value)) return { exact: { value: value.get(index) } };
  return facts?.fields?.get(index);
}

export function payloadFacts(expression: TExpr): ValueFacts | undefined {
  const facts = valueFactsOf(expression);
  const exact = facts?.exact;
  if (!exact) return facts?.payload;
  if (expression.type.kind === 'optional') {
    if (exact.value === NULL) return undefined;
    return { exact: { value: exact.value instanceof Some ? exact.value.value : exact.value } };
  }
  return exact.value instanceof ErrorValue ? undefined : { exact };
}

export function concatenatedFacts(
  left: TExpr,
  right: TExpr,
  leftLength: number,
  rightLength: number,
  spend: () => void
): ValueFacts | undefined {
  if (left.known && right.known) return undefined;
  const fields = new Map<number, ValueFacts>();
  for (const [expression, offset, length] of [
    [left, 0, leftLength],
    [right, leftLength, rightLength],
  ] as const) {
    const facts = valueFactsOf(expression);
    if (!facts) continue;
    for (let index = 0; index < length; index++) {
      spend();
      const field = fieldFacts(facts, index);
      if (field) fields.set(offset + index, field);
    }
  }
  return fields.size > 0 ? { fields } : undefined;
}

export function staticResultOf(expression: TExpr): { value: Value } | undefined {
  return expression.known ? { value: expression.value } : expression.staticResult;
}
