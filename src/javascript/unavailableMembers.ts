import { CompileError } from '../interpreter/diagnostics';
import type { Realm } from './realm';
import { JsObject, type Key, type Value } from './values';

/** Names the library member a program reads that this interpreter leaves out, or gives undefined for any other. */
export type UnavailableMemberCheck = (value: Value, key: Key) => string | undefined;

const consoleTimers = new Set<Key>(['time', 'timeEnd', 'timeLog', 'timeStamp']);

/**
 * The members TypeScript programs may not use and the realm leaves out, which the type checker rejects where it knows
 * the receiver; a value typed `any` reaches them only at run time.
 */
export function unavailableMemberCheck(realm: Realm): UnavailableMemberCheck {
  const math = realm.globals.lookup('Math')?.value;
  const console = realm.globals.lookup('console')?.value;
  return (value, key) => {
    if (value === math && key === 'random') return 'Math.random';
    if (value === console && consoleTimers.has(key)) return `console.${String(key)}`;
    if (key === 'stack' && inherits(value, realm.errorPrototypes.Error)) return 'Error の stack';
    if (key === 'compile' && inherits(value, realm.regExpPrototype)) return 'RegExp の compile';
    return;
  };
}

/** Ends the program on the row reading an unavailable member, as the type checker would have rejected it. */
export function rejectUnavailableMember(feature: string, row: number | undefined): never {
  throw new CompileError([{ row: row ?? 0, message: `${feature} は、この採点環境では使えません。` }]);
}

function inherits(value: Value, prototype: JsObject): boolean {
  if (!(value instanceof JsObject)) return false;
  for (let current: JsObject | null = value; current; current = current.proto) if (current === prototype) return true;
  return false;
}
