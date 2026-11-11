import { classOf } from './types';
import { PyClass, type PyValue } from './values';

/** The attributes of classes, keyed by `module.name`, that this grader does not support, with the feature to name. */
const byClass = new Map<string, Record<string, string>>();

/**
 * Names attributes that the instances of a builtin or library class (`module.name`, such as `builtins.list_iterator`)
 * have in CPython and this grader does not support, which raise the unsupported error instead of AttributeError.
 */
export function registerUnsupportedClassAttributes(qualifiedName: string, attributes: Record<string, string>): void {
  byClass.set(qualifiedName, { ...byClass.get(qualifiedName), ...attributes });
}

/** The feature to name for an attribute of `value` that this grader does not support, or undefined. */
export function unsupportedClassAttribute(value: PyValue, name: string): string | undefined {
  for (const cls of classesOf(value)) {
    const feature = byClass.get(`${cls.module}.${cls.name}`)?.[name];
    if (feature !== undefined) return feature;
  }
  return undefined;
}

/** The names of the attributes of `value` that this grader does not support, which `dir()` lists as CPython's does. */
export function unsupportedClassAttributeNames(value: PyValue): string[] {
  const classes = value instanceof PyClass ? value.mro : classOf(value).mro;
  return classes.flatMap((cls) => Object.keys(byClass.get(`${cls.module}.${cls.name}`) ?? {}));
}

/** The classes whose attributes `value` has: its class's MRO, or for a class, its own MRO and its metaclass's. */
function classesOf(value: PyValue): readonly PyClass[] {
  if (byClass.size === 0) return [];
  return value instanceof PyClass ? [...value.mro, ...classOf(value).mro] : classOf(value).mro;
}
