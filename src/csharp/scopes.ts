import type { TypeContext } from './binderBase';
import { type LocalSymbol, type MethodSymbol, type NamedType, type Type } from './types';

/** The function whose body is being bound: a method, an accessor, a lambda, or a local function. */
export class FunctionScope {
  /** The types that the `return` statements of a lambda return, from which its return type is inferred. */
  readonly returnTypes: Type[] = [];
  /** Whether a `return` statement returned a value, for lambdas whose return type is inferred. */
  returnsValue = false;
  /** The locals of enclosing functions that this function reads or writes. */
  readonly captures = new Set<LocalSymbol>();
  /** How many loops and switch statements enclose the statement being bound, which `break` may leave. */
  breakDepth = 0;
  /** How many loops enclose the statement being bound, which `continue` may continue. */
  continueDepth = 0;
  /** How many catch clauses enclose the statement being bound, where `throw;` may rethrow. */
  catchDepth = 0;
  /** How many finally blocks enclose the statement being bound, which control may not leave. */
  finallyDepth = 0;

  // code-gauge-allow functionParameterCount -- The values that the operation needs, which share no object.
  constructor(
    readonly method: MethodSymbol,
    readonly outer: FunctionScope | undefined,
    readonly typeContext: TypeContext,
    /** The return type, or undefined for a lambda whose return type is being inferred. */
    public returnType: Type | undefined,
    /** Whether `this` is unavailable, as in static members and static lambdas. */
    readonly isStatic: boolean,
    /** The type that `this` has, in instance members. */
    readonly thisType: NamedType | undefined,
    readonly kind: 'member' | 'lambda' | 'localFunction' | 'initializer'
  ) {}

  get locals(): LocalSymbol[] {
    return this.method.locals;
  }

  addLocal(local: LocalSymbol): void {
    local.slot = this.method.locals.length;
    local.owner = this.method;
    this.method.locals.push(local);
  }
}

/** A block's names: its locals and local functions, and the names declared later in it, which may not be used yet. */
export class LocalScope {
  readonly variables = new Map<string, LocalSymbol>();
  readonly localFunctions = new Map<string, MethodSymbol>();
  /** The names a block declares anywhere in it, which hide outer names from its start. */
  readonly declaredLater = new Set<string>();
  readonly locals: LocalSymbol[] = [];

  constructor(
    readonly parent: LocalScope | undefined,
    readonly owner: FunctionScope
  ) {}

  /** Finds a name from the innermost scope out, telling which function's scope holds it. */
  lookup(
    name: string
  ): { local?: LocalSymbol; localFunction?: MethodSymbol; scope: LocalScope; isDeclaredLater: boolean } | undefined {
    for (const scope of this.chain()) {
      const local = scope.variables.get(name);
      if (local) return { local, scope, isDeclaredLater: false };
      const localFunction = scope.localFunctions.get(name);
      if (localFunction) return { localFunction, scope, isDeclaredLater: false };
      if (scope.declaredLater.has(name)) return { scope, isDeclaredLater: true };
    }
    return undefined;
  }

  /** This scope and the scopes around it, innermost first. */
  *chain(): Generator<LocalScope> {
    yield this;
    for (let scope = this.parent; scope; scope = scope.parent) yield scope;
  }

  /**
   * Whether an enclosing scope of the same function declares the name. A lambda's or local function's locals and
   * parameters may hide an enclosing function's (since C# 8).
   */
  isDeclaredOutside(name: string): boolean {
    for (let scope = this.parent; scope && scope.owner === this.owner; scope = scope.parent) {
      if (scope.variables.has(name) || scope.localFunctions.has(name)) return true;
    }
    return false;
  }
}
