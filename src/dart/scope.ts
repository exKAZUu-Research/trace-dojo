import type { BodyModifier, Span } from './ast';
import type { ClassInfo } from './classes';
import type { Eval } from './compilerBase';
import type { FunctionInfo, TypeEnv } from './runtime';
import {
  type DartType,
  type FunctionType,
  type InterfaceType,
  isSubtype,
  nonNullable,
  sameType,
  type TypeParam,
} from './types';
import type { Value } from './values';

let nextLocalId = 0;

type TypeTests = ReadonlyMap<LocalVar, readonly DartType[]>;

interface StoredFlow {
  reachable: boolean;
  promotions: readonly (readonly [LocalVar, readonly DartType[]])[];
  testedTypes: TypeTests;
}

export class LocalVar {
  readonly id = nextLocalId++;
  unavailable: string | undefined;
  /** Why the local cannot be written here, such as a primary constructor parameter in a field initializer. */
  writeError: string | undefined;
  inPatternGuard = false;
  fieldReceiver?: LocalVar;
  hasAssignment = false;
  /** A nested function might assign this local somewhere in its enclosing function. */
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

/** A primary constructor parameter as field initializers see it: readable but never assignable. */
export function primaryParameterInInitializer(variable: LocalVar): LocalVar {
  const view = new LocalVar(variable.syntax, variable.name, variable.type, variable.slot, variable.owner, {
    ...variable.options,
    isFinal: true,
  });
  view.writeError = `プライマリコンストラクタの引数 ${variable.name} には、初期化子の中で代入できません。`;
  return view;
}

export class LocalScope {
  readonly names = new Map<string, LocalVar>();
  readonly slots: number[] = [];
  pending: ReadonlySet<string> | undefined;
}

/** A function being compiled: its slots, the variables it captures, and what `return` and `this` mean in it. */
export class FunctionContext {
  slotCount = 0;
  /** The outer variables the function captures, in the order of its captured cells. */
  readonly captures: LocalVar[] = [];
  readonly scopes = [new LocalScope()];
  /** The labels in scope, innermost last, with whether each names a loop or switch that `continue` may target. */
  readonly labels: { name: string; isLoop: boolean; isSwitchCase: boolean }[] = [];
  readonly jumpTargets: JumpTarget[] = [];
  loopDepth = 0;
  switchDepth = 0;
  assignments: ReadonlyMap<Span, ReadonlySet<string>> = new Map();
  capturedAssignments: ReadonlyMap<Span, ReadonlySet<string>> = new Map();
  /**
   * The `return;` statements of a function literal that its context's nullable value type allows, which a `return`
   * with a value in the same function rules out, as the SDK requires.
   */
  readonly contextBareReturns: Span[] = [];
  returnsValue = false;
  /** The type of the value each `return` gives, collected to infer a closure's return type. */
  returnTypes: DartType[] | undefined;
  /** The values an `async` closure's `return`s give, checked against the future value it infers from them. */
  readonly inferredAsyncReturns: { type: DartType; span: Span }[] = [];
  /** For `sync*` functions, the type of the elements `yield` gives. */
  yieldTypes: DartType[] | undefined;
  /** The catch clause's exception variables in scope, which `rethrow` needs. */
  catchDepth = 0;
  /** The return type a closure's context expects, which its `return` statements are checked against. */
  contextReturn: DartType | undefined;
  /** What the body's end and its `return`s are checked against, decided once from the function's return type. */
  returnRule: ReturnRule = { checked: undefined, valueType: undefined, context: undefined, isAsync: false };
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
      /** Whether the body yields: `sync*` and `async*`. */
      isGenerator: boolean;
      /** Whether the body awaits: `async` and `async*`. */
      isAsync: boolean;
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

const NO_LOCALS: ReadonlySet<LocalVar> = new Set();

interface FlowFacts {
  writeCaptured: ReadonlySet<LocalVar>;
  conditions: ReadonlyMap<LocalVar, ReadonlySet<LocalVar>>;
  testedTypes: TypeTests;
}

const NO_FACTS: FlowFacts = { writeCaptured: NO_LOCALS, conditions: new Map(), testedTypes: new Map() };

/** What flow analysis knows at a point of a function: reachability, promotions, and definite assignment. */
export class Flow {
  constructor(
    readonly reachable: boolean,
    readonly promotions: ReadonlyMap<LocalVar, readonly DartType[]>,
    /** Variables definitely assigned. */
    readonly assigned: ReadonlySet<LocalVar>,
    /** Variables possibly assigned, for `final` and `late final` checks. */
    readonly maybeAssigned: ReadonlySet<LocalVar>,
    readonly writes?: ReadonlySet<LocalVar>,
    readonly facts: FlowFacts = NO_FACTS
  ) {}

