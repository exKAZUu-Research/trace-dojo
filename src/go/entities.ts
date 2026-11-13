import type { FunctionDeclaration, Span } from './ast';
import type { Constant } from './constants';
import type { StaticValue, Storage } from './operand';
import type { FunctionInfo, LocalInfo, StackBuffers } from './runtime';
import type { SliceTracking } from './slicePass';
import type { SsaValues } from './ssaValues';
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
   * to an interface, stores it elsewhere, returns it, passes it to a function that keeps it, or lets a pointer or a
   * closure that refers to it do so.
   */
  escapes?: boolean;
  /** Whether the variable's value may reach the caller as a result, which escapes unless Go inlines the call. */
  returned?: boolean;
  /** Whether the program may write the elements of the array the variable's slice refers to. */
  written?: boolean;
  /** Local variables whose storage this variable's value may share, which escape and are written with it. */
  escapeSources?: Set<VarEntity>;
  /** Temporary allocations this variable's value may refer to, which escape and are written with it. */
  temporaries?: Set<Temporary>;
  /** For a parameter, the arguments of calls, which share what the body does with it. */
  arguments?: { argument: Storage; result: VarEntity }[];
  /** How Go's slice optimization pass sees a local slice variable whose elements fit its stack buffer. */
  slice?: SliceTracking;
  /** Whether a closure refers to the variable. */
  captured?: boolean;
  /** Whether the program has defined the variable, and whether it assigns it after the declaration. */
  defined?: boolean;
  reassigned?: boolean;
  /** What the variable's first definition resolves to, which `staticValueOf` gives while it stays the only one. */
  static?: StaticValue;
  /** Whether the program takes the address of the variable or of a part of it, which keeps it out of registers. */
  addressTaken?: boolean;
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
  direct?: (args: Value[], callRow: number | undefined, stackBuffers?: StackBuffers) => Value | Value[];
  /** What calls learn from the body of a function the program declares. */
  summary?: CalleeSummary;
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
  /** The receiver and parameters. */
  params: VarEntity[];
  /** Stands for the caller, which receives the values of `return` statements. */
  resultHolder?: VarEntity;
  /** What calls learn from the body, for a function or method the program declares. */
  summary?: CalleeSummary;
  /** The result types and, for named results, their variables. */
  results: Type[];
  resultVariables: (VarEntity | undefined)[];
  hasNamedResults: boolean;
  /** The approximate cost Go's inliner assigns to the body, apart from the functions of the program it calls. */
  inlineCost: number;
  /** The functions of the program that the body calls, whose inlining decides the rest of its cost. */
  callees: StaticCallee[];
  /** What each `return` statement's value resolves to, for a function with one unnamed result. */
  returnedValues: (StaticValue | undefined)[];
  /** Runs once the top-level function the body lies in has compiled, which settles every `StaticCallee` in it. */
  onComplete: (() => void)[];
  /** How many calls of each function literal the body has that Go's compiler resolves. */
  closureCalls: Map<CalleeSummary, number>;
  /** Whether the body uses something Go's inliner refuses, such as `defer` or `recover`. */
  notInlinable: boolean;
  /** The package-level variables and functions that the body refers to, which decide initialization order. */
  references: Set<unknown>;
  /** The products the function computes, by the variables or constants they multiply. */
  products: Map<string, ProductSource>;
  /** Whether each float64 addition of two products adds them, which decides how Go's compiler orders operands. */
  sumsOfProducts: (() => boolean)[];
  ssa: SsaValues;
  loopDepth: number;
  breakDepth: number;
  recordsSteps: boolean;
}

/** A multiplication as Go's common subexpression elimination sees it: products of the same factors are one value. */
export interface ProductSource {
  /** The position of the value among the function's products, which follows the order Go's compiler creates them. */
  order: number;
  /** How many times the function computes it, where more than once makes it a value shared by several uses. */
  count: number;
}

/**
 * A value that Go's compiler allocates on the stack while it stays in the function, such as the array of `[]byte(s)`;
 * `written` records whether the program may change its elements.
 */
export interface Temporary {
  escapes: boolean;
  returned?: boolean;
  written: boolean;
}

type Effect = 'escapes' | 'returned' | 'written';
const EFFECTS: readonly Effect[] = ['escapes', 'returned', 'written'];

/** What Go's inliner charges for a call it does not inline (inlineExtraCallCost in cmd/compile/internal/inline). */
export const INLINE_CALL_COST = 57;
/** The largest cost of a function Go's inliner inlines (inlineMaxBudget). */
export const INLINE_BUDGET = 80;
/** The largest cost of a function literal Go's inliner inlines, at a call site that is its only one in the function. */
const INLINE_CLOSURE_BUDGET = 10 * INLINE_BUDGET;
/** The largest cost of a function literal Go's inliner inlines at other call sites (inlineCostOK). */
const INLINE_CLOSURE_SITE_BUDGET = 2 * INLINE_BUDGET;

/** What calls learn from the body of a function or method the program declares. */
export interface CalleeSummary {
  /** The receiver and parameters, once the body has compiled. */
  params?: VarEntity[];
  /** Links arguments of calls compiled before the body to the parameters. */
  pending: ((params: VarEntity[]) => void)[];
  /** Whether Go's compiler inlines calls of the function, which only the finished program decides. */
  inlinable: () => boolean;
  /** The approximate cost Go's inliner assigns to the function, including the functions it inlines into it. */
  cost: () => number;
  /** The compiled body. */
  context?: FunctionContext;
  /** Whether the function is a function literal, whose calls Go's inliner gives a larger budget. */
  closure?: boolean;
}

