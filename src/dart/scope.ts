import type { Span } from './ast';
import type { ClassInfo } from './classes';
import type { Eval } from './compilerBase';
import type { FunctionInfo, TypeEnv } from './runtime';
import { type DartType, type FunctionType, type InterfaceType, isSubtype, sameType, type TypeParam } from './types';
import type { Value } from './values';

let nextLocalId = 0;

/** What a condition told flow analysis: whether its branch is reachable and the variables it promoted. */
export interface StoredFlow {
  reachable: boolean;
  promotions: readonly (readonly [LocalVar, readonly DartType[]])[];
}

export class LocalVar {
  readonly id = nextLocalId++;
  unavailable: string | undefined;
  inPatternGuard = false;
  fieldReceiver?: LocalVar;
  hasAssignment = false;
  /** Assigned inside a closure, which stops Dart from promoting it. */
  isWriteCaptured = false;
  /** Read inside a closure. */
  isCaptured = false;
  /** A primitive value a `const` local holds. */
  constant: Value | undefined;
  constantInitializer: Eval | undefined;
  /**
   * For a bool local initialized with a condition (`final ok = x != null;`), what the condition told flow analysis
   * when true and when false, which `if (ok)` applies again as Dart does.
   */
  condition: { whenTrue: StoredFlow; whenFalse: StoredFlow } | undefined;
  hasConstant = false;

  constructor(
    readonly syntax: Span,
    readonly name: string,
    readonly type: DartType,
    readonly slot: number,
    readonly owner: FunctionContext,
    readonly options: {
      isFinal: boolean;
      isLate: boolean;
      isConst: boolean;
      isParameter: boolean;
      hasInitializer: boolean;
    }
  ) {}
}

export interface JumpTarget {
  kind: 'loop' | 'switch' | 'label';
  labels: readonly string[];
  breakFlow?: Flow;
  continueFlow?: Flow;
}

/** A function being compiled: its slots, the variables it captures, and what `return` and `this` mean in it. */
export class FunctionContext {
  slotCount = 0;
  /** The outer variables the function captures, in the order of its captured cells. */
  readonly captures: LocalVar[] = [];
  readonly scopes: Map<string, LocalVar>[] = [new Map()];
  /** The labels in scope, innermost last, with whether each names a loop or switch that `continue` may target. */
  readonly labels: { name: string; isLoop: boolean; isSwitchCase: boolean }[] = [];
  readonly jumpTargets: JumpTarget[] = [];
  loopDepth = 0;
  switchDepth = 0;
  assignments: ReadonlyMap<Span, ReadonlySet<string>> = new Map();
  capturedAssignments: ReadonlyMap<Span, ReadonlySet<string>> = new Map();
  /** The type of the value each `return` gives, collected to infer a closure's return type. */
  returnTypes: DartType[] | undefined;
  /** For `sync*` functions, the type of the elements `yield` gives. */
  yieldTypes: DartType[] | undefined;
  /** The catch clause's exception variables in scope, which `rethrow` needs. */
  catchDepth = 0;
  /** The return type a closure's context expects, which its `return` statements are checked against. */
  contextReturn: DartType | undefined;
  /** The element type a `sync*` function's return type gives its `yield` statements. */
  yieldElement: DartType | undefined;

  /** The name the VM gives the function in errors, as `main.<anonymous closure>` or `A.m`. */
  get qualifiedName(): string {
    const { name } = this.info;
    if (this.parent) return `${this.parent.qualifiedName}.${name}`;
    const cls = this.kind.thisClass;
    return cls && name !== cls.name && !name.startsWith(`${cls.name}.`) ? `${cls.name}.${name}` : name;
  }

  constructor(
    readonly parent: FunctionContext | undefined,
    readonly info: FunctionInfo,
    readonly kind: {
      /** The declared or contextual return type, or undefined for a closure whose return type is inferred. */
      returnType: DartType | undefined;
      isGenerator: boolean;
      /** The class whose members `this` reaches, for methods, constructors, and closures inside them. */
      thisClass: ClassInfo | undefined;
      thisType: InterfaceType | undefined;
      /** Whether `this` is available (instance members and generative constructors). */
      hasThis: boolean;
      /** The extension a member belongs to, whose `this` is the extended value. */
      extensionOn: DartType | undefined;
      /** In a constructor's initializer list, where `this` is unavailable. */
      isInitializer: boolean;
      isConstructor: boolean;
    }
  ) {}

