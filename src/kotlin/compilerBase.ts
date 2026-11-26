import { CompileError } from '../interpreter/diagnostics';
import type { Block, Expression, TypeRef } from './ast';
import type { IntegerLiteral } from './literals';
import type { Frame, FunctionInfo, LocalInfo } from './runtime';
import {
  ClassSymbol,
  type FunctionSymbol,
  type PropertySymbol,
  type TypeAliasSymbol,
  type TypeParameterSymbol,
  VariableSymbol,
} from './symbols';
import { anyType, commonSupertype, isSubtype } from './typeRelations';
import { type ClassType, type KType, nonNull, NOTHING, resolved, type TypeArgument, typeToString } from './types';
import { box, Boxed, Cell, NULL, type PrimitiveKind, type Value } from './values';

export type Eval = (frame: Frame) => Value;

/** How a compiled expression's value is held at run time: unboxed as a primitive, or as a reference. */
export type Repr = 'ref' | PrimitiveKind;

export type EnumFunctionName = 'values' | 'valueOf' | 'enumValues' | 'enumValueOf';

export type ExpressionUse = boolean | 'inferUnit';

export interface Compiled {
  /** The static type, which a smart cast may have narrowed. */
  type: KType;
  repr: Repr;
  eval: Eval;
  inferredUnit?: true;
  /** Whether the expression only calls a function or creates an object, which the step rules read. */
  isCall?: boolean;
  isCreation?: boolean;
  floatRangeBounds?: (frame: Frame) => readonly [number, number];
  /** The value of an integer literal, which may also stand for a `Long`, `Short`, `Byte`, or unsigned value. */
  integerLiteral?: IntegerLiteral;
  /** The value of an expression made only of literals, which never changes. */
  constant?: Value;
  /** The key of the variable or property the expression reads, which smart casts narrow. */
  stableKey?: string;
  /** The receiver an implicit or explicit `this` reads, which in its initializer is the instance being built. */
  thisOf?: ReceiverSymbol;
  /** For a read that a smart cast narrows, the declared type, which a `var` that the read initializes takes. */
  unnarrowedType?: KType;
  /** For a safe call such as `s?.length`, the smart casts of its receivers that hold when its value is not null. */
  whenNonNull?: Map<string, KType>;
  /** For a condition, the smart casts that hold when it is true and when it is false. */
  narrowing?: { whenTrue: Map<string, KType>; whenFalse: Map<string, KType> };
  /**
   * Whether the value is a function whose calls suspend: a lambda passed to an inline function that makes suspend
   * calls, or a function parameter of an inline function's suspend version.
   */
  suspending?: boolean;
}

/** The classes of the standard library that the compiler gives meaning to. */
export interface Core {
  any: ClassSymbol;
  unit: ClassSymbol;
  boolean: ClassSymbol;
  string: ClassSymbol;
  charSequence: ClassSymbol;
  number: ClassSymbol;
  comparable: ClassSymbol;
  throwable: ClassSymbol;
  array: ClassSymbol;
  iterable: ClassSymbol;
  iterator: ClassSymbol;
  collection: ClassSymbol;
  list: ClassSymbol;
  mutableList: ClassSymbol;
  set: ClassSymbol;
  mutableSet: ClassSymbol;
  map: ClassSymbol;
  mutableMap: ClassSymbol;
  function: ClassSymbol;
  /** `kotlin.jvm.functions.Function0` and the others, by their number of parameters. */
  functionInterfaces: ClassSymbol[];
  enum: ClassSymbol;
  intRange: ClassSymbol;
  longRange: ClassSymbol;
  charRange: ClassSymbol;
  kProperty: ClassSymbol;
  turtle: ClassSymbol;
  /** The primitive classes, by the kind of value they hold. */
  primitives: Map<ClassSymbol, PrimitiveKind>;
  primitiveClasses: Record<PrimitiveKind, ClassSymbol>;
}

export class PackageScope {
  readonly classes = new Map<string, ClassSymbol>();
  readonly typeAliases = new Map<string, TypeAliasSymbol>();
  readonly functions = new Map<string, FunctionSymbol[]>();
  readonly properties = new Map<string, PropertySymbol[]>();

