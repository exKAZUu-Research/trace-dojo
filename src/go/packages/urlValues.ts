import { mapKeyOf } from '../equality';
import { newError } from '../errorValues';
import { addMethod, currentRuntime, fn, namedType } from '../native';
import { plainPanic } from '../runtimeErrors';
import { appendValues } from '../sliceOps';
import { sliceOf } from '../types';
import { GoMap, Slice, type Value } from '../values';
import { BOOL, sliceOfValues, sliceValues, spendFor, STRING } from './support';
import { attempt, cut, escape, unescape } from './urlEscape';

/** `url.Values`, a `map[string][]string` with methods. */
export const VALUES = namedType('url', 'Values', { kind: 'map', key: STRING, value: sliceOf(STRING) });

const keyOf = mapKeyOf(STRING);

/** A new `url.Values` with the pairs of a query, and the first error in the query, as `ParseQuery` returns. */
export function parseQuery(query: string): [GoMap, Value] {
  const map = new GoMap(keyOf);
  spendFor(query.length);
  if (query.split('&').length > 10_000) return [map, newError('number of URL query parameters exceeded limit')];
  let err: Value;
  let rest = query;
  while (rest !== '') {
    let key: string;
    [key, rest] = cut(rest, '&');
    if (key.includes(';')) {
      err = newError('invalid semicolon separator in query');
      continue;
    }
    if (key === '') continue;
    const [rawKey, rawValue] = cut(key, '=');
    const decoded = attempt(() => [unescape(rawKey, 'queryComponent'), unescape(rawValue, 'queryComponent')]);
    if ('error' in decoded) {
      err ??= decoded.error;
      continue;
    }
    const [k, v] = decoded.value;
    setValues(map, k, appendString(valuesEntry(map, k), v));
  }
  return [map, err];
}

function valuesEntry(values: Value, key: string): Value {
  return (values as GoMap | undefined)?.entries.get(keyOf(key))?.value;
}

function setValues(values: Value, key: string, list: Value): void {
  if (!(values instanceof GoMap)) plainPanic('assignment to entry in nil map');
  const existing = values.entries.get(keyOf(key));
  if (existing) existing.value = list;
  else {
    currentRuntime().allocate(2);
    values.entries.set(keyOf(key), { key, value: list });
  }
}

/** `append(list, values...)` for a `[]string`. */
function appendStrings(list: Value, values: Value[]): Value {
  const runtime = currentRuntime();
  return appendValues(
    list as Slice | undefined,
    values,
    STRING,
    () => '',
    (count) => runtime.allocate(count)
  );
}

function appendString(list: Value, value: string): Value {
  return appendStrings(list, [value]);
}

function encodeValues(values: Value): string {
  if (!(values instanceof GoMap) || values.entries.size === 0) return '';
  const entries = [...values.entries.values()].toSorted((a, b) =>
    (a.key as string) < (b.key as string) ? -1 : (a.key as string) > (b.key as string) ? 1 : 0
  );
  const parts: string[] = [];
  for (const { key, value } of entries) {
    const keyEscaped = escape(key as string, 'queryComponent');
    for (const item of sliceValues(value)) parts.push(`${keyEscaped}=${escape(item as string, 'queryComponent')}`);
  }
  const result = parts.join('&');
  currentRuntime().checkStringLength(result.length);
  return result;
}

/** `Values.Clone`, whose lists are `slices.Clone` copies: nil stays nil, and others grow from an empty slice. */
function cloneValues(values: Value): Value {
  if (!(values instanceof GoMap)) return undefined;
  const copy = new GoMap(keyOf);
  for (const [hashed, { key, value }] of values.entries) {
    const list = value as Slice | undefined;
    copy.entries.set(hashed, {
      key,
      value: list === undefined ? undefined : appendStrings(new Slice([], 0, 0, 0), list.values()),
    });
  }
  return copy;
}

addMethod(VALUES, 'Get', fn([STRING], [STRING]), (receiver, [key]) => {
  const list = valuesEntry(receiver, key as string) as Slice | undefined;
  return list && list.length > 0 ? list.get(0) : '';
});
addMethod(VALUES, 'Set', fn([STRING, STRING], []), (receiver, [key, value]) => {
  setValues(receiver, key as string, sliceOfValues([value]));
  return;
});
addMethod(VALUES, 'Add', fn([STRING, STRING], []), (receiver, [key, value]) => {
  setValues(receiver, key as string, appendString(valuesEntry(receiver, key as string), value as string));
  return;
});
addMethod(VALUES, 'Del', fn([STRING], []), (receiver, [key]) => {
  (receiver as GoMap | undefined)?.entries.delete(keyOf(key));
  return;
});
addMethod(
  VALUES,
  'Has',
  fn([STRING], [BOOL]),
  (receiver, [key]) => (receiver as GoMap | undefined)?.entries.has(keyOf(key)) ?? false
);
addMethod(VALUES, 'Encode', fn([], [STRING]), (receiver) => encodeValues(receiver));
addMethod(VALUES, 'Clone', fn([], [VALUES]), (receiver) => cloneValues(receiver));
