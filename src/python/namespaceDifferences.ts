import { NAMESPACE_DIFFERENCES } from './data/namespaceDifferences';
import { isEnumClass } from './enums';
import { getAttribute } from './objects';
import { currentRuntime } from './runtimeContext';
import { classOf } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyClass, PyError, PyInstance, PyModule, type PyValue } from './values';

// The modules and classes whose namespaces still differ from CPython's, which scripts/checkPythonDicts.ts finds: listing
// their namespace (vars(), __dict__, dir(), help()) and reading the names only one side has raise the unsupported
// error, so that no program sees a difference silently.

/**
 * For each module or class (`module.qualname`), the names CPython's namespace has that this one lacks, the extra, and
 * the extra that CPython still serves when read: through a module's `__getattr__`, or on a class's instances.
 */
export interface NamespaceDifferences {
  modules: Record<string, Difference>;
  classes: Record<string, Difference>;
}

type Difference = [missing: string[], extra: string[], readable?: string[]];

let enforced = true;

/** Turns the checks off, for scripts/checkPythonDicts.ts, which compares the namespaces themselves. */
export function enforceNamespaceDifferences(on: boolean): void {
  enforced = on;
}

/**
 * The classes that library machinery creates for a program with another namespace than CPython's, such as those of
 * `typing.NamedTuple` and `TypedDict`, with the CPython internals that differ.
 */
export const machineryClasses = new WeakMap<PyClass, string>();

const ENUM_INTERNALS = '_member_map_、_value2member_map_、_value_ などの EnumType の内部';

/** Every extra name, which lets reading a name skip the tables for the names no namespace has extra. */
const extraNames = new Set(
  [...Object.values(NAMESPACE_DIFFERENCES.modules), ...Object.values(NAMESPACE_DIFFERENCES.classes)].flatMap(
    ([, extra]) => extra
  )
);

/** Raises the unsupported error for `vars(value)` or `value.__dict__` when its namespace differs from CPython's. */
export function checkNamespaceListing(value: PyValue, listing: string): void {
  if (!enforced || currentRuntime().inLibraryCode()) return;
  const differing = value instanceof PyModule ? moduleDifference(value) : ownDifference(value);
  if (differing) throw listingError(listing, differing);
}

export function checkStarNamespace(module: PyModule): void {
  if (!enforced || currentRuntime().inLibraryCode()) return;
  const [missing, extra] = NAMESPACE_DIFFERENCES.modules[module.name] ?? [[], []];
  if ([...missing, ...extra].some((name) => !name.startsWith('_')))
    throw listingError('from ... import *', module.name);
}

/**
 * Raises the unsupported error for `dir(value)` or `help(value)` when a namespace they show differs from CPython's:
 * the module's, or the class's and its bases'.
 */
export function checkNamespaceView(value: PyValue, listing: string, fromLibrary = false): void {
  if (!enforced || (!fromLibrary && currentRuntime().inLibraryCode())) return;
  const differing = viewDifference(value, fromLibrary);
  if (differing) throw listingError(listing, differing);
}

// dir() and help() sort the names, so that only a different set of names shows.
function viewDifference(value: PyValue, documenting: boolean): string | undefined {
  if (value instanceof PyModule) {
    const differing = moduleDifference(value, true);
    if (differing || !documenting) return differing;
    // A module's documentation shows its classes' namespaces too.
    const classes = [...value.dict.values()].filter((each) => each instanceof PyClass && each.module === value.name);
    return classes.map((each) => viewDifference(each, false)).find(Boolean);
  }
  return (
    ownDifference(value) ??
    (value instanceof PyClass ? value : classOf(value)).mro.map((cls) => classDifference(cls, true)).find(Boolean)
  );
}

/** Raises the unsupported error for a program reading a name that only this grader's namespace has. */
export function checkExtraName(value: PyValue, name: string): void {
  if (!enforced || currentRuntime().inLibraryCode()) return;
  const owner = extraOwner(value, name);
  if (owner !== undefined) throw nameError(owner, name);
}

/** The module or class whose extra name `name` makes reading it from `value` differ from CPython, or undefined. */
// code-gauge-allow functionCognitiveComplexity 16 -- A module and a class keep their extra names in different tables.
function extraOwner(value: PyValue, name: string): string | undefined {
  if (!extraNames.has(name)) return undefined;
  if (value instanceof PyModule) {
    const [, extra, readable] = NAMESPACE_DIFFERENCES.modules[value.name] ?? [[], []];
    return extra.includes(name) && !readable?.includes(name) ? value.name : undefined;
  }
  for (const cls of value instanceof PyClass ? value.mro : classOf(value).mro) {
    const [, extra, readable] = NAMESPACE_DIFFERENCES.classes[classKey(cls)] ?? [[], []];
    if (extra.includes(name)) return value instanceof PyClass || !readable?.includes(name) ? classKey(cls) : undefined;
    if (cls.dict.has(name)) return undefined;
  }
  return undefined;
}

/**
 * The names `dir()` of CPython would list for `value`, as far as the tables tell, from those this grader's `dir()`
 * lists: AttributeError suggestions choose from them.
 */