/**
 * A function of the program that a call reaches as Go's compiler resolves its callee (ir.StaticValue): a declared
 * function or method, a function literal, or a local variable holding one of them.
 */
export interface StaticCallee {
  summary: CalleeSummary;
  /**
   * Whether the callee stays the call's: false once the program assigns again or addresses a variable it was read
   * through, which is final when the top-level function the call lies in has compiled.
   */
  holds: () => boolean;
  /** For a call of a function literal, how many calls of it the calling function has that Go's compiler resolves. */
  sites?: Map<CalleeSummary, number>;
}

export const always = (): boolean => true;
export const never = (): boolean => false;

/** Whether Go's compiler inlines a call of `callee`. */
export function inlinedCall(callee: StaticCallee): boolean {
  const { summary, sites } = callee;
  if (!callee.holds() || !summary.inlinable()) return false;
  return !sites || sites.get(summary) === 1 || summary.cost() <= INLINE_CLOSURE_SITE_BUDGET;
}

/**
 * What a read of a local variable resolves to: its first definition's value while the program neither assigns the
 * variable again nor addresses it. `inOwner` tells whether the read runs in the frame defining the variable, whose
 * inlined call decides the constants that depend on parameters.
 */
export function staticValueOf(variable: VarEntity, inOwner: boolean): StaticValue | undefined {
  const { static: value } = variable;
  if (!value || variable.owner === undefined) return undefined;
  const holds = (): boolean => !variable.reassigned && !variable.addressTaken;
  const { constant, callee } = value;
  return {
    constant: constant && ((params) => holds() && constant(inOwner ? params : undefined)),
    callee: callee && { summary: callee.summary, holds: () => holds() && callee.holds() },
  };
}

export function newCalleeSummary(): CalleeSummary {
  return { pending: [], inlinable: () => false, cost: () => INLINE_CALL_COST };
}

/**
 * Fills in what calls learn from a compiled body: its parameters, linking the arguments waiting for them, and whether
 * Go's compiler inlines it, which it refuses for a `recursive` function and allows a function literal more for.
 */
export function completeCalleeSummary(
  summary: CalleeSummary,
  fn: FunctionContext,
  recursive: () => boolean,
  closure = false
): void {
  summary.closure = closure;
  const budget = closure ? INLINE_CLOSURE_BUDGET : INLINE_BUDGET;
  summary.context = fn;
  summary.params = fn.params;
  for (const link of summary.pending) link(fn.params);
  summary.pending = [];
  let cost: number | undefined;
  let computing = false;
  let inlinable: boolean | undefined;
  summary.cost = () => {
    if (cost !== undefined) return cost;
    // A function reaching itself through function literals costs more than any budget.
    if (computing) return Number.POSITIVE_INFINITY;
    computing = true;
    cost = fn.callees.reduce(
      (total, callee) => total + (inlinedCall(callee) ? callee.summary.cost() : INLINE_CALL_COST),
      fn.inlineCost
    );
    return cost;
  };
  summary.inlinable = () => (inlinable ??= !fn.notInlinable && !recursive() && summary.cost() <= budget);
}

export function markEscapes(entity: VarEntity): void {
  markEffect(entity, 'escapes');
}

export function markReturned(entity: VarEntity): void {
  markEffect(entity, 'returned');
}

export function markWritten(entity: VarEntity): void {
  markEffect(entity, 'written');
}

function markEffect(entity: VarEntity, effect: Effect): void {
  if (entity[effect]) return;
  entity[effect] = true;
  if (entity.temporaries) {
    for (const temporary of entity.temporaries) temporary[effect] = true;
  }
  if (entity.escapeSources) {
    for (const source of entity.escapeSources) markEffect(source, effect);
  }
  if (entity.arguments) {
    for (const { argument, result } of entity.arguments) applyToArgument(effect, argument, result);
  }
}

/**
 * Makes an argument share what the callee's body does with the parameter `param`: a parameter the callee returns makes
 * the argument part of `result`, which stands for the call's result in the caller.
 */
export function linkArgument(param: VarEntity, argument: Storage, result: VarEntity): void {
  (param.arguments ??= []).push({ argument, result });
  for (const effect of EFFECTS) if (param[effect]) applyToArgument(effect, argument, result);
}

function applyToArgument(effect: Effect, argument: Storage, result: VarEntity): void {
  if (effect === 'returned') {
    for (const source of argument.backingVars ?? []) linkEscapeSource(source, result);
    if (argument.nonEscaping) linkTemporary(argument.nonEscaping, result);
    return;
  }
  for (const source of argument.backingVars ?? []) markEffect(source, effect);
  if (argument.nonEscaping) argument.nonEscaping[effect] = true;
}

/** Whether a variable's or a temporary's storage stays in the call `frame` runs, as Go's escape analysis decides. */
export function staysLocal(storage: VarEntity | Temporary, frame: { resultStaysLocal: boolean }): boolean {
  return !storage.escapes && (!storage.returned || frame.resultStaysLocal);
}

/** Makes `source` share what happens to `target`, whose value may refer to `source`'s storage. */
export function linkEscapeSource(source: VarEntity, target: VarEntity): void {
  if (source === target) return;
  (target.escapeSources ??= new Set()).add(source);
  for (const effect of EFFECTS) if (target[effect]) markEffect(source, effect);
}

/** Makes a temporary allocation share what happens to `target`, whose value may refer to it. */
export function linkTemporary(temporary: Temporary, target: VarEntity): void {
  (target.temporaries ??= new Set()).add(temporary);
  for (const effect of EFFECTS) if (target[effect]) temporary[effect] = true;
}
