import { pyStr } from './conversions';
import type { Frame } from './frame';
import { namespaceDict } from './namespaces';
import { callValue, getAttributeOrUndefined, getItem, toArray } from './objects';
import { equals } from './operators';
import { currentRuntime } from './runtimeContext';
import { dictClass, None, stringValue, typeError, typeName } from './types';
import { type Kwargs, NamespaceMap, PyDict, type PyError, type PyValue } from './values';

/**
 * The keyword arguments of a call, merged as CPython's DICT_MERGE merges them: a repeated name raises at once, while a
 * key that is not a string is refused only when the call is made.
 */
export class KeywordArguments {
  private kwargs: Map<string, PyValue> | undefined;
  private readonly nonStringKeys: PyValue[] = [];

  constructor(private readonly callee: PyValue) {}

  add(name: string, value: PyValue, key: PyValue = name): void {
    this.kwargs ??= new NamespaceMap();
    if (!addKeyword(this.kwargs, key, value)) throw this.repeated(name);
  }

  merge(mapping: PyValue, frame: Frame): void {
    if (getAttributeOrUndefined(mapping, 'keys') === undefined) {
      throw typeError(`${functionStr(this.callee)} argument after ** must be a mapping, not ${typeName(mapping)}`);
    }
    for (const [key, value] of mappingEntries(mapping)) {
      frame.temporaries.push(key, value);
      const name = stringValue(key);
      if (name !== undefined) this.add(name, value, key);
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

export function addKeyword(kwargs: Map<string, PyValue>, key: PyValue, value: PyValue): boolean {
  if (typeof key !== 'string' || (kwargs instanceof NamespaceMap && kwargs.dictionary)) {
    const dict = namespaceDict(kwargs);
    if (dict.store.has(key)) return false;
    dict.store.set(key, value);
  } else {
    if (kwargs.has(key)) return false;
    kwargs.set(key, value);
  }
  return true;
}

export function keywordEntries(kwargs: Kwargs): [PyValue, PyValue][] {
  if (kwargs instanceof NamespaceMap && kwargs.dictionary)
    return kwargs.dictionary.ordered().map(({ key, value }) => [key, value]);
  return [...(kwargs ?? [])];
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
  if (mapping instanceof PyDict && mapping.cls.lookup('__iter__') === dictClass.lookup('__iter__'))
    return mapping.store.ordered().map((entry) => [entry.key, entry.value]);
  const keys = getAttributeOrUndefined(mapping, 'keys');
  if (keys === undefined) throw typeError(`'${typeName(mapping)}' object is not a mapping`);
  return toArray(callValue(keys, [])).map((key) => [key, getItem(mapping, key)]);
}

export function keywordMap(entries: Iterable<[PyValue, PyValue]>): NamespaceMap {
  const result = new NamespaceMap();
  for (const [key, value] of entries) setKeyword(result, key, value);
  return result;
}

export function copyKeywords(kwargs: Kwargs): NamespaceMap {
  return keywordMap(keywordEntries(kwargs));
}

export function setKeyword(kwargs: Map<string, PyValue>, key: PyValue, value: PyValue): void {
  if (typeof key === 'string') kwargs.set(key, value);
  else namespaceDict(kwargs).store.set(key, value);
}

export function unicodeKeywords(kwargs: Kwargs, name: string): Kwargs {
  if (!(kwargs instanceof NamespaceMap) || !kwargs.dictionary) return kwargs;
  const parsed = new Map<string, PyValue>();
  for (const [key, value] of keywordEntries(kwargs)) {
    const text = stringValue(key) as string;
    if (parsed.has(text)) throw typeError(`${name}() got an unexpected keyword argument '${text}'`);
    parsed.set(text, value);
    currentRuntime().handToNative(key);
  }
  return parsed;
}