  addFunction(symbol: FunctionSymbol): void {
    const existing = this.functions.get(symbol.name);
    if (existing) existing.push(symbol);
    else this.functions.set(symbol.name, [symbol]);
  }

  addProperty(symbol: PropertySymbol): void {
    const existing = this.properties.get(symbol.name);
    if (existing) existing.push(symbol);
    else this.properties.set(symbol.name, [symbol]);
  }
}

/** An implicit receiver: `this` of a class, of an extension, or of a lambda with a receiver. */
export class ReceiverSymbol {
  constructor(
    readonly type: KType,
    readonly context: FunctionContext,
    /** The class whose `this` the receiver is, for a class's members. */
    readonly cls: ClassSymbol | undefined,
    /** The name `this@name` refers to it by: its class's, or its extension function's. */
    readonly label?: string,
    /**
     * For the instance of a class around an inner class, the inner classes whose outer instances lead to it from the
     * context's `this`, innermost first.
     */
    readonly outerPath?: readonly ClassSymbol[]
  ) {}

  /** For the dispatch receiver of an extension declared in a class, the slot of the frame that holds it. */
  slot: number | undefined;
}

export interface LoopContext {
  identity: object;
  /** The label of `label@ for (...)`, which `break@label` and `continue@label` name. */
  label: string | undefined;
  breaks: Flow[];
  continues: Flow[];
  valWrites: Map<VariableSymbol | PropertySymbol, number>;
  /** The variables declared before the loop, which an assignment in it may assign more than once. */
  outerVals: Set<VariableSymbol>;
}

/** The function or lambda being compiled, which owns a frame. */
export class FunctionContext {
  readonly info: FunctionInfo;
  private nextSlot = 0;
  /** What a lambda captures from enclosing functions, in the order of its frame's captures. */
  readonly captures: (VariableSymbol | ReceiverSymbol | FunctionContext)[] = [];
  private readonly captureIndexes = new Map<object, number>();
  /** The declared or expected result type, or `undefined` while a lambda's or expression body's is inferred. */
  returnType: KType | undefined;
  /** How the function returns its value, which a `return` in a lambda converts to. */
  returnRepr: Repr | undefined;
  readonly returnedTypes: KType[] = [];
  loops: LoopContext[] = [];
  /** Whether the context is a class or file initializer, which no `return` may leave. */
  forbidsReturn = false;
  /** Whether a `return` written directly in the context, not in a lambda, leaves it. */
  hasDirectReturn = false;
  /** Gives the returns compiled before an inferred result type the representation that type settles on. */
  readonly inferredReturns: ((to: Repr) => void)[] = [];
  inlineLambda = false;
  /** The name `return@label` leaves the context by: a function's name, or a lambda's label. */
  label: string | undefined;
  /** Whether the context is a suspend function's or lambda's, which may call suspend functions. */
  isSuspend = false;
  /**
   * For a suspend context whose receiver is a sequence builder's scope, the scope's class: as the scope is
   * `@RestrictsSuspension`, the context calls only the suspend functions that are its members or extensions.
   */
  restrictedScope: ClassSymbol | undefined;
  /** For a `tailrec` function, the function and the calls in tail position of its body. */
  tailrec: { symbol: FunctionSymbol; calls: ReadonlySet<Expression> } | undefined;
  /** For a lambda, what its `return@label` must give and has given, which its result type joins. */
  lambdaResult: { expected: KType | undefined; returnsUnit: boolean; returned: Compiled[] } | undefined;
  /** A discarded probe may retain open types until the enclosing argument reveals their positions. */
  allowOpenCallTypes: boolean;
  invokesExactlyOnce = false;
  /** Whether the context is a probe's own, which stands in the place of the code it compiles only for its types. */
  isProbeRoot = false;
  readonly inlineWrites = new Set<VariableSymbol>();

