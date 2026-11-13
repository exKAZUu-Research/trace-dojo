import {
  asSuper,
  bindingsOf,
  type ClassInfo,
  type ClassType,
  type JavaType,
  type MethodInfo,
  sameErasure,
  substitute,
  superinterfacesOf,
  type TypeVariable,
} from './types';

/**
 * The single abstract method of a functional interface, or `undefined` when `cls` is not one: the abstract methods it
 * declares and inherits, counted once per override-equivalent signature as `cls` sees them through its parameterized
 * superinterfaces, less those that redeclare a public method of `Object` and those a default method of a more specific
 * interface implements (JLS 9.8).
 */
// code-gauge-allow functionCognitiveComplexity 18 -- One pass applying JLS 9.8's three exclusions to each inherited method.
export function functionalMethodOf(cls: ClassInfo, objectClass: ClassInfo): MethodInfo | undefined {
  if (cls.kind !== 'interface') return;
  const owners = [cls, ...superinterfacesOf(cls)];
  const self: ClassType = {
    kind: 'class',
    cls,
    args: cls.typeParameters.map((variable): JavaType => ({ kind: 'typeVar', variable })),
  };
  const viewed = (owner: ClassInfo, method: MethodInfo): Signature => {
    const supertype = asSuper(self, owner);
    const bindings = supertype ? bindingsOf(supertype) : new Map<TypeVariable, JavaType>();
    return { method, parameterTypes: method.parameterTypes.map((type) => substitute(type, bindings)) };
  };
  const implementsByDefault = (other: ClassInfo, signature: Signature): boolean =>
    other.methods.some((candidate) => !candidate.isAbstract && sameSignature(viewed(other, candidate), signature));
  const abstract: Signature[] = [];
  for (const owner of owners) {
    for (const method of owner.methods) {
      if (!method.isAbstract || method.isStatic) continue;
      const signature = viewed(owner, method);
      const isObjectMethod = objectClass.methods.some(
        (other) =>
          other.access === 'public' &&
          !other.isStatic &&
          sameSignature({ method: other, parameterTypes: other.parameterTypes }, signature)
      );
      const isImplemented = owners.some(
        (other) => other !== owner && superinterfacesOf(other).includes(owner) && implementsByDefault(other, signature)
      );
      const isCounted = abstract.some((other) => sameSignature(other, signature));
      if (!isObjectMethod && !isImplemented && !isCounted) abstract.push(signature);
    }
  }
  return abstract.length === 1 ? abstract[0]?.method : undefined;
}

/** A method with its parameter types as an interface sees them through its parameterized superinterfaces. */
interface Signature {
  method: MethodInfo;
  parameterTypes: readonly JavaType[];
}

/** Whether two methods have override-equivalent signatures, by an override the compiler linked or by erasure. */
function sameSignature(a: Signature, b: Signature): boolean {
  if (a.method.name !== b.method.name) return false;
  if (a.method.overrides?.has(b.method) || b.method.overrides?.has(a.method)) return true;
  return (
    a.parameterTypes.length === b.parameterTypes.length &&
    a.parameterTypes.every((type, index) => sameErasure(type, b.parameterTypes[index] as JavaType))
  );
}
