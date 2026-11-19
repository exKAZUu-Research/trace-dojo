import type { Eval, Frame } from './runtime';
import type { Syntax } from './syntax';
import type { ClassInfo, FieldInfo, FunctionInfo, Type } from './types';
import type { ArrayStore, CObject, Ptr, Value } from './values';

export type ReferenceLifetime = CObject | 'full-expression';
export type InitializerTarget = ArrayStore | CObject;
export type ConstantMembers = ReadonlyMap<FieldInfo, number | bigint>;
export type MemberConstant = (members: ConstantMembers) => number | bigint | undefined;
export const NO_CONSTANT_MEMBERS: ConstantMembers = new Map();
export type LibraryConstant = true | { stringLength: number };
interface ConstantValue {
  memberConstant?: MemberConstant;
  constantStringLength?: number;
}

export type Initializer = ((
  frame: Frame,
  target?: InitializerTarget,
  zeroInitialize?: boolean,
  referenceLifetime?: ReferenceLifetime
) => Value) & { isConstant?: boolean } & ConstantValue;

export function initializerWithConstancy(run: Initializer, isConstant: boolean, value?: ConstantValue): Initializer {
  if (isConstant) run.isConstant = true;
  if (value?.memberConstant) run.memberConstant = value.memberConstant;
  if (value?.constantStringLength !== undefined) run.constantStringLength = value.constantStringLength;
  return run;
}

/**
 * A compiled expression. An lvalue evaluates to the location it designates (a `Ptr`); a prvalue evaluates to its
 * value. The type is never a reference type: a reference denotes the object it refers to, as an lvalue.
 */
export interface Expr extends ConstantValue {
  isAssignmentList?: boolean;
  type: Type;
  isLvalue: boolean;
  run: (
    frame: Frame,
    zeroInitialize?: boolean,
    destination?: CObject,
    referenceLifetime?: ReferenceLifetime
  ) => Value | Ptr;
  row: number;
  /** The value of a constant expression of arithmetic type, which array lengths and `case` labels need. */
  constant?: number | bigint;
  isThis?: boolean;
  /** Reads a static member's integral constant without requiring its addressable definition. */
  readConstant?: Eval<Value>;
  /** The factors of a floating-point product, which an addition or subtraction using it fuses (`a * b + c`). */
  product?: { left: Eval<number>; right: Eval<number> };
  /** Whether the expression is a null pointer constant: `nullptr`, or an integer literal whose value is zero. */
  isNullConstant?: boolean;
  /** An lvalue location or pointer value that can be formed before dynamic initialization. */
  staticAddress?: boolean;
  constantPointerValue?: boolean;
  constantInitialization?: boolean;
  /** The bytes of a string literal, which may initialize a `char` array. */
  literalBytes?: string;
  /** The functions a name denotes, which a call resolves among. */
  functions?: FunctionCandidates;
  /** Whether the expression only calls functions or creates objects, whose own steps show what it did. */
  onlyCalls?: boolean;
  /** Whether evaluating the expression creates a new object (a prvalue of class type), which needs no copy. */
  isTemporaryObject?: boolean;
  /** The braced list of an argument (`f({1, 2})`), which converts to a parameter's type by list-initialization. */
  braced?: Syntax;
  /** The member an expression names, for messages such as "assigning to a const member". */
  description?: string;
  /**
   * For a member of a temporary (`T(1).id`): the temporary's prvalue, and the indices of the members leading to the
   * member, so that a reference bound to the member can extend the temporary's lifetime (C++20 [class.temporary]).
   */
  temporaryMember?: { object: Expr; path: number[] };
}

/** A name that denotes functions: free functions, or the member functions of an object. */
export interface FunctionCandidates {
  name: string;
  candidates: FunctionInfo[];
  /** The object of a member function call, evaluated as an lvalue or a prvalue. */
  object?: Expr;
  /** The class whose members were looked up, which access checks name (C++20 [class.access.base]). */
  namingClass?: ClassInfo;
  /** Whether the call must not dispatch virtually, as a qualified call does. */
  isQualified?: boolean;
  /** Explicit template arguments, such as `std::max<int>`. */
  templateArgs?: Type[];
}

export function constantExpr(type: Type, value: number | bigint, row: number): Expr {
  return { type, isLvalue: false, run: () => value, row, constant: value };
}

export function memberConstantOf(expr: Expr): MemberConstant | undefined {
  const value = expr.constant;
  return value === undefined ? expr.memberConstant : () => value;
}

export function mapMemberConstants(
  operands: Expr[],
  operation: (values: (number | bigint)[]) => number | bigint
): MemberConstant | undefined {
  if (!operands.some((operand) => operand.memberConstant)) return;
  const inputs = operands.map(memberConstantOf);
  if (inputs.some((input) => !input)) return;
  return (members) => {
    const values: (number | bigint)[] = [];
    for (const input of inputs) {
      const value = input?.(members);
      if (value === undefined) return;
      values.push(value);
    }
    return operation(values);
  };
}