  allocateSlot(): number {
    return this.slotCount++;
  }
}

/** What flow analysis knows at a point of a function: reachability, promotions, and definite assignment. */
export class Flow {
  constructor(
    readonly reachable: boolean,
    readonly promotions: ReadonlyMap<LocalVar, readonly DartType[]>,
    /** Variables definitely assigned. */
    readonly assigned: ReadonlySet<LocalVar>,
    /** Variables possibly assigned, for `final` and `late final` checks. */
    readonly maybeAssigned: ReadonlySet<LocalVar>
  ) {}

  static start(): Flow {
    return new Flow(true, new Map(), new Set(), new Set());
  }

  get unreachable(): Flow {
    return new Flow(false, this.promotions, this.assigned, this.maybeAssigned);
  }

  promote(variable: LocalVar, type: DartType): Flow {
    const existing = this.promotions.get(variable) ?? [];
    const current = existing.at(-1);
    if (current && sameType(type, current)) return this;
    const chain = existing.filter((earlier) => !sameType(type, earlier) && isSubtype(type, earlier));
    chain.push(type);
    return new Flow(
      this.reachable,
      new Map([...this.promotions, [variable, chain]]),
      this.assigned,
      this.maybeAssigned
    );
  }

  demote(variable: LocalVar): Flow {
    const promotions = new Map(this.promotions);
    forgetPromotions(promotions, new Set([variable]));
    if (promotions.size === this.promotions.size) return this;
    return new Flow(this.reachable, promotions, this.assigned, this.maybeAssigned);
  }

  assign(variable: LocalVar): Flow {
    return new Flow(
      this.reachable,
      this.promotions,
      new Set([...this.assigned, variable]),
      new Set([...this.maybeAssigned, variable])
    );
  }

  /** Forgets what `variables` held, as a loop that may assign them does at its start. */
  forget(variables: Iterable<LocalVar>): Flow {
    const promotions = new Map(this.promotions);
    const names = new Set(variables);
    forgetPromotions(promotions, names);
    const maybeAssigned = new Set([...this.maybeAssigned, ...names]);
    return new Flow(this.reachable, promotions, this.assigned, maybeAssigned);
  }

  /** What is known after two paths meet. */
  static join(a: Flow, b: Flow): Flow {
    if (!a.reachable)
      return b.reachable
        ? b
        : new Flow(false, b.promotions, intersect(a.assigned, b.assigned), union(a.maybeAssigned, b.maybeAssigned));
    if (!b.reachable) return a;
    const promotions = new Map<LocalVar, readonly DartType[]>();
    for (const [variable, chain] of a.promotions) {
      const other = b.promotions.get(variable);
      if (!other) continue;
      const shared = chain.filter((type) => other.some((candidate) => sameType(type, candidate)));
      if (shared.length > 0) promotions.set(variable, shared);
    }
    return new Flow(true, promotions, intersect(a.assigned, b.assigned), union(a.maybeAssigned, b.maybeAssigned));
  }
}

function intersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) if (b.has(item)) result.add(item);
  return result;
}

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const result = new Set(a);
  for (const item of b) result.add(item);
  return result;
}

/** A condition's flow when it is true and when it is false. */
export interface ConditionFlow {
  whenTrue: Flow;
  whenFalse: Flow;
}

export type { FunctionType, TypeEnv, TypeParam };

function forgetPromotions(promotions: Map<LocalVar, readonly DartType[]>, roots: ReadonlySet<LocalVar>): void {
  for (const variable of promotions.keys()) {
    for (let current: LocalVar | undefined = variable; current; current = current.fieldReceiver) {
      if (roots.has(current)) {
        promotions.delete(variable);
        break;
      }
    }
  }
}
