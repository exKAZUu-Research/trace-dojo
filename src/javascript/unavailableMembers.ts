import { CompileError } from '../interpreter/diagnostics';
import { orderBuiltinMembers } from './builtinOrder';
import { defineFunctionProperties } from './memberProperties';
import type { Realm } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import { JsFunction, JsObject, type Key, type Value } from './values';

/** Names an unavailable library member on a receiver, or gives undefined for any other. */
export type UnavailableMemberCheck = (value: Value, key: Key | undefined, readValue: boolean) => string | undefined;

export const unavailableWellKnownSymbols = new Set([
  'iterator',
  'asyncIterator',
  'hasInstance',
  'isConcatSpreadable',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
]);

const unavailableSymbolNames = new Map(
  Object.entries(WELL_KNOWN_SYMBOLS)
    .filter(([name]) => unavailableWellKnownSymbols.has(name))
    .map(([name, value]) => [value, name])
);

const consoleTimers = new Set<Key | undefined>(['time', 'timeEnd', 'timeLog', 'timeStamp']);

/**
 * Defines reflected method properties whose calls remain unavailable, and checks unavailable reads the type checker
 * cannot resolve, such as those through `any`.
 */
export function unavailableMemberCheck(realm: Realm): UnavailableMemberCheck {
  const symbol = realm.globals.lookup('Symbol')?.value;
  const math = realm.globals.lookup('Math')?.value;
  const console = realm.globals.lookup('console')?.value;
  defineUnavailableMethods(realm, math, console);
  return (value, key, readValue) => {
    if (readValue) return unavailableSymbolFeature(value, key, symbol);
    // Node.js gives every error its own stack, whatever its prototype becomes.
    if ((key === 'stack' || key === undefined) && value instanceof JsObject && value.isError) return 'Error の stack';
    if (key === 'stack' && inherits(value, realm.errorPrototypes.Error)) return 'Error の stack';
    return;
  };
}

function unavailableSymbolFeature(value: Value, key: Key | undefined, constructor: Value): string | undefined {
  const name = typeof value === 'symbol' ? unavailableSymbolNames.get(value) : key;
  if (typeof name !== 'string') return undefined;
  if (typeof value !== 'symbol' && (value !== constructor || !unavailableWellKnownSymbols.has(name))) return undefined;
  return `Symbol.${name} などの well-known シンボル`;
}

/** Ends the program on the row reading an unavailable member, as the type checker would have rejected it. */
export function rejectUnavailableMember(feature: string, row: number | undefined): never {
  const separator = /[\u0021-\u007E]$/.test(feature) ? ' ' : '';
  throw new CompileError([{ row: row ?? 0, message: `${feature}${separator}は、この採点環境では使えません。` }]);
}

function defineUnavailableMethods(realm: Realm, math: Value, console: Value): void {
  if (math instanceof JsObject) defineUnavailableMethod(realm, math, 'random', 'Math.random');
  if (console instanceof JsObject)
    for (const name of consoleTimers)
      defineUnavailableMethod(realm, console, String(name), `console.${String(name)}`, { enumerable: true });
  defineUnavailableMethod(realm, realm.regExpPrototype, 'compile', 'RegExp の compile', { length: 2 });
  orderBuiltinMembers(realm);
}

function inherits(value: Value, prototype: JsObject): boolean {
  if (!(value instanceof JsObject)) return false;
  for (let current: JsObject | null = value; current; current = current.proto) if (current === prototype) return true;
  return false;
}

function defineUnavailableMethod(
  realm: Realm,
  object: JsObject,
  name: string,
  feature: string,
  { length = 0, enumerable = false } = {}
): void {
  const method = new JsFunction(realm.functionPrototype, {
    kind: 'native',
    run: ({ runtime }) => rejectUnavailableMember(feature, runtime.currentRow),
    isConstructor: false,
  });
  defineFunctionProperties(method, name, length);
  object.properties.set(name, { value: method, writable: true, enumerable, configurable: true });
}
