import type { Builtins } from './builtins';
import { type ClassInfo, erasure, type JavaType, type MethodInfo } from './types';

/**
 * What a value that turns out null came from, which the messages of `NullPointerException` name as the JDK's
 * helpful messages (JEP 358) do: a variable, field, or array element by its `path`, or a method's return value.
 */
export type NullSource = { path: string } | { returnOf: string };

export function nullMessage(action: string, source: NullSource | undefined): string {
  if (!source) return action;
  return 'path' in source
    ? `${action} because "${source.path}" is null`
    : `${action} because the return value of "${source.returnOf}" is null`;
}

/** The source of `object.name`, which names only the field when `object` has no path. */
export function fieldSource(object: NullSource | undefined, name: string): NullSource {
  return { path: object && 'path' in object ? `${object.path}.${name}` : name };
}

/** The source of `array[index]`, whose index the JDK names only when it is a variable or a constant. */
export function elementSource(array: NullSource | undefined, index: string | undefined): NullSource | undefined {
  if (!array || !('path' in array)) return;
  return { path: `${array.path}[${index ?? '...'}]` };
}

/** How the JDK names a method in its messages, such as `java.util.List.add(Object)`. */
export function methodDescription(builtins: Builtins, owner: JavaType, method: MethodInfo): string {
  const parameters = (method.declared ?? method).parameterTypes.map((type) => typeDescription(builtins, type));
  return `${typeDescription(builtins, owner)}.${method.name}(${parameters.join(', ')})`;
}

/** The kind of array the JDK names in its messages, as its bytecode instructions distinguish them. */
export function arrayKindOf(element: JavaType): string {
  if (element.kind === 'boolean' || element.kind === 'byte') return 'byte/boolean';
  return element.kind === 'class' || element.kind === 'array' || element.kind === 'typeVar' ? 'object' : element.kind;
}

export function typeDescription(builtins: Builtins, type: JavaType): string {
  const erased = erasure(type);
  if (erased.kind === 'array') return `${typeDescription(builtins, erased.element)}[]`;
  if (erased.kind !== 'class') return erased.kind;
  return classDescription(builtins, erased.cls);
}

function classDescription(builtins: Builtins, cls: ClassInfo): string {
  if (cls === builtins.objectClass || cls === builtins.stringClass) return cls.name;
  return builtins.qualifiedNames.get(cls) ?? cls.binaryName;
}