  constructor(
    readonly parent: FunctionContext | undefined,
    readonly isLambda: boolean,
    name: string,
    isLibrary: boolean,
    /** The function a `return` leaves: the function itself, or for a lambda of an inline call, the one around it. */
    readonly returnTarget: FunctionContext | undefined,
    readonly isProbe: boolean = parent?.isProbe ?? false
  ) {
    this.allowOpenCallTypes = parent?.allowOpenCallTypes ?? false;
    this.info = {
      name,
      locals: [],
      captures: [],
      slotCount: 0,
      isAtomic: false,
      isLibrary,
      isLambda,
      showsThis: false,
    };
  }

  allocate(name: string, type: KType, isShown: boolean): number {
    const slot = this.nextSlot++;
    this.info.slotCount = this.nextSlot;
    if (isShown) this.info.locals.push({ name, slot, type });
    return slot;
  }

  /** The index of a captured variable, receiver, or frame in this lambda's captures, adding it when it is new. */
  captureIndex(source: VariableSymbol | ReceiverSymbol | FunctionContext): number {
    const existing = this.captureIndexes.get(source);
    if (existing !== undefined) return existing;
    const index = this.captures.length;
    this.captures.push(source);
    this.captureIndexes.set(source, index);
    if (source instanceof VariableSymbol && !source.name.startsWith('\0') && !this.info.isLibrary) {
      const info: LocalInfo = {
        name: source.name,
        slot: index,
        type: source.type,
      };
      this.info.captures.push(info);
    }
    return index;
  }

  directExecutionContext(): FunctionContext {
    return this.inlineLambda && this.parent ? this.parent.directExecutionContext() : this;
  }

  canInitializeIn(owner: FunctionContext | undefined): boolean {
    if (this === owner) return true;
    return this.invokesExactlyOnce && this.parent?.canInitializeIn(owner) === true;
  }

  /** Whether `context` is this function or a function around it. */
  isWithin(context: FunctionContext): boolean {
    if (context === this) return true;
    return this.parent?.isWithin(context) ?? false;
  }
}

/** A scope of names: of a file, a class, a function, or a block. */
export class Scope {
  readonly variables = new Map<string, VariableSymbol>();
  pendingWrites: ReadonlyMap<string, number> | undefined;
  readonly classes = new Map<string, ClassSymbol>();
  readonly typeParameters = new Map<string, TypeParameterSymbol>();
  /** The functions declared in the scope's function body, which hide the other functions of their names. */
  readonly functions = new Map<string, FunctionSymbol[]>();
  receiver: ReceiverSymbol | undefined;
  /** A class whose companion object's members and nested classes the scope's names reach. */
  staticClass: ClassSymbol | undefined;

  constructor(
    readonly parent: Scope | undefined,
    readonly context: FunctionContext | undefined
  ) {}
}

const CASE_SEPARATOR = '!';

/**
 * The narrowing that records that the value of `key` is none of `caseIds`, kept among the smart casts so that branches
 * merge and forget it as they do the smart casts. Kotlin 2.4 uses it to decide whether a `when` covers every case.
 */
export function excludingCases(key: string, caseIds: readonly string[]): Map<string, KType> {
  return new Map(caseIds.map((caseId) => [`${key}${CASE_SEPARATOR}${caseId}`, NOTHING]));
}

/** What the compiler knows at a point of a function: narrowed types and which variables are assigned. */
export class Flow {
  constructor(
    readonly narrowed = new Map<string, KType>(),
    readonly assigned = new Set<VariableSymbol | PropertySymbol>(),
    /** The `val`s that may be assigned at this point, which cannot be assigned again. */
    readonly maybeAssigned = new Set<VariableSymbol | PropertySymbol>(),
    /** Whether the point cannot be reached, after a `return`, `throw`, `break`, or `continue`. */
    public isDead = false
  ) {}

  /** Forgets the smart casts of a stable value, with the cases it was known not to be and those of its properties. */
  forget(key: string): void {
    for (const narrowedKey of this.narrowed.keys()) if (isKeyOf(narrowedKey, key)) this.narrowed.delete(narrowedKey);
  }

