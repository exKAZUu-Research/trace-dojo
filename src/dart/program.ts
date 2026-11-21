import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { Library } from './ast';
import type { ClassInfo } from './classes';
import { type CompiledProgram, Compiler, initialGlobals, instantiateObject } from './compiler';
import { valueIs } from './compilerBase';
import { type GlobalVariable, LibraryEnv, type TopLevelFunction } from './environment';
import { stringOf } from './format';
import { CORE_SOURCE } from './library/core';
import { addAllToMap, listIterator, newMap, newSet, quickCopySet, syncStarIterable } from './library/nativeCollections';
import { COLLECTION_SOURCE, CONVERT_SOURCE, IO_SOURCE, MATH_SOURCE } from './library/others';
import './library/nativeCore';
import './library/nativeNumbers';
import './library/nativeStrings';
import './library/nativeRegExp';
import './library/nativeOthers';
import './library/nativeConvert';
import './library/nativeBigInt';
import { NATIVES } from './library/nativeSupport';
import { parseDart } from './parse';
import { DartThrow, EMPTY_TYPE_ENV, Frame, type FunctionInfo, type LibraryLinks, Runtime } from './runtime';
import {
  coreTypes,
  type DartType,
  DYNAMIC,
  functionType,
  interfaceType,
  isSubtype as import_isSubtype,
  sameType,
  vmTypeString,
} from './types';
import { DartList, DartObject, DartRecord, DartTypeValue, type Value } from './values';

interface LibrarySource {
  uri: string;
  source: string;
  imports: string[];
}

const LIBRARY_SOURCES: LibrarySource[] = [
  { uri: 'dart:core', source: CORE_SOURCE, imports: ['dart:math'] },
  { uri: 'dart:math', source: MATH_SOURCE, imports: [] },
  { uri: 'dart:collection', source: COLLECTION_SOURCE, imports: ['dart:math'] },
  { uri: 'dart:convert', source: CONVERT_SOURCE, imports: [] },
  { uri: 'dart:io', source: IO_SOURCE, imports: [] },
];

/** The libraries a program may import, and why the others are unavailable. */
const UNAVAILABLE_LIBRARIES: Record<string, string> = {
  'dart:async': 'dart:async（非同期処理）',
  'dart:isolate': 'dart:isolate（Isolate）',
  'dart:mirrors': 'dart:mirrors（リフレクション）',
  'dart:ffi': 'dart:ffi（外部の関数の呼び出し）',
  'dart:html': 'dart:html（ブラウザの機能）',
  'dart:js': 'dart:js（JavaScript との連携）',
  'dart:js_interop': 'dart:js_interop（JavaScript との連携）',
  'dart:typed_data': 'dart:typed_data（バイト列）',
  'dart:developer': 'dart:developer（開発者向けの機能）',
  'dart:cli': 'dart:cli（コマンドラインの機能）',
};

interface Libraries {
  libraries: Map<string, LibraryEnv>;
  globals: GlobalVariable[];
}

let loaded: Libraries | undefined;

/** Compiles the interpreter's own libraries once per process; programs share them. */
// code-gauge-allow functionNcss 36 -- The libraries load in their dependency order, each in three phases.
// code-gauge-allow functionCognitiveComplexity 20 -- The libraries load in their dependency order, each in three phases.
export function libraries(): Libraries {
  if (loaded) return loaded;
  const globals: GlobalVariable[] = [];
  const envs = new Map<string, LibraryEnv>();
  const compilers: { compiler: Compiler; syntax: Library; uri: string }[] = [];
  let current = '';
  try {
    for (const { uri, source } of LIBRARY_SOURCES) {
      current = uri;
      const env = new LibraryEnv(uri);
      envs.set(uri, env);
      compilers.push({
        compiler: new Compiler(env, true, undefined, globals, NATIVES),
        syntax: parseDart(source, true),
        uri,
      });
    }
    for (const { uri, imports } of LIBRARY_SOURCES) {
      const env = envs.get(uri) as LibraryEnv;
      if (uri !== 'dart:core') env.addImport(envs.get('dart:core') as LibraryEnv, undefined, undefined, []);
      for (const imported of imports) env.addImport(envs.get(imported) as LibraryEnv, undefined, undefined, []);
    }
    for (const phase of ['declare', 'resolve', 'compile'] as const) {
      if (phase === 'resolve') arrangeVisibility(envs);
      for (const { compiler, syntax, uri } of compilers) {
        current = uri;
        if (phase === 'declare') compiler.declareAll(syntax);
        else if (phase === 'resolve') compiler.resolveAll(syntax);
        else compiler.compileAll(syntax);
      }
    }
  } catch (error) {
    if (error instanceof CompileError) {
      throw new TypeError(`The interpreter's library ${current} failed to compile: ${error.message}`, { cause: error });
    }
    throw error;
  }
  loaded = { libraries: envs, globals };
  return loaded;
}

