import { inspect } from './conversions';
import { argumentError } from './errors';
import type { Gen } from './interp';
import { type RHash, RSymbol } from './objects';

export function* exceptionOption(keywords: RHash | undefined): Gen<boolean> {
  let selected = true;
  const unknown: string[] = [];
  for (const entry of keywords?.map.values() ?? []) {
    if (entry.key instanceof RSymbol && entry.key.name === 'exception') {
      if (entry.value !== true && entry.value !== false)
        throw argumentError(`expected true or false as exception: ${yield* inspect(entry.value)}`);
      selected = entry.value;
    } else unknown.push(yield* inspect(entry.key));
  }
  if (unknown.length > 0) throw argumentError(`unknown keyword${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return selected;
}
