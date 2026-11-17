import { lower } from './bytes';
import { rt } from './runtime';
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
export function isSubtype(sub: TypeDecl, subScope: PhpClass, sup: TypeDecl, supScope: PhpClass): boolean {
  if (sub.k === 'union') return sub.types.every((part) => isSubtype(part, subScope, sup, supScope));
  if (sub.k === 'named' && sub.nullable) {
    return (
      isSubtype({ k: 'named', name: 'null' }, subScope, sup, supScope) &&
      isSubtype({ k: 'named', name: sub.name }, subScope, sup, supScope)
    );
  }
  if (sup.k === 'union') return sup.types.some((part) => isSubtype(sub, subScope, part, supScope));
  if (sup.k === 'named' && sup.nullable) {
    return (
      isSubtype(sub, subScope, { k: 'named', name: 'null' }, supScope) ||
      isSubtype(sub, subScope, { k: 'named', name: sup.name }, supScope)
    );
  }
  if (sup.k === 'inter') return sup.types.every((part) => isSubtype(sub, subScope, part, supScope));
  if (sub.k === 'inter') return sub.types.some((part) => isSubtype(part, subScope, sup, supScope));
  return namedSubtype(lower(sub.name), subScope, lower(sup.name), supScope);
}

// code-gauge-allow functionCognitiveComplexity 21 -- One case per builtin type, as PHP relates each to the others.
function namedSubtype(sub: string, subScope: PhpClass, sup: string, supScope: PhpClass): boolean {
  if (sup === 'mixed') return sub !== 'void';
  if (sub === 'never') return true;
  if (sub === 'static') return sup === 'static' || namedSubtype('self', subScope, sup, supScope);
  if (sup === 'static') return false;
  if ((sub === 'true' || sub === 'false') && (sup === 'bool' || sup === sub)) return true;
  if (sub === 'iterable') return sup === 'iterable';
  if (sup === 'iterable') {
    return sub === 'array' || sub === 'iterable' || isClassSubtype(sub, subScope, 'traversable', supScope);
  }
  if (BUILTIN.has(sub) || BUILTIN.has(sup)) {
    if (sub === sup) return true;
    if (sup === 'object') return !BUILTIN.has(sub);
    if (sup === 'callable') return sub === 'closure';
    return false;
  }
  return isClassSubtype(sub, subScope, sup, supScope);
}

/** Whether the class `sub` names is `sup` or extends or implements it; unknown classes compare by name. */
function isClassSubtype(sub: string, subScope: PhpClass, sup: string, supScope: PhpClass): boolean {
  const subClass = resolve(sub, subScope);
  const supClass = resolve(sup, supScope);
  if (subClass && supClass) return subClass.isSubclassOf(supClass);
  return (subClass ? lower(subClass.name) : sub) === (supClass ? lower(supClass.name) : sup);
}

function resolve(name: string, scope: PhpClass): PhpClass | undefined {
  // The class being declared is not registered yet while PHP checks its methods.
  if (name === 'self' || name === lower(scope.name)) return scope;
  if (name === 'parent') return scope.parent;
  return rt().classes.get(name);
}