/** Hides the libraries' internal classes from programs and names the natives' classes as the VM does. */
function arrangeVisibility(envs: ReadonlyMap<string, LibraryEnv>): void {
  const core = envs.get('dart:core') as LibraryEnv;
  assignCoreTypes(core);
  for (const name of [
    'MappedIterable',
    'MappedListIterable',
    'WhereIterable',
    'WhereTypeIterable',
    'ExpandIterable',
    'TakeIterable',
    'TakeWhileIterable',
    'SkipIterable',
    'SkipWhileIterable',
    'FollowedByIterable',
    'CastIterable',
    'IndexedIterable',
    'EfficientLengthIndexedIterable',
    'IndexedIterator',
    'ListIterable',
    'ListIterator',
    'ReversedListIterable',
    'SubListIterable',
    'MappedIterator',
    'WhereIterator',
    'WhereTypeIterator',
    'ExpandIterator',
    'TakeIterator',
    'TakeWhileIterator',
    'SkipIterator',
    'SkipWhileIterator',
    'FollowedByIterator',
    'CastIterator',
    'LateError',
    'CodeUnits',
    'EmptyIterable',
    'replaceListRange',
    'EfficientLengthMappedIterable',
    'EfficientLengthTakeIterable',
    'EfficientLengthSkipIterable',
    'EfficientLengthFollowedByIterable',
    'UnmodifiableMapView',
    'UnmodifiableSetView',
  ]) {
    core.hiddenNames.add(name);
  }
  // The natives' iterators stand for the VM's classes of these names.
  for (const [name, vmName] of [
    ['_ListIterator', 'ListIterator'],
    ['_SetIterator', '_CompactIterator'],
    ['_MapIterator', '_CompactIterator'],
  ]) {
    (core.declarations.get(name) as { cls: { vmName: string | undefined } }).cls.vmName = vmName;
  }
  // The VM's view of List.asMap is internal to the SDK, not part of dart:collection's API.
  for (const name of ['ListMapView', 'CastList', 'CastSet', 'CastMap'])
    (envs.get('dart:collection') as LibraryEnv).hiddenNames.add(name);
  for (const name of ['LinkedHashMap', 'LinkedHashSet']) {
    core.hiddenNames.add(name);
    (envs.get('dart:collection') as LibraryEnv).reexports.set(name, core.declarations.get(name) as never);
  }
}

function assignCoreTypes(core: LibraryEnv): void {
  const classNamed = (name: string): ClassInfo => {
    const declaration = core.declarations.get(name);
    if (declaration?.kind !== 'class') throw new Error(`dart:core has no class ${name}`);
    return declaration.cls;
  };
  Object.assign(coreTypes, {
    object: classNamed('Object'),
    num: classNamed('num'),
    int: classNamed('int'),
    double: classNamed('double'),
    string: classNamed('String'),
    bool: classNamed('bool'),
    list: classNamed('List'),
    map: classNamed('Map'),
    set: classNamed('Set'),
    iterable: classNamed('Iterable'),
    iterator: classNamed('Iterator'),
    function: classNamed('Function'),
    record: classNamed('Record'),
    type: classNamed('Type'),
    symbol: classNamed('Symbol'),
    comparable: classNamed('Comparable'),
    enum: classNamed('Enum'),
    mapEntry: classNamed('MapEntry'),
    nullClass: classNamed('Null'),
    stackTrace: classNamed('StackTrace'),
  });
}

