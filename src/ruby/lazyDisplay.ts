import { inspect } from './conversions';
import type { Gen } from './interp';
import { RObject, type Value } from './objects';

const displaySources = new WeakMap<RObject, { source: Value; args: Value[]; method?: string }>();

export function setLazyDisplaySource(enumerator: RObject, source: Value, args: Value[], method?: string): void {
  const previous = source instanceof RObject ? displaySources.get(source) : undefined;
  displaySources.set(enumerator, {
    source: previous?.source ?? source,
    args: [...(previous?.args ?? []), ...args],
    method: method ?? previous?.method,
  });
}

export function lazyDisplaySource(source: Value): Value {
  const displayed = source instanceof RObject ? displaySources.get(source) : undefined;
  return displayed?.method === undefined ? (displayed?.source ?? source) : source;
}

export function* lazySourceDescription(source: Value): Gen<string> {
  const displayed = source instanceof RObject ? displaySources.get(source) : undefined;
  const name = yield* inspect(displayed?.source ?? source);
  const args: string[] = [];
  for (const arg of displayed?.args ?? []) args.push(yield* inspect(arg));
  return `${name}${displayed?.method === undefined ? '' : `:${displayed.method}`}${args.length > 0 ? `(${args.join(', ')})` : ''}`;
}
