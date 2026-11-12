import type { FunctionDeclaration, Span } from './ast';
import type { Constant } from './constants';
import type { FunctionInfo, LocalInfo } from './runtime';
import type { FuncType, NamedType, Type, TypeParamType } from './types';
import type { GoFunc, Value } from './values';

/** What a name in scope refers to. */
export type Entity =
  | VarEntity
  | ConstEntity
  | TypeEntity
  | FuncEntity
  | { kind: 'builtin'; name: string }
  | PackageEntity
  | { kind: 'nil' };

export interface VarEntity {
  kind: 'var';
  name: string;
  type: Type;
  span: Span;
  used: boolean;
  /** Whether a closure or a pointer may share the variable, so that it lives in a cell. */
  boxed: boolean;
  /** The function whose frame holds the variable, or undefined for a package-level variable. */
  owner: FunctionContext | undefined;
  /** The slot in the owner's frame, or the index in the package's globals. */
  slot: number;
  /** For a package-level variable whose initializer has not been compiled yet. */
  pending?: () => void;
  /** For a library variable, such as `os.Stdout`, which programs read but do not assign. */
  library?: () => Value;
  local?: LocalInfo;
  /** A type switch's variable, whose use the switch checks across all its clauses. */
  quiet?: boolean;
  /**
   * Whether the variable's value may outlive the function, as Go's escape analysis decides: the program converts it
   * to an interface, stores it elsewhere, returns it, passes it to a function, or captures or takes its address.
   */
  escapes?: boolean;
  /** The number of assignments after the declaration, which decide whether the declared value reaches each use. */
  writes?: number;
  /**
   * The hidden slots holding the factors of the multiplication that initialized the variable, which a later addition
   * fuses with, as Go's compiler does through a variable whose value comes from that single definition.
   */
  productFactors?: { left: number; right: number; order: number };
  /** Whether the declaration's value is a constant to Go's compiler. */
  definedAsConstant?: () => boolean;
}

export interface ConstEntity {
  kind: 'const';
  name: string;
  type: Type;
  value: Constant;
  span: Span;
  used: boolean;
  /** For a package-level constant whose value has not been computed yet. */
  pending?: () => void;
}

export interface TypeEntity {
  kind: 'type';
  name: string;
  type: Type;
  span?: Span;
  /** A generic type, which must be instantiated before use. */
  generic?: GenericType;
}

export interface GenericType {
  typeParams: TypeParamType[];
  instantiate(args: Type[], span: Span): NamedType;
}

export interface FuncEntity {
  kind: 'func';
  name: string;
  type: FuncType;
  span?: Span;
  /** The function value, for a call through a variable or a deferred call. */
  value(): GoFunc;
  /** Calls the function directly, which skips creating a function value. */
  direct?: (args: Value[], callRow: number | undefined) => Value | Value[];
  /** Calls the function directly as `direct` does, yielding when its goroutine blocks; absent when it never blocks. */
  directResume?: (
    args: Value[],
    callRow: number | undefined
  ) => Generator<{ reason: string }, Value | Value[], unknown>;
  generic?: GenericFunc;
  declaration?: FunctionDeclaration;
}

/** A generic function, from the program or the library, whose instances the compiler creates on demand. */
export interface GenericFunc {
  typeParams: TypeParamType[];
  /** The signature in terms of the type parameters. */
  type: FuncType;
  instantiate(args: Type[]): GoFunc;
}

export interface PackageEntity {
  kind: 'package';
  name: string;
  package: GoPackage;
  span: Span;
  used: boolean;
}

/** A library package: its exported functions, variables, constants, and types. */
export interface GoPackage {
  path: string;
  name: string;
  members: Map<string, Entity>;
  /** Members this environment does not provide, which are rejected rather than reported as undefined. */
  unsupported?: ReadonlySet<string>;
  /** A package this environment does not provide, whose uses report nothing more than its import did. */
  unavailable?: boolean;
}

/** The compile-time state of one function body. */
export interface FunctionContext {
  info: FunctionInfo;
  parent: FunctionContext | undefined;
  /** The variables of enclosing functions that this function captures, by their index in its cells. */
  captures: Map<VarEntity, number>;
  /** The result types and, for named results, their variables. */
  results: Type[];
  resultVariables: (VarEntity | undefined)[];
  hasNamedResults: boolean;
  /** The package-level variables and functions that the body refers to, which decide initialization order. */
  references: Set<unknown>;
  /** The order in which the function first computes each product, by the variables or constants it multiplies. */
  productOrders: Map<string, number>;
  loopDepth: number;
  breakDepth: number;
  recordsSteps: boolean;
}