/** Compiles a program against the interpreter's libraries. */
export function compileProgram(syntax: Library, options: { atomicRows?: ReadonlySet<number> } = {}): CompiledProgram {
  const { libraries: envs, globals: libraryGlobals } = libraries();
  const globals = [...libraryGlobals];
  const env = new LibraryEnv('');
  if (!syntax.imports.some(({ uri }) => uri === 'dart:core')) {
    env.addImport(envs.get('dart:core') as LibraryEnv, undefined, undefined, []);
  }
  for (const directive of syntax.imports) {
    const unavailable = UNAVAILABLE_LIBRARIES[directive.uri];
    if (unavailable)
      throw new CompileError([{ row: directive.row, message: `${unavailable}は、この採点環境では使えません。` }]);
    const library = envs.get(directive.uri);
    if (!library)
      throw new CompileError([{ row: directive.row, message: `ライブラリ ${directive.uri} はありません。` }]);
    env.addImport(library, directive.prefix, directive.show, directive.hide);
  }
  const compiler = new Compiler(env, false, options.atomicRows, globals, NATIVES);
  compiler.declareAll(syntax);
  compiler.resolveAll(syntax);
  compiler.compileAll(syntax);
  const mainDeclaration = env.declarations.get('main');
  if (mainDeclaration?.kind !== 'function') {
    throw new CompileError([{ row: 0, message: 'main 関数がありません（void main() { ... } を書いてください）。' }]);
  }
  const main = mainDeclaration.fn;
  checkMain(main);
  validateConstants(compiler, globals);
  return {
    main,
    globals,
    recordFieldNames: compiler.recordFieldNames,
    programGlobals: globals.slice(libraryGlobals.length),
    mainTakesArguments: main.type.positional.length > 0,
  };
}

function validateConstants(compiler: Compiler, globals: GlobalVariable[]): void {
  if (compiler.constantChecks.length === 0) return;
  const runtime = new Runtime();
  runtime.links = LINKS;
  runtime.recordShapes.registerDeclarations(compiler.recordFieldNames);
  runtime.globals = initialGlobals(globals);
  runtime.checkingConstants = true;
  const info: FunctionInfo = {
    name: '<constant>',
    isAtomic: false,
    isLibrary: true,
    locals: [],
    captures: [],
    showsThis: false,
  };
  const frame = new Frame(runtime, info, 0, undefined, [], EMPTY_TYPE_ENV, undefined);
  runtime.enter(frame);
  try {
    for (const { span, run } of compiler.constantChecks) {
      try {
        run(frame);
      } catch (error) {
        if (error instanceof DartThrow || error instanceof ExecutionLimitError)
          compiler.error(span, '定数の式を評価できません。');
        throw error;
      }
    }
  } finally {
    runtime.exit(frame);
  }
}

function checkMain(main: TopLevelFunction): void {
  const { type } = main;
  const row = main.row ?? 0;
  if (type.typeParams.length > 0) throw new CompileError([{ row, message: 'main 関数には型引数を付けられません。' }]);
  if (type.requiredCount > 2 || type.named.some((named) => named.isRequired)) {
    throw new CompileError([{ row, message: 'main 関数の引数は、なしか List<String> の 1 つにしてください。' }]);
  }
  const argumentsType = interfaceType(coreTypes.list, [interfaceType(coreTypes.string)]);
  const first = type.positional[0];
  if (first && first.kind !== 'dynamic' && !isAssignable(argumentsType, first)) {
    throw new CompileError([{ row, message: 'main 関数の引数は、なしか List<String> の 1 つにしてください。' }]);
  }
}

function isAssignable(from: DartType, to: DartType): boolean {
  return import_isSubtype(from, to);
}

// Links from the natives back into the libraries

