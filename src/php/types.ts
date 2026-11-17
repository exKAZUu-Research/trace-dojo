import { floatFitsInt, numericPrefix, toBool } from './conversions';
import { deprecated } from './errors';
import { formatFloatForMessage, toStr } from './operators';
import { rt } from './runtime';
import { PhpArray, type PhpClass, PhpObject, type TypeDecl, type Value } from './values';

/** Checks whether a value is callable, which the interpreter provides. */
let isCallableValue: (value: Value) => boolean = () => false;

export function setCallableCheck(check: (value: Value) => boolean): void {
  isCallableValue = check;
}

/** Formats a type as PHP's messages do. */
// code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function typeToString(type: TypeDecl): string {
  if (type.k === 'named') {
    if (type.name === 'iterable') return `Traversable|array${type.nullable ? '|null' : ''}`;
    if (type.nullable) return `?${type.name}`;
    return type.name;
  }
  if (type.k === 'inter') return type.types.map((part) => typeToString(part)).join('&');
  // A union of one type and null reads as a nullable type.
  const others = type.types.filter((part) => !(part.k === 'named' && part.name === 'null'));
  if (
    others.length === 1 &&
    others.length < type.types.length &&
    others[0].k === 'named' &&
    others[0].name !== 'mixed' &&
    others[0].name !== 'iterable'
  ) {
    return `?${typeToString(others[0])}`;
  }
  const parts = type.types.flatMap((part) =>
    part.k === 'named' && part.name === 'iterable'
      ? ['Traversable', 'array', ...(part.nullable ? ['null'] : [])]
      : [part.k === 'inter' ? `(${typeToString(part)})` : typeToString(part)]
  );
  // PHP lists class types first, then the builtin types in a fixed order, with null last.
  return sortUnion(parts).join('|');
}

const BUILTIN_ORDER = [
  'object',
  'array',
  'string',
  'int',
  'float',
  'iterable',
  'callable',
  'bool',
  'false',
  'true',
  'void',
  'null',
  'never',
  'mixed',
];

function sortUnion(parts: string[]): string[] {
  const classes = parts.filter((part) => !BUILTIN_ORDER.includes(part));
  const builtins = BUILTIN_ORDER.filter((name) => parts.includes(name));
  if (builtins.includes('bool')) {
    const index = builtins.indexOf('false');
    if (index !== -1) builtins.splice(index, 1);
  }
  return [...classes, ...builtins];
}

export interface CoercionContext {
  /** Whether strict_types governs the coercion. */
  strict: boolean;
  /** The scope class for `self` and `parent`. */
  scope?: PhpClass;
  /** The class `static` refers to. */
  staticClass?: PhpClass;
  /** Whether the value goes to a builtin function, which coerces null for scalar types with a deprecation. */
  internal: boolean;
  /** Describes the parameter in a deprecation for a null argument, e.g. `strlen(): Passing null to parameter #1 ($string) of type string`. */
  nullDeprecation?: () => string;
}

const NO_MATCH = Symbol('noMatch');

/**
 * Coerces a value to a declared type as PHP's coercive typing mode does, or returns NO_MATCH. `float` accepts an int
 * even in strict mode.
 */
export function coerce(value: Value, type: TypeDecl, context: CoercionContext): Value | typeof NO_MATCH {
  if (matches(value, type, context)) return value;
  if (value === null) {
    if (context.internal && context.nullDeprecation && scalarTarget(type)) {
      deprecated(context.nullDeprecation());
      return coerceScalar(value, type);
    }
    return NO_MATCH;
  }
  if (context.strict) {
    if (typeof value === 'bigint' && acceptsName(type, 'float')) return Number(value);
    return NO_MATCH;
  }
  return coerceScalar(value, type);
}

export { NO_MATCH };

function scalarTarget(type: TypeDecl): boolean {
  if (type.k === 'named') return ['int', 'float', 'string', 'bool'].includes(type.name);
  if (type.k === 'union') return type.types.some(scalarTarget);
  return false;
}

function acceptsName(type: TypeDecl, name: string): boolean {
  if (type.k === 'named') return type.name === name;
  if (type.k === 'union') return type.types.some((part) => acceptsName(part, name));
  return false;
}

