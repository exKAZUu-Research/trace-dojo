import { pyStr } from './conversions';
import type { Frame } from './frame';
import { bindValue, callValue, getAttributeOrUndefined, getItem, lookupSpecial, toArray } from './objects';
import { equals } from './operators';
import { None, typeError, typeName } from './types';
import { type Kwargs, PyDict, type PyError, type PyValue } from './values';

/**
 * The keyword arguments of a call, merged as CPython's DICT_MERGE merges them: a repeated name raises at once, while a
 * key that is not a string is refused only when the call is made.
 */
export class KeywordArguments {
  private kwargs: Map<string, PyValue> | undefined;
  private readonly nonStringKeys: PyValue[] = [];

  constructor(private readonly callee: PyValue) {}

  add(name: string, value: PyValue): void {
    this.kwargs ??= new Map();
    if (this.kwargs.has(name)) throw this.repeated(name);
    this.kwargs.set(name, value);
  }

  merge(mapping: PyValue, frame: Frame): void {
    if (lookupSpecial(mapping, 'keys') === undefined) {
      throw typeError(`${functionStr(this.callee)} argument after ** must be a mapping, not ${typeName(mapping)}`);
    }
    for (const [key, value] of mappingEntries(mapping)) {
      frame.temporaries.push(value);
      if (typeof key === 'string') this.add(key, value);
      else if (this.nonStringKeys.some((other) => equals(other, key))) throw this.repeated(pyStr(key));
      else this.nonStringKeys.push(key);
    }
  }

  finish(): Kwargs {
    if (this.nonStringKeys.length > 0) throw typeError('keywords must be strings');
    return this.kwargs;
  }

  private repeated(name: string): PyError {
    return typeError(`${functionStr(this.callee)} got multiple values for keyword argument '${name}'`);
  }
}

/** How CPython's _PyObject_FunctionStr names a callable in the errors of a call's argument unpacking. */
export function functionStr(callee: PyValue): string {
  const qualname = getAttributeOrUndefined(callee, '__qualname__');
  if (qualname === undefined) return pyStr(callee);
  const module = getAttributeOrUndefined(callee, '__module__');
  if (module === undefined || module === None || module === 'builtins') return `${pyStr(qualname)}()`;
  return `${pyStr(module)}.${pyStr(qualname)}()`;
}

/** The key-value pairs of a mapping, read through `keys()` and indexing for mappings that are not dicts. */
export function mappingEntries(mapping: PyValue): [PyValue, PyValue][] {
  if (mapping instanceof PyDict) return mapping.store.ordered().map((entry) => [entry.key, entry.value]);
  const keys = lookupSpecial(mapping, 'keys');
  if (keys === undefined) throw typeError(`'${typeName(mapping)}' object is not a mapping`);
  return toArray(callValue(bindValue(keys, mapping), [])).map((key) => [key, getItem(mapping, key)]);
}
