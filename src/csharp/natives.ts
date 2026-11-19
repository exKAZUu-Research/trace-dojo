import type { Frame } from './runtime';
import { displayType, type MethodSymbol, type NamedType, type Type } from './types';
import type { Value, VariableReference } from './values';

/** What a native method knows of its call besides its receiver and arguments. */
export interface NativeCall {
  frame: Frame;
  method: MethodSymbol;
  /** The type arguments of a generic method. */
  typeArgs: Type[];
  /** The constructed type the method belongs to, which a static method of a generic type needs. */
  owner: NamedType | undefined;
}

/** A library method implemented in TypeScript. `ref` and `out` arguments arrive as references. */
export type NativeMethod = (call: NativeCall, receiver: Value, args: (Value | VariableReference)[]) => Value;

const registry = new Map<string, NativeMethod>();
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

/** The native implementation of a library method, if any. */
export function nativeOf(method: MethodSymbol): NativeMethod | undefined {
  const base = `${method.owner.fullName}.${method.kind === 'constructor' ? '.ctor' : method.name}`;
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
