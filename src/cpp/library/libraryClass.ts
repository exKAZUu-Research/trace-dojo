import type { Expr, Initializer } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import type { Syntax } from '../syntax';
import type { ArrayType, ClassInfo, FunctionInfo, Type } from '../types';
import type { CObject, Value } from '../values';

export type IteratorCategory = 'forward' | 'bidirectional' | 'randomAccess';

/** What the library provides for a class besides its members: its operators and its layout. */
export interface LibraryClass {
  /** The class template or class, such as `vector` or `string`. */
  readonly kind: string;
  readonly args: readonly Type[];
  readonly ownedTypes?: readonly Type[];
  readonly assignmentCopies?: boolean;
  readonly allowsConstantCopy?: boolean;
  readonly aggregateArray?: { type: ArrayType; make: (items: Value[]) => Value };
  readonly additionalPublicBases?: readonly ClassInfo[];
  /** `sizeof` of the class in libc++ on arm64. */
  readonly size: number;
  readonly align: number;
  /**
   * Compiles an operator whose operands include an object of this class, such as `s + t`, `*it`, or `cout << x`, or
   * gives undefined when the class has no such operator for these operands. Unary operators get one operand;
   * postfix `++` and `--` are `x++` and `x--`.
   */
  operator?: (compiler: ExpressionCompiler, operator: string, operands: Expr[], row: number) => Expr | undefined;
  /** Compiles a call of the object, as a function object such as `std::greater<int>` allows. */
  call?: (compiler: ExpressionCompiler, object: Expr, args: Expr[], row: number) => Expr | undefined;
  /**
   * Compiles list-initialization (`std::vector<int> v = {1, 2};`) when the class has an `std::initializer_list`
   * constructor that takes the elements, or gives undefined to initialize through the other constructors.
   */
  listInitializer?: (compiler: ExpressionCompiler, elements: Syntax[], row: number) => Initializer | undefined;
  defaultInitializer?: (compiler: ExpressionCompiler, row: number, valueInitialize: boolean) => Expr['run'];
  /**
   * Compiles a call of a member function that constructs an element from its arguments, such as `emplace_back`,
   * or gives undefined for an ordinary member function.
   */
  memberCall?: (
    compiler: ExpressionCompiler,
    object: Expr,
    name: string,
    args: Expr[],
    row: number
  ) => Expr | undefined;
  /** The member functions `memberCall` compiles. */
  constructingMembers?: readonly string[];
  /** The operation of a function object such as `std::greater<int>` on two values of a type, if it applies. */
  apply?: (left: Type, right: Type) => ((a: Value, b: Value) => Value) | undefined;
  /** Whether an iterator goes backward, as `std::reverse_iterator` does. */
  isReverse?: boolean;
  /** The category of an iterator, which decides its operators and the algorithms that accept it. */
  iteratorCategory?: IteratorCategory;
  appendMethod?: FunctionInfo;
  /** Whether a program's class may derive from this one, as from the exception classes. */
  isInheritable?: boolean;
}

/** How objects of a class are copied, assigned, and destroyed, which the compiler or the library provides. */
export interface ClassOperations {
  /** Copies an object, as the copy constructor does. */
  copy: (frame: Frame, source: Value, destination?: CObject) => Value;
  /**
   * Assigns an object's value to another existing object, as the copy assignment operator does: in place, or, for an
   * object that is an immutable value (an iterator), by giving the value that replaces the target.
   */
  assign: (frame: Frame, target: Value, source: Value) => Value | void;
  /** Runs the destructor of an object and of its members, when one of them has any effect. */
  destroy?: (frame: Frame, object: Value) => void;
}
