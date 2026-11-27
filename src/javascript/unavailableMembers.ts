import { CompileError } from '../interpreter/diagnostics';
import { orderBuiltinMembers } from './builtinOrder';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  UNAVAILABLE_FS_MEMBERS,
  UNAVAILABLE_PROCESS_MEMBERS,
  UNAVAILABLE_STREAM_MEMBERS,
} from './unavailableNodeMembers';
import { JsObject, type Key, type NativeCall, type Value } from './values';

/** Names an unavailable library member on a receiver, or gives undefined for any other. */
export type UnavailableMemberCheck = (value: Value, key: Key | undefined) => string | undefined;

/**
 * The well-known symbols whose protocols a TypeScript program may not replace, which leaves those that the syntax of
 * iteration relies on; `using`, which relies on `Symbol.dispose`, has no library types to check it with.
 */
export const unavailableWellKnownSymbols = new Set([
  ...Object.keys(WELL_KNOWN_SYMBOLS).filter((name) => !['iterator', 'asyncIterator'].includes(name)),
  'isConcatSpreadable',
  'match',
  'matchAll',
  'replace',
  'search',
  'split',
  'unscopables',
]);

export const legacyRegExpStaticsFeature = 'RegExp の旧式の静的プロパティ';
export const unavailableRegExpStatics = new Set([
  'input',
  '$_',
  'lastMatch',
  '$&',
  'lastParen',
  '$+',
  'leftContext',
  '$`',
  'rightContext',
  "$'",
  '$1',
  '$2',
  '$3',
  '$4',
  '$5',
  '$6',
  '$7',
  '$8',
  '$9',
]);

const unavailableSymbolNames = new Map(Object.entries(WELL_KNOWN_SYMBOLS).map(([name, value]) => [value, name]));

const consoleTimers = new Set<Key | undefined>(['time', 'timeEnd', 'timeLog', 'timeStamp']);

/**
 * Defines reflected method properties whose calls remain unavailable and `Math.random`, which a TypeScript program
 * draws random numbers with as a Java one does, from the host's generator, and checks unavailable reads the type
 * checker cannot resolve, such as those through `any`.
 */
export function unavailableMemberCheck(runtime: Runtime): UnavailableMemberCheck {
  const { realm } = runtime;
  const symbol = realm.globals.lookup('Symbol')?.value;
  const math = realm.globals.lookup('Math')?.value;
  const console = realm.globals.lookup('console')?.value;
  defineUnavailableMethods(runtime, console);
  if (math instanceof JsObject)
    math.properties.set('random', {
      value: runtime.newNativeFunction('random', 0, () => Math.random()),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  defineUnavailableRegExpStatics(runtime);
  orderBuiltinMembers(realm);
  const process = realm.globals.lookup('process')?.value;
  const nodeObjects = new Map<Value, { owner: string; members: ReadonlySet<string> }>();
  if (process instanceof JsObject) {
    nodeObjects.set(process, { owner: 'process', members: UNAVAILABLE_PROCESS_MEMBERS });
    for (const streamName of ['stdout', 'stderr'] as const) {
      const stream = runtime.get(process, streamName);
      if (stream instanceof JsObject) {
        nodeObjects.set(stream, { owner: `process.${streamName}`, members: UNAVAILABLE_STREAM_MEMBERS });
      }
    }
  }
  if (realm.fsModule) nodeObjects.set(realm.fsModule, { owner: 'fs', members: UNAVAILABLE_FS_MEMBERS });
  return (value, key) => {
    const target = nodeObjects.get(value);
    const isUnavailableNodeMember =
      target !== undefined &&
      typeof key === 'string' &&
      value instanceof JsObject &&
      !value.properties.has(key) &&
      target.members.has(key);
    return (
      unavailableSymbolFeature(value, key, symbol) ?? (isUnavailableNodeMember ? `${target.owner}.${key}` : undefined)
    );
  };
}

function unavailableSymbolFeature(value: Value, key: Key | undefined, constructor: Value): string | undefined {
  const name = typeof value === 'symbol' ? unavailableSymbolNames.get(value) : value === constructor ? key : undefined;
  return typeof name === 'string' && unavailableWellKnownSymbols.has(name) ? wellKnownSymbolFeature(name) : undefined;
}

export function wellKnownSymbolFeature(name: string): string {
  return `Symbol.${name} などの well-known シンボル`;
}

/** Ends the program on the row reading an unavailable member, as the type checker would have rejected it. */
export function rejectUnavailableMember(feature: string, row: number | undefined): never {
  const separator = /[\u0021-\u007E]$/.test(feature) ? ' ' : '';
  throw new CompileError([{ row: row ?? 0, message: `${feature}${separator}は、この採点環境では使えません。` }]);
}

function defineUnavailableMethods(runtime: Runtime, console: Value): void {
  const { realm } = runtime;
  const array = realm.globals.lookup('Array')?.value;
  if (array instanceof JsObject) defineUnavailableMethod(runtime, array, 'fromAsync', 'Array.fromAsync', { length: 1 });
  if (console instanceof JsObject)
    for (const name of consoleTimers)
      defineUnavailableMethod(runtime, console, String(name), `console.${String(name)}`, { enumerable: true });
  defineUnavailableMethod(runtime, realm.regExpPrototype, 'compile', 'RegExp の compile', { length: 2 });
}

function defineUnavailableMethod(
  runtime: Runtime,
  object: JsObject,
  name: string,
  feature: string,
  { length = 0, enumerable = false } = {}
): void {
  const method = runtime.newNativeFunction(name, length, ({ runtime: caller }) =>
    rejectUnavailableMember(feature, caller.currentRow)
  );
  object.properties.set(name, { value: method, writable: true, enumerable, configurable: true });
}

function defineUnavailableRegExpStatics(runtime: Runtime): void {
  const constructor = runtime.realm.regExpConstructor;
  if (!constructor) return;
  for (const name of unavailableRegExpStatics) {
    constructor.properties.set(name, {
      get: runtime.newNativeFunction(`get ${name}`, 0, rejectLegacyRegExpStatic),
      set: runtime.newNativeFunction(`set ${name}`, 1, rejectLegacyRegExpStatic),
      enumerable: false,
      configurable: true,
    });
  }
}

function rejectLegacyRegExpStatic({ runtime }: NativeCall): never {
  return rejectUnavailableMember(legacyRegExpStaticsFeature, runtime.currentRow);
}
