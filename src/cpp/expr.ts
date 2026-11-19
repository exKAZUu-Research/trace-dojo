import type { Eval } from './runtime';
import type { Syntax } from './syntax';
import type { ClassInfo, FunctionInfo, Type } from './types';
import type { Ptr, Value } from './values';

/**
 * A compiled expression. An lvalue evaluates to the location it designates (a `Ptr`); a prvalue evaluates to its
 * value. The type is never a reference type: a reference denotes the object it refers to, as an lvalue.
 */
export interface Expr {
  type: Type;
  isLvalue: boolean;
  run: Eval<Value | Ptr>;
  row: number;
  /** The value of a constant expression of arithmetic type, which array lengths and `case` labels need. */
  constant?: number | bigint;
  /** Reads a static member's integral constant without requiring its addressable definition. */
  readConstant?: Eval<Value>;
  /** The factors of a floating-point product, which an addition or subtraction using it fuses (`a * b + c`). */
  product?: { left: Eval<number>; right: Eval<number> };
  /** Whether the expression is a null pointer constant: `nullptr`, or an integer literal whose value is zero. */
  isNullConstant?: boolean;
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