  /** Records what a non-null result of the expression shows: it and the receivers of its safe calls are not null. */
  assumeNonNull(compiled: Compiled): void {
    for (const [key, type] of nonNullFacts(compiled)) this.narrowed.set(key, type);
  }

  /** Takes the smart casts of another flow in place of this one's, keeping what this one knows is assigned. */
  replaceNarrowing(other: Flow): void {
    this.narrowed.clear();
    for (const [key, type] of other.narrowed) this.narrowed.set(key, type);
  }

  /** The cases of an enum or sealed type that a stable value is known not to be, as a `when` on it need not cover them. */
  excludedCases(key: string): string[] {
    const prefix = `${key}${CASE_SEPARATOR}`;
    return [...this.narrowed.keys()].filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
  }

  copy(): Flow {
    return new Flow(new Map(this.narrowed), new Set(this.assigned), new Set(this.maybeAssigned), this.isDead);
  }

  /** The state where two branches meet. */
  static merge(flows: Flow[]): Flow {
    const live = flows.filter((flow) => !flow.isDead);
    if (live.length === 0) {
      const dead = flows[0].copy();
      for (const flow of flows.slice(1)) for (const variable of flow.maybeAssigned) dead.maybeAssigned.add(variable);
      dead.isDead = true;
      return dead;
    }
    const [first, ...rest] = live;
    let narrowed = new Map(first.narrowed);
    for (const flow of rest) narrowed = commonNarrowing(narrowed, flow.narrowed);
    const assigned = new Set(
      [...first.assigned].filter((variable) => rest.every((flow) => flow.assigned.has(variable)))
    );
    const maybeAssigned = new Set(live.flatMap((flow) => [...flow.maybeAssigned]));
    return new Flow(narrowed, assigned, maybeAssigned, false);
  }
}

/** Whether a smart cast's key is about the value of `key`: itself, its properties, or the cases it is known not to be. */
export function isKeyOf(narrowedKey: string, key: string): boolean {
  return narrowedKey === key || narrowedKey.startsWith(`${key}.`) || narrowedKey.startsWith(`${key}${CASE_SEPARATOR}`);
}

/**
 * What a non-null value of an expression shows: a stable value is not null, and neither is any receiver of the safe
 * calls it was read through, as `x` and `x.s` of `x?.s?.length` are not. Every condition that implies a non-null
 * value, such as `!= null`, `is T`, `?: return`, `!!` or `isNullOrEmpty()`, applies these facts.
 */
export function nonNullFacts(compiled: Compiled): Map<string, KType> {
  const facts = new Map(compiled.whenNonNull);
  if (compiled.stableKey && resolved(compiled.type).nullable) facts.set(compiled.stableKey, nonNull(compiled.type));
  return facts;
}

/**
 * The facts that hold on either of two paths: a value narrowed on both keeps their common supertype, as `Animal` does
 * for `Cat` and `Dog`.
 */
export function commonNarrowing(a: ReadonlyMap<string, KType>, b: ReadonlyMap<string, KType>): Map<string, KType> {
  const result = new Map<string, KType>();
  for (const [key, type] of a) {
    const other = b.get(key);
    if (other)
      result.set(key, isSubtype(type, other) && isSubtype(other, type) ? type : commonSupertype([type, other]));
  }
  return result;
}

/**
 * A value that compiled code hands to code compiled inside it, such as the receiver of `a[i] += 1` to its `get` and
 * `set`. Handoffs nest as calls do, and the value also stays in the frame's temporaries, which garbage collection
 * follows.
 */
export class Handoff<T> {
  private current: T | undefined;

  get(): T {
    return this.current as T;
  }

  run<R>(frame: Frame, value: T, body: () => R): R {
    const previous = this.current;
    this.current = value;
    frame.temporaries.push(value as unknown as Value);
    try {
      return body();
    } finally {
      frame.temporaries.pop();
      this.current = previous;
    }
  }
}

export function compileError(row: number, message: string): CompileError {
  return new CompileError([{ row, message }]);
}

