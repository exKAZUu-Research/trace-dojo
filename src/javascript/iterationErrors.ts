import type { IterationContext, IterationSource } from './ast';
import type { Value } from './values';

/**
 * V8's TypeError for iterating a value without an iterator, which names the operand as its source prints it where
 * syntax iterates it, and otherwise names a callee or the value's type, as `typed` describes it.
 */
export function notIterableMessage(
  value: Value,
  typed: string,
  source: IterationSource | undefined,
  context: IterationContext
): string {
  const contextual = source && contextualMessage(value, typed, source, context);
  if (contextual) return contextual;
  if (!source || context === 'loweredCallSpread') return unread(typed);
  if (source.callee && !source.isOptionalChain)
    return `${source.callee} is not a function or its return value is not iterable`;
  return `${source.text} is not iterable`;
}

function contextualMessage(
  value: Value,
  typed: string,
  source: IterationSource,
  context: IterationContext
): string | undefined {
  const isNullish = value === undefined || value === null;
  switch (context) {
    case 'loweredCallSpread': {
      return source.isOptionalChain ? undefined : source.callee && unread(source.callee);
    }
    case 'propertyPattern': {
      if (!isNullish) return unread(source.text);
      return `Cannot destructure property 'Symbol(Symbol.iterator)' of '${source.text}' as it is ${String(value)}.`;
    }
    case 'forOf': {
      return source.isOptionalChain ? unread(source.callee ?? typed) : undefined;
    }
    case 'finalCallSpread': {
      if (isNullish) return `${source.text} is not iterable (cannot read property ${String(value)})`;
      return 'Spread syntax requires ...iterable[Symbol.iterator] to be a function';
    }
    case 'syntax': {
      return undefined;
    }
  }
}

function unread(label: string): string {
  return `${label} is not iterable (cannot read property Symbol(Symbol.iterator))`;
}
