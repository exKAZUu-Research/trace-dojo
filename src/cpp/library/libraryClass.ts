import type { Expr, Initializer } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import type { Frame } from '../runtime';
import type { Syntax } from '../syntax';
import type { ArithmeticType, ArrayType, ClassInfo, Type } from '../types';
import type { ArrayStore, CObject, Value } from '../values';

export type IteratorCategory = 'forward' | 'bidirectional' | 'randomAccess';

/** What the library provides for a class besides its members: its operators and its layout. */
export type LibraryClass = LibraryMembers & (LibraryLayout | { readonly layoutFromFields: true });

interface LibraryLayout {
  readonly layoutFromFields?: false;
  readonly size: number;
  readonly align: number;
  readonly fieldOffsets?: readonly number[];
}

interface LibraryMembers {
  /** The class template or class, such as `vector` or `string`. */
  readonly kind: string;
  readonly args: readonly Type[];
  readonly ownedTypes?: readonly Type[];
  readonly inlineElementType?: Type;
  readonly ownedCopyFromConst?: boolean;
  readonly elementUseOnAssignment?: 'copy' | 'assign-and-copy';
  readonly allowsConstantCopy?: boolean;
  readonly scalarValue?: { type: ArithmeticType; read: (value: Value) => number | bigint };
  readonly aggregateArray?: { type: ArrayType; make: (storage: ArrayStore) => Value };
  readonly additionalPublicBases?: readonly ClassInfo[];
  /** Whether the classes deriving from this one inherit it virtually, as libc++'s streams inherit `std::ios`. */
  readonly isVirtualBase?: boolean;
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
  listInitializer?: (compiler: ExpressionCompiler, elements: readonly Syntax[], row: number) => Initializer | undefined;
  readonly listElementType?: Type;
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
  apply?: (left: Type, right: Type) => ((a: Value, b: Value, frame?: Frame) => Value) | undefined;
  /** Whether an iterator goes backward, as `std::reverse_iterator` does. */
  isReverse?: boolean;
  /** The category of an iterator, which decides its operators and the algorithms that accept it. */
  iteratorCategory?: IteratorCategory;
  readonly iteratorFamily?: string;
  readonly iteratorReference?: Type;
  readonly valueInitializedMembers?: readonly Type[];
  outputContainer?: Type;
  /** Whether a program's class may derive from this one, as from the exception classes. */
  isInheritable?: boolean;
}

/** How objects of a class are copied, assigned, and destroyed, which the compiler or the library provides. */
export interface ClassOperations {
  /** Copies an object, as the copy constructor does. */
  copy: (frame: Frame, source: Value, destination?: CObject, sourceIsConst?: boolean) => Value;
  readonly copyIsNoexcept?: boolean;
  /**
   * Assigns an object's value to another existing object, as the copy assignment operator does: in place, or, for an
   * object that is an immutable value (an iterator), by giving the value that replaces the target.
   */
  assign: (frame: Frame, target: Value, source: Value) => Value | void;
  /** Runs the destructor of an object and of its members, when one of them has any effect. */
  destroy?: (frame: Frame, object: Value) => void;
}
