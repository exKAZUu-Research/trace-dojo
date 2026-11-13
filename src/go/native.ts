import type { Entity, FuncEntity, GoPackage } from './entities';
import type { Runtime } from './runtime';
import {
  type FuncType,
  funcType,
  type InterfaceType,
  type Method,
  type NamedType,
  type Type,
  type TypeParamType,
} from './types';
import { GoFunc, type Value } from './values';

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
  return { kind: 'named', name, pkg, underlying: underlyingType, methods: [] };
}

/** Adds a library method to a type; the implementation receives the receiver first. */
export function addMethod(
  type: NamedType,
  name: string,
  signature: FuncType,
  impl: (receiver: Value, args: Value[]) => Value | Value[],
  pointerReceiver = false
): Method {
  const method: Method = { name, pointerReceiver, type: signature, code: { call: impl as never } };
  type.methods.push(method);
  return method;
}

export function nativeFunction(name: string, signature: FuncType, impl: NativeImpl): FuncEntity {
  const value = new GoFunc((args) => impl(args));
  return { kind: 'func', name, type: signature, value: () => value, direct: (args) => impl(args) };
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
        return new GoFunc((values) => run(values));
      },
    },
    value: () => new GoFunc(() => {}),
  };
}
