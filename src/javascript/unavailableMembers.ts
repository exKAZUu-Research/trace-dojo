import { CompileError } from '../interpreter/diagnostics';
import { orderBuiltinMembers } from './builtinOrder';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
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

/**
 * The members of @types/node's `process` (26.6.7) other than its standard streams, which a TypeScript program sees
 * declared but may not use.
 */
export const unavailableProcessMembers = [
  'abort',
  'addListener',
  'addUncaughtExceptionCaptureCallback',
  'allowedNodeEnvironmentFlags',
  'arch',
  'argv0',
  'availableMemory',
  'channel',
  'chdir',
  'config',
  'connected',
  'constrainedMemory',
  'cpuUsage',
  'cwd',
  'debugPort',
  'disconnect',
  'dlopen',
  'emit',
  'emitWarning',
  'eventNames',
  'execArgv',
  'execPath',
  'execve',
  'features',
  'finalization',
  'getActiveResourcesInfo',
  'getBuiltinModule',
  'getMaxListeners',
  'getegid',
  'geteuid',
  'getgid',
  'getgroups',
  'getuid',
  'hasUncaughtExceptionCaptureCallback',
  'hrtime',
  'kill',
  'listenerCount',
  'listeners',
  'loadEnvFile',
  'mainModule',
  'memoryUsage',
  'nextTick',
  'noDeprecation',
  'off',
  'once',
  'permission',
  'pid',
  'platform',
  'ppid',
  'prependListener',
  'prependOnceListener',
  'rawListeners',
  'ref',
  'release',
  'removeAllListeners',
  'removeListener',
  'report',
  'resourceUsage',
  'send',
  'setMaxListeners',
  'setSourceMapsEnabled',
  'setUncaughtExceptionCaptureCallback',
  'setegid',
  'seteuid',
  'setgid',
  'setgroups',
  'setuid',
  'sourceMapsEnabled',
  'threadCpuUsage',
  'throwDeprecation',
  'title',
  'traceDeprecation',
  'traceProcessWarnings',
  'umask',
  'unref',
  'uptime',
  'version',
  'versions',
];

/** The members of `process` a TypeScript program may not read, which include those @types/node declares with types. */
const unavailableProcessMemberNames = new Set<Key | undefined>([
  ...unavailableProcessMembers,
  'stdin',
  'argv',
  'env',
  'exitCode',
  'exit',
  'on',
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
  return (value, key) =>
    unavailableSymbolFeature(value, key, symbol) ??
    (value === process && unavailableProcessMemberNames.has(key) ? `process.${String(key)}` : undefined);
}

function unavailableSymbolFeature(value: Value, key: Key | undefined, constructor: Value): string | undefined {
  const name = typeof value === 'symbol' ? unavailableSymbolNames.get(value) : key;
  if (typeof name !== 'string') return undefined;
  if (typeof value !== 'symbol' && (value !== constructor || !unavailableWellKnownSymbols.has(name))) return undefined;
  return wellKnownSymbolFeature(name);
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
