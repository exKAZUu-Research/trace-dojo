import type { Core } from './compilerBase';
import { runtimeClassOf } from './dispatch';
import type { Frame } from './runtime';
import type { ClassSymbol } from './symbols';
import { type KType, resolved } from './types';
import { KObject, type Value } from './values';

/** A test of whether a value is an instance of a type, as `is` checks it with type arguments erased. */
// code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
export function instanceTest(core: Core, type: KType): (value: Value) => boolean {
  const actual = resolved(type);
  const acceptsNull = actual.nullable;
  switch (actual.kind) {
    case 'nothing': {
      return (value) => value === undefined && acceptsNull;
    }
    case 'function': {
      const arity = actual.params.length + (actual.receiver ? 1 : 0);
      return (value) =>
        value === undefined ? acceptsNull : value instanceof KObject && value.function?.arity === arity;
    }
    case 'class': {
      const target = actual.cls;
      if (target === core.any) return (value) => value !== undefined || acceptsNull;
      if (target === core.function)
        return (value) =>
          value === undefined ? acceptsNull : value instanceof KObject && value.function !== undefined;
      const checksMutability = isMutableCollectionType(target);
      return (value) => {
        if (value === undefined) return acceptsNull;
        if (checksMutability && value instanceof KObject && value.readOnlyCollection) return false;
        return runtimeClassOf(value).isSubclassOf(target);
      };
    }
    default: {
      // A type parameter's type is erased; only its bound can be checked, which the checker allows for reified ones.
      return (value) => value !== undefined || acceptsNull;
    }
  }
}

function isMutableCollectionType(cls: ClassSymbol): boolean {
  return cls.isLibrary && cls.kotlinName.startsWith('kotlin.collections.Mutable');
}

/** The binary names of the JDK's classes, which a `ClassCastException` names; arrays, as `[I`, are the JDK's too. */
const JAVA_BASE_PREFIXES = ['java.', '['];

function moduleOf(cls: ClassSymbol): string {
  return JAVA_BASE_PREFIXES.some((prefix) => cls.qualifiedName.startsWith(prefix))
    ? "module java.base of loader 'bootstrap'"
    : "unnamed module of loader 'app'";
}

/** The message of the `ClassCastException` that casting `value` to `target` throws, as the JVM words it. */
export function castFailureMessage(value: Value, target: ClassSymbol): string {
  const source = runtimeClassOf(value);
  if (value instanceof KObject && value.readOnlyCollection && isMutableCollectionType(target)) {
    return `${source.qualifiedName} cannot be cast to ${target.kotlinName}`;
  }
  const sourceModule = moduleOf(source);
  const targetModule = moduleOf(target);
  const where =
    sourceModule === targetModule
      ? `${source.qualifiedName} and ${target.qualifiedName} are in ${sourceModule}`
      : `${source.qualifiedName} is in ${sourceModule}; ${target.qualifiedName} is in ${targetModule}`;
  return `class ${source.qualifiedName} cannot be cast to class ${target.qualifiedName} (${where})`;
}

export function throwCastFailure(frame: Frame, value: Value, type: KType): never {
  const actual = resolved(type);
  if (value === undefined) {
    return frame.runtime.throwError(
      frame,
      'java.lang.NullPointerException',
      `null cannot be cast to non-null type ${kotlinTypeName(actual)}`
    );
  }
  const target = actual.kind === 'class' ? actual.cls : runtimeClassOf(undefined);
  return frame.runtime.throwError(frame, 'java.lang.ClassCastException', castFailureMessage(value, target));
}

/** A type's name as Kotlin's runtime names it in messages, such as `kotlin.String`. */
function kotlinTypeName(type: KType): string {
  if (type.kind === 'class') return type.cls.kotlinName;
  return 'kotlin.Any';
}

/**
 * Reads a local that a smart cast narrowed, which a write inside the expression that tested it may have changed since;
 * a value no longer of the narrowed type throws as a failed cast does, instead of flowing on as that type.
 */
export function checkedRead(core: Core, read: (frame: Frame) => Value, narrowed: KType): (frame: Frame) => Value {
  if (resolved(narrowed).kind !== 'class') return read;
  const test = instanceTest(core, narrowed);
  return (frame) => {
    const value = read(frame);
    if (!test(value)) throwCastFailure(frame, value, narrowed);
    return value;
  };
}