export function cpythonDirNames(value: PyValue, names: string[]): string[] {
  const shown = names.filter((name) => extraOwner(value, name) === undefined);
  const missing =
    value instanceof PyModule
      ? (NAMESPACE_DIFFERENCES.modules[value.name]?.[0] ?? [])
      : (value instanceof PyClass ? value.mro : classOf(value).mro).flatMap(
          (cls) => NAMESPACE_DIFFERENCES.classes[classKey(cls)]?.[0] ?? []
        );
  return [...new Set([...shown, ...missing])];
}

/**
 * Reads an attribute for a program, which raises the unsupported error for a name only this grader's namespace has,
 * and, in place of AttributeError, for a name only CPython's has.
 */
export function readProgramAttribute(value: PyValue, name: string, read: () => PyValue): PyValue {
  checkExtraName(value, name);
  try {
    return read();
  } catch (error) {
    throw programAttributeError(error, value, name);
  }
}

/** `object.name` in a program's code (see readProgramAttribute). */
export function programAttribute(value: PyValue, name: string): PyValue {
  checkExtraName(value, name);
  try {
    return getAttribute(value, name);
  } catch (error) {
    throw programAttributeError(error, value, name);
  }
}

/** The error a program's reading of an attribute raises: the unsupported error for a name only CPython's has. */
export function programAttributeError(error: unknown, value: PyValue, name: string): unknown {
  if (!enforced || !(error instanceof PyError) || error.exception.cls.name !== 'AttributeError') return error;
  if (currentRuntime().inLibraryCode()) return error;
  const feature = missingNamespaceName(value, name);
  return feature === undefined ? error : new UnsupportedFeatureError(feature);
}

/** The feature to name for a name CPython's namespace of a module or of a class of `value` has and this one lacks. */
export function missingNamespaceName(value: PyValue, name: string): string | undefined {
  if (!enforced) return undefined;
  if (value instanceof PyModule) {
    return NAMESPACE_DIFFERENCES.modules[value.name]?.[0].includes(name) ? missingFeature(value.name, name) : undefined;
  }
  for (const cls of value instanceof PyClass ? value.mro : classOf(value).mro) {
    if (NAMESPACE_DIFFERENCES.classes[classKey(cls)]?.[0].includes(name)) return missingFeature(classKey(cls), name);
  }
  return undefined;
}

/** What makes the namespace of a value itself differ, as a module or class name, or undefined. */
function ownDifference(value: PyValue): string | undefined {
  if (value instanceof PyClass) return classDifference(value);
  // The members of an Enum keep their value and name as CPython's do not.
  if (value instanceof PyInstance && value.enumValue !== undefined) {
    internalsByKey.set(classKey(value.cls), ENUM_INTERNALS);
    return classKey(value.cls);
  }
  return undefined;
}

/** The CPython internals a program's class that library machinery created lacks, or undefined for another class. */
function machineryInternals(key: string): string | undefined {
  return internalsByKey.get(key);
}

/** The internals of the classes that rules rather than the tables find differing, by their names. */
const internalsByKey = new Map<string, string>();

function moduleDifference(module: PyModule, sorted = false): string | undefined {
  return differs(NAMESPACE_DIFFERENCES.modules[module.name], sorted) ? module.name : undefined;
}

function classDifference(cls: PyClass, sorted = false): string | undefined {
  const key = classKey(cls);
  if (differs(NAMESPACE_DIFFERENCES.classes[key], sorted)) return key;
  // A program's Enum classes lack the internals CPython's EnumType keeps in them.
  const internals = machineryClasses.get(cls) ?? (isEnumClass(cls) && !cls.isBuiltin ? ENUM_INTERNALS : undefined);
  if (internals === undefined) return undefined;
  internalsByKey.set(key, internals);
  return key;
}

/** Whether a namespace differs: in its names, or, unless sorted, in their order too. */
function differs(difference: Difference | undefined, sorted: boolean): boolean {
  return difference !== undefined && (!sorted || difference[0].length + difference[1].length > 0);
}

function classKey(cls: PyClass): string {
  return `${cls.module}.${cls.qualifiedName}`;
}

function listingError(listing: string, name: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    `${listing}（${name} の名前空間は、CPython の内部の名前${internals(name)}が違う）`
  );
}

function nameError(owner: string, name: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(`${owner}.${name}（CPython の ${owner} にない、この採点環境の内部の名前）`);
}

function missingFeature(owner: string, name: string): string {
  return `${owner}.${name}（CPython の ${owner} の内部の名前）`;
}

/** Some of the names that differ, which the error names. */
function internals(name: string): string {
  const rule = machineryInternals(name);
  if (rule !== undefined) return `（${rule}）`;
  const [missing, extra] = NAMESPACE_DIFFERENCES.classes[name] ?? NAMESPACE_DIFFERENCES.modules[name] ?? [[], []];
  const names = [...missing, ...extra];
  if (names.length === 0) return '（その順序）';
  const shown = names.slice(0, 3).join('、');
  return names.length > 3 ? `（${shown} ほか ${names.length - 3} 個）` : `（${shown}）`;
}
