import { addInterface, addMethod, addTypeParameters, type Registry } from './builtinSupport';
import { type Wrappers } from './builtinWrappers';
import { throwBuiltin } from './runtime';
import { type ClassInfo, INT, type JavaType, type TypeVariable } from './types';
import { JavaObject, JavaString, type Value } from './values';

/**
 * Makes `Enum` the `Enum<E extends Enum<E>>` that implements `Comparable<E>`, so that bounds such as `<E extends
 * Enum<E>>` are written as in Java and compare their values by ordinal.
 */
export function makeEnumGeneric(
  registry: Registry,
  enumClass: ClassInfo,
  wrappers: Wrappers,
  stringType: JavaType
): void {
  const [element] = addTypeParameters(enumClass, ['E'], enumClass.type);
  addInterface(enumClass, { kind: 'class', cls: wrappers.comparableClass, args: [element] });
  const compareTo = addMethod(enumClass, 'compareTo', [element], INT, false, (frame, receiver, [other]) => {
    if (!(other instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
    return ordinalOf(receiver) - ordinalOf(other);
  });
  compareTo.overrides = new Set([wrappers.compareTo]);
  compareTo.isFinal = true;
  const classClass = registry.classes.get('Class') as ClassInfo;
  const t: TypeVariable = { name: 'T', bounds: [] };
  const tType: JavaType = { kind: 'typeVar', variable: t };
  t.bounds = [{ kind: 'class', cls: enumClass, args: [tType] }];
  const valueOf = addMethod(
    enumClass,
    'valueOf',
    [{ kind: 'class', cls: classClass, args: [tType] }, stringType],
    tType,
    true,
    (frame, _, [type, name]) => {
      const cls = (type as JavaObject | undefined)?.reflected;
      if (!cls || !(name instanceof JavaString)) return throwBuiltin(frame, 'NullPointerException', 'Name is null');
      if (cls.kind !== 'enum')
        return throwBuiltin(frame, 'IllegalArgumentException', `${cls.binaryName} is not an enum class`);
      const field = cls.staticFields.find((candidate) => candidate.enumConstant && candidate.name === name.value);
      if (!field) {
        const qualified = cls.binaryName.replaceAll('$', '.');
        return throwBuiltin(frame, 'IllegalArgumentException', `No enum constant ${qualified}.${name.value}`);
      }
      return frame.runtime.staticsOf(frame, cls)[field.slot];
    }
  );
  valueOf.typeParameters = [t];
}

function ordinalOf(value: Value): number {
  return (value as JavaObject).enumConstant?.ordinal ?? 0;
}
