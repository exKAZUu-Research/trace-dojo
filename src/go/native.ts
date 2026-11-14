import type { Entity, FuncEntity, GoPackage, VarEntity } from './entities';
import { containsTypeParam } from './generics';
import { type Runtime, runToEnd, type Suspending } from './runtime';
import {
  CONSTRAINT_NAMES,
  type FuncType,
  funcType,
  type InterfaceType,
  type Method,
  type NamedType,
  type Type,
  typeIdentityKey,
  type TypeParamType,
} from './types';
import { Cell, GoFunc, type Value } from './values';

let running: Runtime | undefined;

/** The runtime of the program being run, which library functions use for output, panics, and callbacks. */
export function currentRuntime(): Runtime {
  if (!running) throw new Error('No Go program is running');
  return running;
}

const perRunValues = new WeakMap<Runtime, Map<object, unknown>>();

/** A library value that each run creates on first use, since a program may change it and runs must not share it. */
export function perRun<T>(create: () => T): () => T {
  const key = {};
  return () => {
    const runtime = currentRuntime();
    let values = perRunValues.get(runtime);
    if (!values) {
      values = new Map();
      perRunValues.set(runtime, values);
    }
    if (!values.has(key)) values.set(key, create());
    return values.get(key) as T;
  };
}

const libraryCells = new WeakMap<Runtime, Map<VarEntity, Cell>>();

/** The storage of a library variable in the running program, which assignments to the variable change. */
export function libraryCell(entity: VarEntity): Cell {
  const runtime = currentRuntime();
  let cells = libraryCells.get(runtime);
  if (!cells) {
    cells = new Map();
    libraryCells.set(runtime, cells);
  }
  let cell = cells.get(entity);
  if (!cell) {
    cell = new Cell((entity.library as () => Value)());
    cells.set(entity, cell);
  }
  return cell;
}

export function withRuntime<T>(runtime: Runtime, run: () => T): T {
  const previous = running;
  running = runtime;
  try {
    return run();
  } finally {
    running = previous;
  }
}

export type NativeImpl = (args: Value[]) => Value | Value[];

const opaqueTypes = new WeakSet<Type>();

/** Marks a library type whose fields are implementation details, which the trace does not show. */
export function opaqueType(type: NamedType): NamedType {
  opaqueTypes.add(type);
  return type;
}

export function isOpaque(type: Type): boolean {
  return opaqueTypes.has(type);
}

export function namedType(pkg: string, name: string, underlyingType: Type): NamedType {
  const type: NamedType = { kind: 'named', name, pkg, underlying: underlyingType, methods: [] };
  if (underlyingType.kind === 'interface') CONSTRAINT_NAMES.set(underlyingType, type);
  return type;
}

export function nativeFunc(call: GoFunc['call'], captured: readonly unknown[] = [], resume?: GoFunc['resume']): GoFunc {
  return new GoFunc(
    (args, row, deferredFor, stackBuffers) =>
      currentRuntime().withRoots([captured, args], () => call(args, row, deferredFor, stackBuffers)),
    captured,
    resume &&
      ((args, row, deferredFor, stackBuffers) =>
        currentRuntime().resumeWithRoots([captured, args], resume(args, row, deferredFor, stackBuffers)))
  );
}

/** Adds a library method to a type; the implementation receives the receiver first. */
export function addMethod(
  type: NamedType,
  name: string,
  signature: FuncType,
  impl: (receiver: Value, args: Value[]) => Value | Value[],
  pointerReceiver = false
): Method {
  const method: Method = {
    name,
    pointerReceiver,
    type: signature,
    code: {
      call: ((receiver: Value, args: Value[]) =>
        currentRuntime().withRoots([receiver, args], () => impl(receiver, args))) as never,
    },
  };
  type.methods.push(method);
  return method;
}