  static start(): Flow {
    return new Flow(true, new Map(), new Set(), new Set());
  }

  get unreachable(): Flow {
    return new Flow(false, this.promotions, this.assigned, this.maybeAssigned, this.writes, this.facts);
  }

  get writeCaptured(): ReadonlySet<LocalVar> {
    return this.facts.writeCaptured;
  }

  forClosure(): Flow {
    const promotions = new Map([...this.promotions].filter(([variable]) => this.keepsValueInClosure(variable)));
    const conditions = filterConditions(this.facts.conditions, (local) => this.keepsValueInClosure(local));
    return new Flow(true, promotions, this.assigned, this.maybeAssigned, undefined, { ...this.facts, conditions });
  }

  private keepsValueInClosure(variable: LocalVar): boolean {
    return !affectedPath(variable, (part) => part.hasAssignment || part.isWriteCaptured);
  }

  rememberCondition(variable: LocalVar): Flow {
    if (!variable.condition) return this;
    const { whenTrue, whenFalse } = variable.condition;
    const dependencies = new Set([...whenTrue.promotions, ...whenFalse.promotions].map(([local]) => local));
    if (
      dependencies.size === 0 &&
      whenTrue.reachable &&
      whenFalse.reachable &&
      whenTrue.testedTypes.size === 0 &&
      whenFalse.testedTypes.size === 0
    )
      return this;
    const conditions = new Map([...this.facts.conditions, [variable, dependencies]]);
    return new Flow(this.reachable, this.promotions, this.assigned, this.maybeAssigned, this.writes, {
      ...this.facts,
      conditions,
    });
  }

  captureConditionBranch(before: Flow): StoredFlow {
    const promotions = [...this.promotions].filter(([variable, chain]) => before.promotions.get(variable) !== chain);
    const testedTypes = new Map<LocalVar, readonly DartType[]>();
    for (const [variable, types] of this.facts.testedTypes) {
      const prior = before.facts.testedTypes.get(variable) ?? [];
      if (prior === types) continue;
      const introduced = types.filter((type) => !prior.some((previous) => sameType(type, previous)));
      if (introduced.length > 0) testedTypes.set(variable, introduced);
    }
    return { reachable: this.reachable, promotions, testedTypes };
  }

  conditionFlowFor(variable: LocalVar, isPromotable: (local: LocalVar) => boolean): ConditionFlow | undefined {
    const dependencies = this.facts.conditions.get(variable);
    const { condition } = variable;
    if (!condition || !dependencies) return undefined;
    return {
      whenTrue: this.applyConditionBranch(condition.whenTrue, dependencies, isPromotable),
      whenFalse: this.applyConditionBranch(condition.whenFalse, dependencies, isPromotable),
    };
  }

  private applyConditionBranch(
    stored: StoredFlow,
    dependencies: ReadonlySet<LocalVar>,
    isPromotable: (local: LocalVar) => boolean
  ): Flow {
    let flow = this.withAddedTypeTests(stored.testedTypes);
    if (!stored.reachable) return flow.unreachable;
    for (const [local, chain] of stored.promotions) {
      if (!dependencies.has(local) || !isPromotable(local)) continue;
      for (const type of chain) {
        const current = flow.promotions.get(local)?.at(-1) ?? local.type;
        if (isSubtype(type, current)) flow = flow.promote(local, type);
      }
    }
    return flow;
  }

  withWrites(writes: ReadonlySet<LocalVar> | undefined): Flow {
    return new Flow(this.reachable, this.promotions, this.assigned, this.maybeAssigned, writes, this.facts);
  }

