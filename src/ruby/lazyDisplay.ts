import { inspect } from './conversions';
import type { Gen } from './interp';
import { RObject, type Value } from './objects';

const displaySources = new WeakMap<RObject, { source: Value; args: Value[] }>();

export function setLazyDisplaySource(enumerator: RObject, source: Value, args: Value[]): void {
  const previous = source instanceof RObject ? displaySources.get(source) : undefined;
  displaySources.set(enumerator, { source: previous?.source ?? source, args: [...(previous?.args ?? []), ...args] });
}

export function lazyDisplaySource(source: Value): Value {
  return (source instanceof RObject ? displaySources.get(source)?.source : undefined) ?? source;
}

export function* lazySourceDescription(source: Value): Gen<string> {
  const displayed = source instanceof RObject ? displaySources.get(source) : undefined;
  const name = yield* inspect(displayed?.source ?? source);
  const args: string[] = [];
  for (const arg of displayed?.args ?? []) args.push(yield* inspect(arg));
  return `${name}${args.length > 0 ? `(${args.join(', ')})` : ''}`;
}