function findClass(name: string): ClassInfo {
  for (const env of libraries().libraries.values()) {
    const declaration = env.declarations.get(name);
    if (declaration?.kind === 'class') return declaration.cls;
  }
  throw new Error(`No library class ${name}`);
}

const classCache = new Map<string, ClassInfo>();

function classNamed(name: string): ClassInfo {
  let cls = classCache.get(name);
  if (!cls) {
    cls = findClass(name);
    classCache.set(name, cls);
  }
  return cls;
}

export const LINKS: LibraryLinks = {
  addAllToMap,
  quickCopySet,
  classNamed,
  construct(runtime, className, constructorName, args, named, typeArgs) {
    const cls = classNamed(className);
    const constructor = cls.constructors.get(constructorName);
    if (!constructor) throw new Error(`No constructor ${className}.${constructorName}`);
    const namedArgs = named ? new Map(Object.entries(named)) : undefined;
    return instantiateObject(
      runtime,
      cls,
      constructor,
      typeArgs ? [...typeArgs] : cls.typeParams.map(() => DYNAMIC),
      { positional: args, named: namedArgs },
      undefined
    ) as DartObject;
  },
  stringify(runtime, value) {
    return stringOf(runtime, value);
  },
  newList(runtime, elementType, elements, growable, unmodifiable = false) {
    runtime.allocate(elements.length + 1);
    return new DartList(coreTypes.list, elementType, elements, growable, unmodifiable);
  },
  newSet: (runtime, elementType, isConst) => newSet(runtime, elementType, isConst),
  newMap: (runtime, keyType, valueType, isConst) => newMap(runtime, keyType, valueType, isConst),
  canonicalize(runtime, value) {
    const key = constantKey(runtime, value);
    if (key === undefined) return value;
    const existing = runtime.constants.get(key);
    if (existing !== undefined) return existing;
    runtime.constants.set(key, value);
    return value;
  },
  constantIdentityKey,
  syncStarIterable,
  listIterator,
  isValueOf: (runtime, value, type) => valueIs(runtime, value, type),
};

function constantIdentityKey(runtime: Runtime, item: Value): string {
  if (item instanceof DartTypeValue) return JSON.stringify(constantTypeKey(runtime, item.type));
  if (item instanceof DartObject) return `#${item.identity}`;
  if (typeof item === 'string') {
    const { constantStrings } = runtime;
    let id = constantStrings.get(item);
    if (id === undefined) {
      id = constantStrings.size;
      constantStrings.set(item, id);
    }
    return `s${id}`;
  }
  if (typeof item === 'number') return `d${Object.is(item, -0) ? '-0' : item}`;
  return `${typeof item}:${String(item)}`;
}

/** A key that equal constants share, or undefined for values that are canonical already. */
function constantKey(runtime: Runtime, value: Value): string | undefined {
  if (!(value instanceof DartObject)) return undefined;
  if (value instanceof DartTypeValue) return undefined;
  const keyOfValue = (item: Value): string => constantIdentityKey(runtime, item);
  const type = constantTypeKey(runtime, interfaceType(value.cls, value.typeArgs));
  if (value instanceof DartRecord) {
    return JSON.stringify([
      type,
      value.positional.map(keyOfValue),
      value.named.map(([name, field]) => [name, keyOfValue(field)]),
    ]);
  }
  if (value instanceof DartList) return JSON.stringify([type, value.elements.map(keyOfValue)]);
  if (!value.native) return JSON.stringify([type, value.fields.map(keyOfValue)]);
  if ('keys' in value.native) return JSON.stringify([type, Array.from(value.native.values(), keyOfValue)]);
  return undefined;
}

function constantTypeKey(runtime: Runtime, type: DartType): [string, number] {
  const display = vmTypeString(type);
  const collisions = runtime.constantTypes.get(display);
  if (!collisions) {
    runtime.constantTypes.set(display, [type]);
    return [display, 0];
  }
  const index = collisions.findIndex((other) => sameType(type, other));
  if (index !== -1) return [display, index];
  return [display, collisions.push(type) - 1];
}

export type { Runtime };
export { functionType };
