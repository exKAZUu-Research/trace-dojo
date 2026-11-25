// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { ClassDecl } from './ast';
import { lower } from './bytes';
import { nativeCallerIsStrict } from './calls';
import { evaluateInClass, resolveConstant } from './classConstants';
import { debugType } from './conversions';
import { throwError } from './errors';
import { createNativeMethod, type NativeMethod } from './native';
import { FatalError, rt } from './runtime';
import {
  type ClassConst,
  enumCaseIdentifier,
  type Key,
  type NativeObjectComparison,
  PhpArray,
  type PhpClass,
  PhpObject,
  type PropDecl,
  type Value,
} from './values';

/** The magic methods an enum may not declare, in the order PHP checks them. */
const FORBIDDEN_MAGIC_METHODS = [
  '__construct',
  '__destruct',
  '__clone',
  '__get',
  '__set',
  '__unset',
  '__isset',
  '__toString',
  '__debugInfo',
  '__serialize',
  '__unserialize',
  '__sleep',
  '__wakeup',
  '__set_state',
];

/** Two different enum cases, or a case and another object, have no order and are never equal. */
export const compareEnumCases: NativeObjectComparison = () => 1;

interface BackedCases {
  byValue: Map<Key, PhpObject>;
}

/** The cases of each backed enum by value, built once every constant of the enum has its value. */
const backedCases = new WeakMap<PhpClass, BackedCases>();
const buildingCases = new WeakSet<PhpClass>();

/** Sets up what an enum declaration implies before its members are added: its properties and builtin interfaces. */
export function prepareEnum(cls: PhpClass, decl: ClassDecl, interfaces: string[]): void {
  cls.isFinal = true;
  cls.isCloneable = false;
  cls.compare = compareEnumCases;
  interfaces.push('UnitEnum');
  if (decl.backingType) interfaces.push('BackedEnum');
  addCaseProperty(cls, 'name', 'string');
  if (decl.backingType) addCaseProperty(cls, 'value', decl.backingType);
}

function addCaseProperty(cls: PhpClass, name: string, type: 'int' | 'string'): void {
  const decl: PropDecl = {
    name,
    key: name,
    cls,
    visibility: 'public',
    isStatic: false,
    isReadonly: true,
    isFinal: false,
    hasDefault: false,
    type: { k: 'named', name: type },
  };
  cls.props.push(decl);
  cls.propByName.set(name, decl);
}

/** Adds an enum case as the class constant whose value is the case's only object. */
export function addEnumCase(cls: PhpClass, ast: ClassDecl['consts'][number]): void {
  const backed = cls.decl?.backingType !== undefined;
  cls.consts.set(ast.name, {
    name: ast.name,
    cls,
    visibility: 'public',
    isFinal: false,
    isCase: true,
    attributes: ast.attributes,
    evaluate: () => {
      const runtime = rt();
      const value = backed ? evaluateInClass(ast.value, cls) : undefined;
      const object = runtime.newObject(cls);
      object.props.set('name', ast.name);
      if (value !== undefined) object.props.set('value', value);
      runtime.declarationRoots.add(object);
      return object;
    },
  });
}

/**
 * Adds the methods PHP gives every enum after the declared ones, then checks the members an enum may not have, which
 * PHP reports when it declares the enum.
 */
export function linkEnumMembers(cls: PhpClass, row: number): void {
  const methods: NativeMethod[] = [{ signature: 'cases(): array', isStatic: true, impl: () => enumCases(cls) }];
  if (cls.decl?.backingType) {
    const type = cls.decl.backingType === 'int' ? 'int' : 'string|int';
    methods.push(
      {
        signature: `from(${type} $value): static`,
        isStatic: true,
        impl: ({ args }) => enumCaseFor(cls, args[0], true),
      },
      {
        signature: `tryFrom(${type} $value): ?static`,
        isStatic: true,
        impl: ({ args }) => enumCaseFor(cls, args[0], false),
      }
    );
  }
  for (const definition of methods) {
    const method = createNativeMethod(cls, definition);
    if (cls.methods.has(method.lname)) throw new FatalError(`Cannot redeclare ${cls.name}::${method.name}()`, row);
    cls.methods.set(method.lname, method);
  }
  if (cls.staticProps.size > 0 || cls.props.some((prop) => prop.declarationAst))
    throw new FatalError(`Enum ${cls.name} cannot include properties`, row);
  const magic = FORBIDDEN_MAGIC_METHODS.find((name) => cls.methods.has(lower(name)));
  if (magic) throw new FatalError(`Enum ${cls.name} cannot include magic method ${magic}`, row);
}

/** Whether a method is one PHP gives an enum, which no interface's signature check applies to. */
export function isEnumBuiltinMethod(cls: PhpClass, method: { cls: PhpClass; fn: { kind: string } }): boolean {
  return cls.kind === 'enum' && method.cls === cls && method.fn.kind === 'native';
}

function enumCases(cls: PhpClass): PhpArray {
  const cases: Value[] = [];
  for (const constant of cls.consts.values())
    if (constant.isCase && constant.cls === cls) cases.push(resolveConstant(constant, cls.name, true));
  return PhpArray.list(cases);
}

function enumCaseFor(cls: PhpClass, value: Value, required: boolean): Value {
  // A string-backed enum's methods accept an int only from code without strict_types.
  if (cls.decl?.backingType === 'string' && typeof value === 'bigint' && nativeCallerIsStrict())
    throwError(
      'TypeError',
      `${cls.name}::${required ? 'from' : 'tryFrom'}(): Argument #1 ($value) must be of type string, int given`
    );
  const key = cls.decl?.backingType === 'string' ? String(value as bigint | string) : (value as bigint);
  const found = requireBackedCases(cls)?.byValue.get(key);
  if (found) return found;
  if (!required) return null;
  const text = typeof key === 'string' ? `"${key}"` : key.toString();
  throwError('ValueError', `${text} is not a valid backing value for enum ${cls.name}`);
}

/** The cases of a backed enum by value, checking each value's type and that no two cases share one. */
function indexCases(cls: PhpClass, constants: ClassConst[], backingType: 'int' | 'string'): Map<Key, PhpObject> {
  const byValue = new Map<Key, PhpObject>();
  for (const constant of constants) {
    if (!constant.isCase) continue;
    const object = constant.value as PhpObject;
    const value = object.props.get('value') as Value;
    const type = value instanceof PhpObject ? 'object' : debugType(value);
    if (type !== backingType)
      throwError('TypeError', `Enum case type ${type} does not match enum backing type ${backingType}`);
    const duplicate = byValue.get(value as Key);
    if (duplicate)
      throwError(
        'Error',
        `Duplicate value in enum ${cls.name} for cases ${enumCaseIdentifier(duplicate)} and ${constant.name}`
      );
    byValue.set(value as Key, object);
  }
  return byValue;
}

/**
 * Gives every constant of a backed enum its value and indexes the cases by value, as PHP does before it reads one of
 * the enum's constants or looks up a case by value.
 */
export function requireBackedCases(cls: PhpClass): BackedCases | undefined {
  const backingType = cls.decl?.backingType;
  if (!backingType) return undefined;
  const existing = backedCases.get(cls);
  if (existing || buildingCases.has(cls)) return existing;
  buildingCases.add(cls);
  try {
    const own: ClassConst[] = [...cls.consts.values()].filter((constant) => constant.cls === cls);
    for (const constant of own) resolveConstant(constant, cls.name, true);
    const cases = { byValue: indexCases(cls, own, backingType) };
    backedCases.set(cls, cases);
    return cases;
  } finally {
    buildingCases.delete(cls);
  }
}