function coerceScalar(value: Value, type: TypeDecl): Value | typeof NO_MATCH {
  if (value instanceof PhpArray) return NO_MATCH;
  if (value instanceof PhpObject) {
    if (acceptsName(type, 'string') && value.cls.findMethod('__tostring')) return toStr(value);
    return NO_MATCH;
  }
  const wantsInt = acceptsName(type, 'int');
  const wantsFloat = acceptsName(type, 'float');
  const wantsString = acceptsName(type, 'string');
  const wantsBool = acceptsName(type, 'bool');
  if (typeof value === 'string') {
    const prefix = numericPrefix(value);
    if (prefix?.whole) {
      if (wantsInt && typeof prefix.value === 'bigint') return prefix.value;
      if (wantsFloat) return Number(prefix.value);
      if (wantsInt) {
        const number = prefix.value as number;
        if (Number.isInteger(number) && floatFitsInt(number)) return BigInt(number);
        if (floatFitsInt(number)) {
          deprecated(`Implicit conversion from float-string "${value}" to int loses precision`);
          return BigInt(Math.trunc(number));
        }
        if (wantsBool) return value !== '' && value !== '0';
        return NO_MATCH;
      }
    }
    if (wantsBool && !wantsInt && !wantsFloat) return value !== '' && value !== '0';
    if (wantsBool && !prefix?.whole) return value !== '' && value !== '0';
    return NO_MATCH;
  }
  if (value === null) {
    if (wantsString) return '';
    if (wantsInt) return 0n;
    if (wantsFloat) return 0;
    if (wantsBool) return false;
    return NO_MATCH;
  }
  if (typeof value === 'bigint') {
    if (wantsFloat) return Number(value);
    if (wantsString) return value.toString();
    if (wantsBool) return value !== 0n;
    return NO_MATCH;
  }
  if (typeof value === 'number') {
    if (wantsInt) {
      if (!Number.isFinite(value) || !floatFitsInt(value)) {
        if (wantsString) return toStr(value);
        if (wantsBool) return toBool(value);
        return NO_MATCH;
      }
      if (!Number.isInteger(value)) {
        deprecated(`Implicit conversion from float ${formatFloatForMessage(value)} to int loses precision`);
      }
      return BigInt(Math.trunc(value));
    }
    if (wantsString) return toStr(value);
    if (wantsBool) return toBool(value);
    return NO_MATCH;
  }
  if (typeof value === 'boolean') {
    if (wantsInt) return value ? 1n : 0n;
    if (wantsFloat) return value ? 1 : 0;
    if (wantsString) return value ? '1' : '';
    return NO_MATCH;
  }
  return NO_MATCH;
}

/** Whether a value has a declared type exactly, without coercion. */
// code-gauge-allow functionNcss 46 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function matches(
  value: Value,
  type: TypeDecl,
  context: Pick<CoercionContext, 'scope' | 'staticClass'>
): boolean {
  if (type.k === 'union') return type.types.some((part) => matches(value, part, context));
  if (type.k === 'inter') return type.types.every((part) => matches(value, part, context));
  if (value === null && type.nullable) return true;
  switch (type.name) {
    case 'mixed': {
      return true;
    }
    case 'int': {
      return typeof value === 'bigint';
    }
    case 'float': {
      return typeof value === 'number';
    }
    case 'string': {
      return typeof value === 'string';
    }
    case 'bool': {
      return typeof value === 'boolean';
    }
    case 'false': {
      return value === false;
    }
    case 'true': {
      return value === true;
    }
    case 'null':
    case 'void': {
      return value === null;
    }
    case 'array': {
      return value instanceof PhpArray;
    }
    case 'object': {
      return value instanceof PhpObject && value.cls.name !== '(stream)';
    }
    case 'iterable': {
      return value instanceof PhpArray || (value instanceof PhpObject && isTraversable(value));
    }
    case 'callable': {
      return isCallableValue(value);
    }
    case 'never': {
      return false;
    }
    case 'self': {
      return value instanceof PhpObject && !!context.scope && value.cls.isSubclassOf(context.scope);
    }
    case 'parent': {
      return value instanceof PhpObject && !!context.scope?.parent && value.cls.isSubclassOf(context.scope.parent);
    }
    case 'static': {
      return value instanceof PhpObject && !!context.staticClass && value.cls.isSubclassOf(context.staticClass);
    }
    default: {
      if (!(value instanceof PhpObject)) return false;
      const cls = rt().classes.get(type.name.toLowerCase());
      return cls !== undefined && value.cls.isSubclassOf(cls);
    }
  }
}

export function isTraversable(object: PhpObject): boolean {
  const traversable = rt().classes.get('traversable');
  return traversable !== undefined && object.cls.isSubclassOf(traversable);
}

/** Resolves `self` and `static` in a type for messages, as PHP prints the class names. */
export function describeType(type: TypeDecl, scope?: PhpClass, staticClass?: PhpClass): string {
  return typeToString(resolveSelf(type, scope, staticClass));
}

/** Writes `self`, `parent`, and `static` in a type as the class names they stand for, as PHP's messages do. */
function resolveSelf(type: TypeDecl, scope: PhpClass | undefined, staticClass: PhpClass | undefined): TypeDecl {
  if (type.k === 'named') {
    if (type.name === 'static' && staticClass) return { ...type, name: staticClass.name };
    if (!scope) return type;
    if (type.name === 'self') return { ...type, name: scope.name };
    if (type.name === 'parent' && scope.parent) return { ...type, name: scope.parent.name };
    return type;
  }
  return { ...type, types: type.types.map((part) => resolveSelf(part, scope, staticClass)) };
}