export function typeMismatchMessage(expected: KType, actual: KType): string {
  return `型が合いません。${typeToString(resolved(expected))} が必要ですが、${typeToString(resolved(actual))} です。`;
}

export function nullableReceiverMessage(type: KType): string {
  return `null かもしれない ${typeToString(resolved(type))} の値には、?. か !! を使ってください。`;
}

/** How values of the type are held: unboxed for non-null primitive types other than `Boolean`. */
export function reprOf(core: Core, type: KType): Repr {
  const actual = resolved(type);
  if (actual.kind !== 'class' || actual.nullable) return 'ref';
  return core.primitives.get(actual.cls) ?? 'ref';
}

/** Converts a value between representations, boxing primitives where a reference is expected. */
export function convertRepr(eval_: Eval, from: Repr, to: Repr): Eval {
  if (from === to) return eval_;
  if (from === 'ref') {
    return (frame) => {
      const value = eval_(frame);
      if (value instanceof Boxed) return value.value;
      // A null that reaches a primitive, as a smart cast that a write inside its own test outdated lets it, throws
      // as the JVM's unboxing does instead of turning into a number.
      if (value === NULL) frame.runtime.throwError(frame, 'java.lang.NullPointerException');
      return value;
    };
  }
  if (to === 'ref') return (frame) => box(from, eval_(frame) as number | bigint);
  // Representations of different primitives meet only through a reference, which the checker rules out.
  return eval_;
}

export function coerce(compiled: Compiled, to: Repr): Eval {
  return convertRepr(compiled.eval, compiled.repr, to);
}

/** Reads a local, which lives in a cell when a lambda captures it. */
export function readSlot(slot: unknown): Value {
  return slot instanceof Cell ? slot.value : (slot as Value);
}

/** The type of the elements a class type's argument at `index` holds, with a star read as `Any?`. */
export function typeArgument(type: ClassType, index: number): KType {
  const argument: TypeArgument | undefined = type.args[index];
  if (!argument || argument.variance === 'star') return anyType(true);
  return argument.type;
}

export { NOTHING };

export interface TypeResolver {
  resolveType(scope: Scope, ref: TypeRef): KType;
}

/** The class a name in a scope stands for, looking in enclosing classes' nested classes too. */
export function findClassInScope(scope: Scope | undefined, name: string): ClassSymbol | undefined {
  for (let current = scope; current; current = current.parent) {
    const found = current.classes.get(name);
    if (found) return found;
    for (let cls = current.staticClass; cls; cls = cls.outer) {
      const nested = findNestedInClassHierarchy(cls, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findNestedInClassHierarchy(cls: ClassSymbol, name: string): ClassSymbol | undefined {
  const visited = new Set<ClassSymbol>();
  for (
    let current: ClassSymbol | undefined = cls;
    current && !visited.has(current);
    current = current.superclass?.cls
  ) {
    const nested = current.nested.get(name);
    if (nested) return nested;
    visited.add(current);
  }
  return undefined;
}

export { ClassSymbol };

/** Whether a block's value is a call of a function by its name without arguments or type arguments, as `emptyList()`. */
export function isBareCall(block: Block): boolean {
  const last = block.statements.at(-1);
  return last?.kind === 'expressionStatement' && isBareCallExpression(last.expression);
}

export function isBareCallExpression(expression: Expression): boolean {
  return (
    expression.kind === 'call' &&
    expression.callee.kind === 'name' &&
    expression.args.length === 0 &&
    !expression.trailingLambda &&
    expression.typeArgs.length === 0
  );
}

/**
 * Reads a Boolean that is non-null by its type, though a null can still reach it through an erased generic result,
 * such as an element of a list cast to `List<Boolean>`; the JVM's unboxing throws for it instead of treating it as
 * false.
 */
export function checkedBoolean(compiled: Compiled, evaluate: Eval): Eval {
  if (compiled.constant !== undefined) return evaluate;
  return (frame) => {
    const value = evaluate(frame);
    if (value === NULL) frame.runtime.throwError(frame, 'java.lang.NullPointerException');
    return value;
  };
}