  restoreWrites(outer: ReadonlySet<LocalVar> | undefined): Flow {
    return this.withWrites(outer ? combineWrites(outer, this.writes) : undefined);
  }

  wrotePath(variable: LocalVar): boolean {
    return affectedPath(variable, (part) => this.writes?.has(part) ?? false);
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
      this.maybeAssigned,
      this.writes,
      this.facts
    );
  }

  rememberTypeTest(variable: LocalVar, type: DartType): Flow {
    const types = this.facts.testedTypes.get(variable) ?? [];
    if (types.some((tested) => sameType(type, tested))) return this;
    return this.withFacts({
      ...this.facts,
      testedTypes: new Map([...this.facts.testedTypes, [variable, [...types, type]]]),
    });
  }

  write(variable: LocalVar, type: DartType, promotable: boolean): Flow {
    const assigned = this.assign(variable);
    const promotions = new Map(assigned.promotions);
    forgetPromotions(promotions, new Set([variable]));
    if (promotable && type.kind !== 'dynamic') {
      const chain = this.promotions.get(variable)?.filter((prior) => isSubtype(type, prior)) ?? [];
      const provisional = chain.at(-1) ?? variable.type;
      const tested = this.facts.testedTypes.get(variable) ?? [];
      const narrowed = assignmentPromotion(variable.type, provisional, type, tested);
      if (narrowed) chain.push(narrowed);
      if (chain.length > 0) promotions.set(variable, chain);
    }
    return new Flow(
      assigned.reachable,
      promotions,
      assigned.assigned,
      assigned.maybeAssigned,
      assigned.writes,
      assigned.facts
    );
  }

  private withFacts(facts: FlowFacts): Flow {
    return new Flow(this.reachable, this.promotions, this.assigned, this.maybeAssigned, this.writes, facts);
  }

  assign(variable: LocalVar): Flow {
    return new Flow(
      this.reachable,
      this.promotions,
      new Set([...this.assigned, variable]),
      new Set([...this.maybeAssigned, variable]),
      this.writes ? new Set([...this.writes, variable]) : undefined,
      this.factsAfterWrites(new Set([variable]))
    );
  }

  /** Forgets what `variables` held, as a loop that may assign them does at its start. */
  forget(variables: Iterable<LocalVar>, captured: readonly LocalVar[] = []): Flow {
    const names = new Set([...variables, ...captured]);
    if (names.size === 0) return this;
    const promotions = new Map(this.promotions);
    forgetPromotions(promotions, names);
    const maybeAssigned = new Set([...this.maybeAssigned, ...names]);
    return new Flow(
      this.reachable,
      promotions,
      this.assigned,
      maybeAssigned,
      this.writes && union(this.writes, names),
      this.factsAfterWrites(names, captured)
    );
  }

  private factsAfterWrites(writes: ReadonlySet<LocalVar>, captured: readonly LocalVar[] = []): FlowFacts {
    return {
      ...this.facts,
      writeCaptured: captured.length > 0 ? new Set([...this.writeCaptured, ...captured]) : this.writeCaptured,
      conditions: filterConditions(this.facts.conditions, (local) => !affectedPath(local, (part) => writes.has(part))),
    };
  }

  /** What is known after two paths meet. */
  static join(a: Flow, b: Flow): Flow {
    if (!a.reachable)
      return b.reachable
        ? b.inheritTypeTests(a)
        : new Flow(
            false,
            b.promotions,
            intersect(a.assigned, b.assigned),
            union(a.maybeAssigned, b.maybeAssigned),
            combineWrites(a.writes, b.writes),
            joinFacts(a, b)
          );
    if (!b.reachable) return a.inheritTypeTests(b);
    const promotions = new Map<LocalVar, readonly DartType[]>();
    for (const [variable, chain] of a.promotions) {
      const other = b.promotions.get(variable);
      if (!other) continue;
      const shared = chain.filter((type) => other.some((candidate) => sameType(type, candidate)));
      if (shared.length > 0) promotions.set(variable, shared);
    }
    return new Flow(
      true,
      promotions,
      intersect(a.assigned, b.assigned),
      union(a.maybeAssigned, b.maybeAssigned),
      combineWrites(a.writes, b.writes),
      joinFacts(a, b)
    );
  }

