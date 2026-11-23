import type { ClassInfo, ConstructorImpl, ConstructorInfo } from './classes';
import type { GlobalVariable, TopLevelFunction } from './environment';
import { eraseFunctionType } from './eraseExtensionTypes';
import { initializeField } from './lateFields';
import { isPrimitive } from './primitives';
import type { Runtime } from './runtime';
import { coreTypes, type DartType, isNullable } from './types';
import { type Arguments, type Callable, Cell, DartClosure, DartObject, UNINITIALIZED, type Value } from './values';

export function topLevelFunctionClosure(runtime: Runtime, fn: TopLevelFunction): DartClosure {
  const { tearOffs } = runtime;
  const existing = tearOffs.get(fn);
  if (existing) return existing;
  const closure = new DartClosure(
    coreTypes.function,
    eraseFunctionType(fn.type),
    (callingRuntime, _receiver, args, typeArgs, callRow) =>
      (fn.impl as Callable)(callingRuntime, undefined, args, typeArgs, callRow),
    undefined,
    [],
    { name: fn.name, origin: `Function '${fn.name}': static.` },
    fn
  );
  tearOffs.set(fn, closure);
  return closure;
}

/**
 * An `external` member of the program, which the SDK compiles but which has no body, so calling it throws the
 * NoSuchMethodError the VM throws.
 */
export function missingExternal(key: string, kind: 'method' | 'getter' | 'setter'): Callable {
  const dot = key.indexOf('.');
  const owner = dot === -1 ? undefined : key.slice(0, dot);
  const name = key.slice(dot + 1);
  return (runtime, _receiver, args, typeArgs) => runtime.throwMissingExternal(owner, name, kind, args, typeArgs);
}

/**
 * The fields of a new object: a nullable field without an initializer starts as null, and the others are unset until
 * their initializers run, which traces show by leaving them out.
 */
export function newFields(cls: ClassInfo): Value[] {
  const fields: Value[] = Array.from({ length: cls.fieldCount }, () => UNINITIALIZED);
  for (const current of cls.superclassChain()) {
    for (const field of current.fields) {
      if (!field.isLate && !field.hasInitializer && isNullable(field.type)) fields[field.slot] = undefined;
    }
  }
  return fields;
}

/** Creates an object with a constructor: allocates it for a generative one, or lets a factory make it. */
export function instantiateObject(
  runtime: Runtime,
  cls: ClassInfo,
  constructor: ConstructorInfo,
  typeArgs: readonly DartType[],
  args: Arguments,
  callRow: number | undefined
): Value {
  const impl = constructor.impl as ConstructorImpl;
  if (constructor.kind !== 'generative') return impl(runtime, undefined, args, typeArgs, callRow);
  runtime.allocate(cls.fieldCount + 1);
  const object = new DartObject(cls, typeArgs, newFields(cls));
  impl(runtime, object, args, typeArgs, callRow);
  // An extension type's value is its representation, which its constructor stores in the object's only field.
  if (cls.kind === 'extensionType') return object.fields[0];
  return object;
}

/** Reads a global, initializing it on first use as Dart does for top-level variables and static fields. */
export function readGlobalValue(runtime: Runtime, global: GlobalVariable): Value {
  const cell = runtime.globals[global.slot];
  if (cell.v !== UNINITIALIZED) return cell.v;
  const { initialize, name } = global;
  if (!initialize) runtime.throwError('LateError', '', [`Field '${name}' has not been initialized.`]);
  return initializeField(
    runtime,
    name,
    global.isFinal,
    () => initialize(runtime),
    () => cell.v,
    (computed) => {
      cell.v = computed;
    }
  );
}

/** Creates the cells of the globals for a run, with the values known before it starts. */
export function initialGlobals(globals: GlobalVariable[]): Cell[] {
  return globals.map(
    (global) =>
      new Cell(
        global.initialValue && (global.isConst || !global.initialize || isPrimitive(global.initialValue.value))
          ? global.initialValue.value
          : UNINITIALIZED
      )
  );
}
