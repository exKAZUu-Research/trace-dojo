import { loadParser } from '../../interpreter/treeSitter';
import { TURTLE_METHOD_NAMES } from '../../interpreter/turtleWorld';
import { BROWSER_ONLY_GLOBALS, DOM_TYPE_ALIASES, SHARED_HOST_GLOBALS } from './domGlobals';
import { DOM_INTERFACES } from './domMembers';
import { ECMASCRIPT_LIBRARY } from './ecmascriptLibrary';
import { LOCALE_OPTIONS_LIBRARY } from './localeOptionsLibrary';
import { Scope, Sym } from './scopes';
import { undefinedType } from './types';

const omittedLibraryGlobals = [
  'Intl',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'WebAssembly',
];

const turtleMethods = Object.entries(TURTLE_METHOD_NAMES)
  .flatMap(([kind, names]) =>
    names.map((name) => `  ${name}(): ${kind === 'canMoveForward' || kind === 'isFrontPainted' ? 'boolean' : 'void'};`)
  )
  .join('\n');

/** The globals of the reference environment beyond ECMAScript: `console` from the DOM library, and the turtle. */
const HOST_LIBRARY = `
interface Console {
  assert(condition?: boolean, ...data: any[]): void;
  clear(): void;
  count(label?: string): void;
  countReset(label?: string): void;
  debug(...data: any[]): void;
  dir(item?: any, options?: any): void;
  dirxml(...data: any[]): void;
  error(...data: any[]): void;
  group(...data: any[]): void;
  groupCollapsed(...data: any[]): void;
  groupEnd(): void;
  info(...data: any[]): void;
  log(...data: any[]): void;
  table(tabularData?: any, properties?: string[]): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...data: any[]): void;
  timeStamp(label?: string): void;
  trace(...data: any[]): void;
  warn(...data: any[]): void;
}
declare var console: Console;
declare class Turtle {
  constructor();
  constructor(x: number, y: number);
  constructor(x: number, y: number, color: string);
${turtleMethods}
}
declare function setTimeout(handler: any, timeout?: number, ...arguments: any[]): number;
declare function setInterval(handler: any, timeout?: number, ...arguments: any[]): number;
declare function clearTimeout(id: number | undefined): void;
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T = any>(value: T, options?: any): T;
declare function fetch(input: any, init?: any): Promise<any>;
declare function alert(message?: any): void;
declare function prompt(message?: string, _default?: string): string | null;
declare function toString(): string;
declare var globalThis: any;
declare var Proxy: any;
declare var Reflect: any;
`;

/**
 * The rest of the DOM library, whose values the reference `tsc` accepts but Node.js lacks (so they fail when the program
 * runs) or this interpreter lacks. Declaration kinds preserve script-global redeclaration checks.
 */
const BROWSER_LIBRARY = [
  ...omittedLibraryGlobals.map((name) => `declare var ${name}: any; type ${name} = any;`),
  ...Object.entries({ ...BROWSER_ONLY_GLOBALS, ...SHARED_HOST_GLOBALS }).map(([name, [kind, type]]) =>
    kind === 'function'
      ? type
          .split('\n')
          .filter(Boolean)
          .map((signature) => `declare ${signature}`)
          .join('\n')
      : `declare ${kind} ${name}: ${type};`
  ),
  ...Object.entries(DOM_TYPE_ALIASES).map(([declaration, definition]) => `type ${declaration} = ${definition};`),
].join('\n');

const parser = await loadParser('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm');

/** The library's declarations, parsed once; its tree lives as long as the process. */
export const libraryTree = (() => {
  const tree = parser.parse(`${ECMASCRIPT_LIBRARY}\n${HOST_LIBRARY}\n${BROWSER_LIBRARY}\n${DOM_INTERFACES}`);
  if (!tree) throw new Error('The parser returned no tree for the library');
  return tree;
})();

export const localeOptionsTree = (() => {
  const tree = parser.parse(LOCALE_OPTIONS_LIBRARY);
  if (!tree) throw new Error('The parser returned no tree for locale options');
  return tree;
})();

export function libraryScope(): Scope {
  const scope = new Scope('global', undefined, undefined);
  const builtinUndefined = new Sym('undefined', scope);
  builtinUndefined.valueKind = 'declared';
  builtinUndefined.valueType = undefinedType;
  scope.values.set(builtinUndefined.name, builtinUndefined);
  return scope;
}

/** Library values that this interpreter does not run yet, with the names learners know them by. */
const unsupportedValues: Record<string, string> = {
  Promise: 'Promise',
  setTimeout: 'setTimeout などのタイマー',
  setInterval: 'setTimeout などのタイマー',
  clearTimeout: 'setTimeout などのタイマー',
  clearInterval: 'setTimeout などのタイマー',
  queueMicrotask: 'queueMicrotask',
  Date: 'Date（日付と時刻）',
  WeakMap: 'WeakMap',
  WeakSet: 'WeakSet',
  WeakRef: 'WeakRef',
  FinalizationRegistry: 'FinalizationRegistry',
  Proxy: 'Proxy',
  Reflect: 'Reflect',
  eval: 'eval',
  Function: 'Function コンストラクタ',
  structuredClone: 'structuredClone',
  globalThis: 'globalThis',
  fetch: 'fetch などのネットワーク',
  alert: 'alert',
  prompt: 'prompt などの標準入力',
  AggregateError: 'AggregateError',
};

export function markUnsupported(scope: Scope): void {
  for (const [name, feature] of [
    ...Object.entries(unsupportedValues),
    ...omittedLibraryGlobals.map((name) => [name, name]),
    ...Object.keys(SHARED_HOST_GLOBALS).map((name) => [name, name]),
  ]) {
    const symbol: Sym | undefined = scope.values.get(name);
    if (symbol) {
      symbol.unsupported = feature;
      symbol.unsupportedCallOnly = name === 'Function';
    }
    if (omittedLibraryGlobals.includes(name)) {
      const type = scope.types.get(name);
      if (type) type.unsupported = feature;
    }
  }
}