  inheritTypeTests(other: Flow): Flow {
    return this.withAddedTypeTests(other.facts.testedTypes);
  }

  private withAddedTypeTests(types: TypeTests): Flow {
    const testedTypes = mergeTypeTests(this.facts.testedTypes, types);
    return testedTypes === this.facts.testedTypes ? this : this.withFacts({ ...this.facts, testedTypes });
  }
}

function assignmentPromotion(
  declared: DartType,
  provisional: DartType,
  written: DartType,
  tested: readonly DartType[]
): DartType | undefined {
  if (sameType(written, provisional)) return undefined;
  const interests = [nonNullable(declared), ...tested.flatMap((type) => [type, nonNullable(type)])];
  const compatible = interests.filter(
    (type) => !sameType(type, provisional) && isSubtype(written, type) && isSubtype(type, provisional)
  );
  return compatible.find((type) => compatible.every((other) => isSubtype(type, other)));
}

function joinFacts(a: Flow, b: Flow): FlowFacts {
  const conditions = new Map<LocalVar, ReadonlySet<LocalVar>>();
  for (const [local, dependencies] of a.facts.conditions) {
    const other = b.facts.conditions.get(local);
    if (other) conditions.set(local, intersect(dependencies, other));
  }
  return {
    writeCaptured: union(a.writeCaptured, b.writeCaptured),
    conditions,
    testedTypes: mergeTypeTests(a.facts.testedTypes, b.facts.testedTypes),
  };
}

function mergeTypeTests(first: TypeTests, second: TypeTests): TypeTests {
  if (first.size === 0 || first === second) return second;
  if (second.size === 0) return first;
  const merged = new Map(first);
  for (const [variable, types] of second) {
    const previous = merged.get(variable) ?? [];
    const extra = types.filter((type) => !previous.some((prior) => sameType(type, prior)));
    if (extra.length > 0) merged.set(variable, [...previous, ...extra]);
  }
  return merged;
}
function combineWrites(
  left: ReadonlySet<LocalVar> | undefined,
  right: ReadonlySet<LocalVar> | undefined
): ReadonlySet<LocalVar> | undefined {
  return left && right ? union(left, right) : (left ?? right);
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
    if (affectedPath(variable, (part) => roots.has(part))) promotions.delete(variable);
  }
}

function filterConditions(
  conditions: ReadonlyMap<LocalVar, ReadonlySet<LocalVar>>,
  keep: (variable: LocalVar) => boolean
): ReadonlyMap<LocalVar, ReadonlySet<LocalVar>> {
  if (conditions.size === 0) return conditions;
  const retained = new Map<LocalVar, ReadonlySet<LocalVar>>();
  for (const [variable, dependencies] of conditions) {
    if (keep(variable)) retained.set(variable, new Set([...dependencies].filter(keep)));
  }
  return retained;
}

function affectedPath(variable: LocalVar, matches: (part: LocalVar) => boolean): boolean {
  for (let current: LocalVar | undefined = variable; current; current = current.fieldReceiver) {
    if (matches(current)) return true;
  }
  return false;
}

/** Whether a body with this modifier yields (`sync*`, `async*`) and awaits (`async`, `async*`). */
export function bodyKind(modifier: BodyModifier | undefined): { isGenerator: boolean; isAsync: boolean } {
  return {
    isGenerator: modifier === 'sync*' || modifier === 'async*',
    isAsync: modifier === 'async' || modifier === 'async*',
  };
}

/**
 * The effective return type of a function, by which Dart's rules for the end of its body and for each `return` are
 * applied on every path (sync, async, arrow, closure): `checked` is the declared type, or a function literal's
 * context once it is known; `valueType` is what a returned value must fit, an async function's folded by
 * futureValueType; `context` is what a returned expression is inferred under.
 */
export interface ReturnRule {
  checked: DartType | undefined;
  valueType: DartType | undefined;
  context: DartType | undefined;
  isAsync: boolean;
}
