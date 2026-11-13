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

/** The single abstract method of a functional interface, or `undefined` when `cls` is not one. */
export function functionalMethodOf(cls: ClassInfo, objectClass: ClassInfo): MethodInfo | undefined {
  return functionalMethodsOf(cls, objectClass)?.[0];
}

/**
 * The abstract methods a functional interface declares and inherits that share its one override-equivalent signature
 * as `cls` sees them through its parameterized superinterfaces, the first of them its functional method, which a
 * lambda implements them all by; or `undefined` when `cls` is not one. Methods that redeclare a public method of
 * `Object` and those a default method of a more specific interface implements do not count (JLS 9.8).
 */
// code-gauge-allow functionCognitiveComplexity 21 -- One pass applying JLS 9.8's three exclusions to each inherited method.
export function functionalMethodsOf(cls: ClassInfo, objectClass: ClassInfo): MethodInfo[] | undefined {
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
  const family: MethodInfo[] = [];
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
      if (isObjectMethod || isImplemented) continue;
      if (!abstract.some((other) => sameSignature(other, signature))) abstract.push(signature);
      family.push(method);
    }
  }
  return abstract.length === 1 ? family : undefined;
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
