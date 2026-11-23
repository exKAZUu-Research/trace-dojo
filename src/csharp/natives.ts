import type { Frame } from './runtime';
import { displayType, type MethodSymbol, type NamedType, specialOf, type Type } from './types';
import {
  copyValue,
  CsArray,
  CsString,
  CsStruct,
  freshString,
  plainString,
  stringText,
  type Value,
  type VariableReference,
} from './values';

/** What a native method knows of its call besides its receiver and arguments. */
export interface NativeCall {
  frame: Frame;
  method: MethodSymbol;
  /** The type arguments of a generic method. */
  typeArgs: Type[];
  /** The constructed type the method belongs to, which a static method of a generic type needs. */
  owner: NamedType | undefined;
  /** The row of the call, where an error about the call's arguments points. */
  row: number | undefined;
}

/** A library method implemented in TypeScript. `ref` and `out` arguments arrive as references. */
export type NativeMethod = (call: NativeCall, receiver: Value, args: (Value | VariableReference)[]) => Value;

const registry = new Map<string, NativeMethod>();
/** The natives that see and return strings as they are, since .NET returns some of its string arguments themselves. */
const keepingStrings = new WeakSet<NativeMethod>();
/** The natives by key without `?`, since a nullable reference type is its type to the compiler. */
const registryWithoutNullability = new Map<string, NativeMethod>();

/**
 * Registers native implementations by key: `Type.Member(parameter types)` for one overload, or `Type.Member` for all
 * of them. Types are full metadata names (`System.Collections.Generic.List\`1`); accessors are `get_Name` and
 * `set_Name`, indexers `get_Item`, constructors `.ctor`, and operators `op_Addition` and the like.
 */
export function defineNatives(natives: Record<string, NativeMethod>): void {
  for (const [key, native] of Object.entries(natives)) {
    registry.set(key, native);
    registryWithoutNullability.set(key.replaceAll('?', ''), native);
  }
}

/**
 * Registers natives that take their `string` arguments and receiver with their identity and whose results keep it:
 * an argument returned is the same object, and a new plain string is an interned one.
 */
export function defineNativesKeepingStrings(natives: Record<string, NativeMethod>): void {
  for (const native of Object.values(natives)) keepingStrings.add(native);
  defineNatives(natives);
}

/** The native implementation of a library method, if any, which a constructor may take from its base class's. */
export function nativeOf(method: MethodSymbol): NativeMethod | undefined {
  const native = ownNativeOf(method, method.owner.fullName) ?? inheritedConstructorOf(method);
  if (!native) return native;
  return withCheckedResult(method, keepingStrings.has(native) ? native : withPlainStrings(method, native));
}

/**
 * A native whose result crosses into the program as C# requires: a struct as a copy, so that no library storage shares
 * it with a variable, and a string checked against the string length limit and charged, whichever native built it.
 */
function withCheckedResult(method: MethodSymbol, native: NativeMethod): NativeMethod {
  const hasString = resultStrings(method) === 'string';
  return (call, receiver, args) => {
    const value = native(call, receiver, args);
    if (value instanceof CsStruct) return copyValue(value);
    // Building the text took work in proportion to its length, which the natives that scan or map text do not charge.
    if (hasString && (typeof value === 'string' || value instanceof CsString))
      call.frame.runtime.allocateString(stringText(value).length);
    return value;
  };
}

function inheritedConstructorOf(method: MethodSymbol): NativeMethod | undefined {
  if (method.kind !== 'constructor') return undefined;
  for (let base = method.owner.baseType; base; base = base.symbol.baseType) {
    const inherited = ownNativeOf(method, base.symbol.fullName);
    if (inherited) return inherited;
  }
  return undefined;
}

/**
 * A native that reads its `string` arguments and receiver as plain text and whose new strings are .NET's new objects,
 * so that most natives handle strings as JavaScript strings.
 */
function withPlainStrings(method: MethodSymbol, native: NativeMethod): NativeMethod {
  const stringParameters = new Set(
    method.parameters.flatMap((parameter, index) =>
      parameter.refKind === undefined && specialOf(parameter.type) === 'string' ? [index] : []
    )
  );
  const hasStringReceiver = !method.isStatic && method.owner.special === 'string';
  const result = resultStrings(method);
  if (stringParameters.size === 0 && !hasStringReceiver && result === undefined) return native;
  return (call, receiver, args) => {
    const plainArgs = args.map((arg, index) => (stringParameters.has(index) ? plainString(arg as Value) : arg));
    const value = native(call, hasStringReceiver ? plainString(receiver) : receiver, plainArgs);
    return result === undefined ? value : withFreshStrings(value, result);
  };
}

/** Where a method's result has strings: itself, as a `string` or a new `String`, or the elements of a `string[]`. */
function resultStrings(method: MethodSymbol): 'string' | 'elements' | undefined {
  const type = method.returnType;
  if (specialOf(type) === 'string' || (method.kind === 'constructor' && method.owner.special === 'string'))
    return 'string';
  return type.kind === 'array' && specialOf(type.element) === 'string' ? 'elements' : undefined;
}

function withFreshStrings(value: Value, where: 'string' | 'elements'): Value {
  if (where === 'string') return typeof value === 'string' ? freshString(value) : value;
  if (value instanceof CsArray) {
    for (const [index, element] of value.values.entries())
      if (typeof element === 'string') value.values[index] = freshString(element);
  }
  return value;
}

function ownNativeOf(method: MethodSymbol, ownerName: string): NativeMethod | undefined {
  const base = `${ownerName}.${method.kind === 'constructor' ? '.ctor' : method.name}`;
  const signature = method.parameters.map((parameter) => displayType(parameter.type)).join(', ');
  return (
    registry.get(`${base}(${signature})`) ??
    registryWithoutNullability.get(`${base}(${signature})`.replaceAll('?', '')) ??
    registry.get(base)
  );
}

/** The .NET names of the operators that a type may declare. */
export const OPERATOR_NAMES: Record<string, string> = {
  '+': 'op_Addition',
  '-': 'op_Subtraction',
  '*': 'op_Multiply',
  '/': 'op_Division',
  '%': 'op_Modulus',
  '&': 'op_BitwiseAnd',
  '|': 'op_BitwiseOr',
  '^': 'op_ExclusiveOr',
  '<<': 'op_LeftShift',
  '>>': 'op_RightShift',
  '>>>': 'op_UnsignedRightShift',
  '==': 'op_Equality',
  '!=': 'op_Inequality',
  '<': 'op_LessThan',
  '>': 'op_GreaterThan',
  '<=': 'op_LessThanOrEqual',
  '>=': 'op_GreaterThanOrEqual',
  '!': 'op_LogicalNot',
  '~': 'op_OnesComplement',
  '++': 'op_Increment',
  '--': 'op_Decrement',
};

/** The names of unary operators, which share tokens with binary ones. */
export const UNARY_OPERATOR_NAMES: Record<string, string> = {
  '+': 'op_UnaryPlus',
  '-': 'op_UnaryNegation',
  '!': 'op_LogicalNot',
  '~': 'op_OnesComplement',
  '++': 'op_Increment',
  '--': 'op_Decrement',
};
