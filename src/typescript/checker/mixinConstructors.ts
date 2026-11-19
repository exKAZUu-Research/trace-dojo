import type { Checker } from './checker';
import { intersectionOf, isAnyLike, type Signature, type Type } from './types';

/** A mixin's instance type joins each concrete constructor's return type, which keeps its parameters. */
export function intersectConstructSignatures(c: Checker, groups: Signature[][]): Signature[] {
  const constructors = groups.filter((group) => group.length > 0);
  if (constructors.length < 2) return constructors.flat();
  const mixins = constructors.map((group) => (isMixinConstructor(c, group) ? group[0] : undefined));
  if (mixins.every(Boolean)) mixins[0] = undefined;
  if (!mixins.some(Boolean)) return constructors.flat();
  return constructors.flatMap((group, index) =>
    mixins[index] ? [] : group.map((signature) => mixedConstructor(c, mixins, index, signature))
  );
}

export function isMixinConstructor(c: Checker, signatures: Signature[]): boolean {
  if (signatures.length !== 1) return false;
  const { parameters, typeParameters } = signatures[0];
  if (typeParameters.length > 0 || parameters.length !== 1 || !parameters[0].rest) return false;
  const { type } = parameters[0];
  return (
    isAnyLike(type) ||
    (type.kind === 'object' && (c.isArrayType(type) || c.isReadonlyArrayType(type)) && isAnyLike(c.elementTypeOf(type)))
  );
}

export function isBaseTypeVariable(type: Type): boolean {
  return type.kind === 'typeParameter' || type.kind === 'indexedAccess';
}

function mixedConstructor(
  c: Checker,
  mixins: (Signature | undefined)[],
  index: number,
  signature: Signature
): Signature {
  const components = mixins.with(index, signature).filter((component) => component !== undefined);
  let returnType: Type | undefined;
  return {
    ...signature,
    returnType: () =>
      (returnType ??= intersectionOf(
        components.map((component) => component.returnType()),
        c.budget
      )),
  };
}
