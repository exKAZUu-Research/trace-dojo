import { loadParser } from '../../interpreter/treeSitter';
import { TURTLE_METHOD_NAMES } from '../../interpreter/turtleWorld';
import {
  BROWSER_ONLY_GLOBALS,
  BROWSER_TYPES,
  DOM_FUNCTION_CONSTRAINTS,
  DOM_TYPE_ALIASES,
  SHARED_HOST_GLOBALS,
} from './domGlobals';
import { ECMASCRIPT_LIBRARY } from './ecmascriptLibrary';
import { Scope, type Sym } from './scopes';

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
  constructor(x?: number, y?: number, color?: string);
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
declare var globalThis: any;
declare var Proxy: any;
declare var Reflect: any;
`;

/**
 * The rest of the DOM library, whose values the reference `tsc` accepts but Node.js lacks (so they fail when the program
 * runs) or this interpreter lacks. Declaration kinds and type names preserve script-global redeclaration checks;
 * the DOM's structural types remain opaque.
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
  ...BROWSER_TYPES.map((entry) => {
    if (typeof entry === 'string') return `type ${entry} = ${DOM_TYPE_ALIASES[entry] ?? 'any'};`;
    const [name, count] = entry;
    return `type ${name}<${Array.from({ length: count }, (_, index) => `T${index} = any`).join(', ')}> = any;`;
  }),
].join('\n');

const parser = await loadParser('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm');

/** The library's declarations, parsed once; its tree lives as long as the process. */
export const libraryTree = (() => {
  const tree = parser.parse(`${ECMASCRIPT_LIBRARY}\n${HOST_LIBRARY}\n${BROWSER_LIBRARY}`);
  if (!tree) throw new Error('The parser returned no tree for the library');
  return tree;
})();

export const nativeOverloadTree = (() => {
  const tree = parser.parse(Object.values(DOM_FUNCTION_CONSTRAINTS).join('\n'));
  if (!tree) throw new Error('The parser returned no tree for native overload constraints');
  return tree;
})();

export function libraryScope(): Scope {
  return new Scope('global', undefined, undefined);
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
  escape: 'escape',
  unescape: 'unescape',
};

export function markUnsupported(scope: Scope): void {
  for (const [name, feature] of [
    ...Object.entries(unsupportedValues),
    ...omittedLibraryGlobals.map((name) => [name, name]),
    ...Object.keys(SHARED_HOST_GLOBALS).map((name) => [name, name]),
  ]) {
    const symbol: Sym | undefined = scope.values.get(name);
    if (symbol) symbol.unsupported = feature;
    if (omittedLibraryGlobals.includes(name)) {
      const type = scope.types.get(name);
      if (type) type.unsupported = feature;
    }
  }
}
