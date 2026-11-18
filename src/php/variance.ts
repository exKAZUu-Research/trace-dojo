import { lower } from './bytes';
import { rt } from './runtime';
import { typeToString } from './types';
import type { PhpClass, TypeDecl } from './values';

const BUILTIN = new Set([
  'int',
  'float',
  'string',
  'bool',
  'true',
  'false',
  'null',
  'void',
  'never',
  'mixed',
  'array',
  'iterable',
  'object',
  'callable',
]);

/**
 * Whether every value of `sub` (declared in the child) is a value of `sup` (declared in the parent), as PHP checks the
 * return types of an overriding method; parameter types are checked with the two swapped.
 */
export function isSubtype(
  sub: TypeDecl,
  subScope: PhpClass | undefined,
  sup: TypeDecl,
  supScope: PhpClass | undefined,
  allowUnresolved = false
): boolean {
  if (sub.k === 'named' && lower(sub.name) === 'iterable')
    return isSubtype(expandIterable(sub.nullable), subScope, sup, supScope, allowUnresolved);
  if (sup.k === 'named' && lower(sup.name) === 'iterable')
    return isSubtype(sub, subScope, expandIterable(sup.nullable), supScope, allowUnresolved);
  if (sub.k === 'union') return sub.types.every((part) => isSubtype(part, subScope, sup, supScope, allowUnresolved));
  if (sub.k === 'named' && sub.nullable) {
    return (
      isSubtype({ k: 'named', name: 'null' }, subScope, sup, supScope, allowUnresolved) &&
      isSubtype({ k: 'named', name: sub.name }, subScope, sup, supScope, allowUnresolved)
    );
  }
  if (sup.k === 'union') return sup.types.some((part) => isSubtype(sub, subScope, part, supScope, allowUnresolved));
  if (sup.k === 'named' && sup.nullable) {
    return (
      isSubtype(sub, subScope, { k: 'named', name: 'null' }, supScope, allowUnresolved) ||
      isSubtype(sub, subScope, { k: 'named', name: sup.name }, supScope, allowUnresolved)
    );
  }
  if (sup.k === 'inter') return sup.types.every((part) => isSubtype(sub, subScope, part, supScope, allowUnresolved));
  if (sub.k === 'inter') return sub.types.some((part) => isSubtype(part, subScope, sup, supScope, allowUnresolved));
  return namedSubtype(lower(sub.name), subScope, lower(sup.name), supScope, allowUnresolved);
}

function expandIterable(nullable: boolean | undefined): TypeDecl {
  const types: TypeDecl[] = [
    { k: 'named', name: 'array' },
    { k: 'named', name: 'Traversable' },
  ];
  if (nullable) types.push({ k: 'named', name: 'null' });
  return { k: 'union', types };
}

// code-gauge-allow functionCognitiveComplexity 21 -- One case per builtin type, as PHP relates each to the others.
function namedSubtype(
  sub: string,
  subScope: PhpClass | undefined,
  sup: string,
  supScope: PhpClass | undefined,
  allowUnresolved = false
): boolean {
  if (sup === 'mixed') return sub !== 'void';
  if (sub === 'never') return true;
  if (sub === 'static') return sup === 'static' || namedSubtype('self', subScope, sup, supScope, allowUnresolved);
  if (sup === 'static') return false;
  if ((sub === 'true' || sub === 'false') && (sup === 'bool' || sup === sub)) return true;
  if (BUILTIN.has(sub) || BUILTIN.has(sup)) {
    if (sub === sup) return true;
    if (sup === 'object') return !BUILTIN.has(sub);
    if (sup === 'callable') return sub === 'closure';
    return false;
  }
  return isClassSubtype(sub, subScope, sup, supScope, allowUnresolved);
}

function isClassSubtype(
  sub: string,
  subScope: PhpClass | undefined,
  sup: string,
  supScope: PhpClass | undefined,
  allowUnresolved = false
): boolean {
  const subClass = resolve(sub, subScope);
  const supClass = resolve(sup, supScope);
  if (subClass && supClass) return subClass.isSubclassOf(supClass);
  if (allowUnresolved) return true;
  return (subClass ? lower(subClass.name) : sub) === (supClass ? lower(supClass.name) : sup);
}

function resolve(name: string, scope: PhpClass | undefined): PhpClass | undefined {
  if (!scope) return undefined;
  // The class being declared is not registered yet while PHP checks its methods.
  if (name === 'self' || name === lower(scope.name)) return scope;
  if (name === 'parent') return scope.parent;
  return rt().classes.get(name);
}

export function sameDeclarationType(
  left: TypeDecl,
  leftScope: PhpClass,
  right: TypeDecl,
  rightScope: PhpClass
): boolean {
  left = declarationType(left, leftScope);
  right = declarationType(right, rightScope);
  if (lower(typeToString(left)) === lower(typeToString(right))) return true;
  return isSubtype(left, leftScope, right, rightScope) && isSubtype(right, rightScope, left, leftScope);
}

function declarationType(type: TypeDecl, scope: PhpClass): TypeDecl {
  if (type.k !== 'named') return { ...type, types: type.types.map((part) => declarationType(part, scope)) };
  if (scope.kind === 'trait') return type;
  const word = lower(type.name);
  const cls = word === 'self' ? scope : word === 'parent' ? scope.parent : undefined;
  return cls ? { ...type, name: cls.name } : type;
}
