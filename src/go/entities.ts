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
  /** Whether the variable's value leaves the function through a `return` statement. */
  escapesViaReturn?: boolean;
  /** Weighted count of `s = append(s, ...)` writes, as Go's slice optimization pass counts them. */
  appendWeight?: number;
  /** Local variables whose backing storage may be shared by this variable's value. */
  escapeSources?: Set<VarEntity>;
  /** Callbacks to run if this variable's value escapes (`viaReturn` distinguishes return-only escape). */
  escapeHooks?: ((viaReturn: boolean) => void)[];
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
  direct?: (args: Value[], callRow: number | undefined, resultStaysOnStack?: boolean) => Value | Value[];
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
  returnHolders: VarEntity[];
  hasNamedResults: boolean;
  hasDefer: boolean;
  nodeCount: number;
  /** The package-level variables and functions that the body refers to, which decide initialization order. */
  references: Set<unknown>;
  /** The order in which the function first computes each product, by the variables or constants it multiplies. */
  productOrders: Map<string, number>;
  loopDepth: number;
  breakDepth: number;
  recordsSteps: boolean;
}

export function markEscapes(entity: VarEntity): void {
  if (entity.escapes) return;
  entity.escapes = true;
  if (entity.escapeHooks) {
    for (const hook of entity.escapeHooks) hook(false);
    entity.escapeHooks = undefined;
  }
  if (entity.escapeSources) {
    for (const source of entity.escapeSources) markEscapes(source);
  }
}

export function markEscapesViaReturn(entity: VarEntity, seen = new Set<VarEntity>()): void {
  if (seen.has(entity)) return;
  seen.add(entity);
  entity.escapesViaReturn = true;
  if (entity.escapeHooks) {
    for (const hook of entity.escapeHooks) hook(true);
  }
  if (entity.escapeSources) {
    for (const source of entity.escapeSources) markEscapesViaReturn(source, seen);
  }
}

export function linkEscapeSource(source: VarEntity, target: VarEntity): void {
  if (source === target) return;
  if (target.escapes) {
    markEscapes(source);
    return;
  }
  (target.escapeSources ??= new Set()).add(source);
}

export function linkEscapeHook(hook: (viaReturn: boolean) => void, target: VarEntity): void {
  if (target.escapes) {
    hook(false);
    return;
  }
  (target.escapeHooks ??= []).push(hook);
}