/** A library method that may block its goroutine, such as `(*sync.WaitGroup).Wait`. */
export function addBlockingMethod(
  type: NamedType,
  name: string,
  signature: FuncType,
  // oxlint-disable-next-line typescript/no-invalid-void-type -- A generator that ends with a bare return returns void.
  resume: (receiver: Value, args: Value[]) => Suspending<Value | Value[] | void>,
  pointerReceiver = true
): Method {
  const method = addMethod(
    type,
    name,
    signature,
    (receiver, args) => runToEnd(resume(receiver, args)) as Value | Value[],
    pointerReceiver
  );
  (method.code as NonNullable<Method['code']>).resume = ((receiver: Value, args: Value[]) =>
    currentRuntime().resumeWithRoots([receiver, args], resume(receiver, args))) as never;
  return method;
}

/** A library function that may block its goroutine, such as `time.Sleep`. */
export function blockingFunction(
  name: string,
  signature: FuncType,
  // oxlint-disable-next-line typescript/no-invalid-void-type -- A generator that ends with a bare return returns void.
  resume: (args: Value[]) => Suspending<Value | Value[] | void>
): FuncEntity {
  const call = (args: Value[]): Value | Value[] => runToEnd(resume(args)) as Value | Value[];
  const value = nativeFunc(call, [], (args) => resume(args) as Suspending<Value | Value[]>);
  return {
    kind: 'func',
    name,
    type: signature,
    value: () => value,
    direct: value.call,
    directResume: (args) => (value.resume as NonNullable<GoFunc['resume']>)(args),
  };
}

export function nativeFunction(name: string, signature: FuncType, impl: NativeImpl): FuncEntity {
  const value = nativeFunc((args) => impl(args));
  return { kind: 'func', name, type: signature, value: () => value, direct: value.call };
}

/** Builds a package from its members. */
export function definePackage(path: string, members: Record<string, Entity>, unsupported: string[] = []): GoPackage {
  return {
    path,
    name: path.split('/').at(-1) === 'v2' ? (path.split('/').at(-2) as string) : (path.split('/').at(-1) as string),
    members: new Map(Object.entries(members)),
    unsupported: new Set(unsupported),
  };
}

export function fn(params: Type[], results: Type[], variadic = false): FuncType {
  return funcType(params, results, variadic);
}

/**
 * A generic library type, such as `iter.Seq[V]`: its entity, and its instances, one per list of type arguments, whose
 * underlying types `underlyingOf` gives.
 */
export function genericNamedType(
  pkg: string,
  name: string,
  typeParams: TypeParamType[],
  underlyingOf: (args: Type[]) => Type
): { entity: Entity; instance: (args: Type[]) => NamedType } {
  const shell: NamedType = { kind: 'named', name, pkg, underlying: underlyingOf(typeParams), methods: [], typeParams };
  const cache = new Map<string, NamedType>();
  const instance = (args: Type[]): NamedType => {
    const make = (): NamedType => ({
      kind: 'named',
      name,
      pkg,
      underlying: underlyingOf(args),
      methods: [],
      typeArgs: args,
      origin: shell,
    });
    // Instances over type parameters stay apart, as parameters of the same name may differ.
    if (args.some((arg) => containsTypeParam(arg))) return make();
    const key = args.map((arg) => typeIdentityKey(arg)).join(',');
    let found = cache.get(key);
    if (!found) {
      found = make();
      cache.set(key, found);
    }
    return found;
  };
  shell.instantiateLibrary = instance;
  return { entity: { kind: 'type', name, type: shell, generic: { typeParams, instantiate: instance } }, instance };
}

export function typeEntity(type: NamedType): Entity {
  return { kind: 'type', name: type.name, type };
}

let nextLibraryTypeParam = -1;

/** A type parameter of a generic library function, with ids apart from the program's. */
export function typeParam(name: string, constraint: InterfaceType): TypeParamType {
  return { kind: 'typeParam', name, constraint, id: nextLibraryTypeParam-- };
}

/** A generic library function, whose implementation receives the type arguments of each instance. */
export function genericFunction(
  name: string,
  typeParams: TypeParamType[],
  signature: FuncType,
  impl: (typeArgs: Type[]) => NativeImpl
): FuncEntity {
  return {
    kind: 'func',
    name,
    type: signature,
    generic: {
      typeParams,
      type: signature,
      instantiate: (args) => {
        const run = impl(args);
        return nativeFunc((values) => run(values));
      },
    },
    value: () => new GoFunc(() => {}),
  };
}
