import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { alignmentOperand, runtimeVariableType } from './admissibility';
import { CompilationStorage, resolveTypeSlots, valueSlots } from './allocation';
import { PANIC, panic } from './arith';
import { isDiscardName } from './ast';
import type {
  Container,
  ContainerMember,
  Expression,
  ExpressionOf,
  FunctionDeclaration,
  SourceFile,
  Span,
} from './ast';
import { unionTagValue } from './bufferMemory';
import { markRuntimeStorage } from './comptimeMemory';
import { enumLookup } from './enumLookup';
import { decodeFloat } from './floatEncoding';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  compareFloats,
  floatFromBigInt,
  floatOf,
  FORMATS,
  isInfinite,
  isIntegral,
  roundTo,
  truncateToBigInt,
} from './floats';
import { FunctionInstance } from './functions';
import { alignOf, bitSizeOf, hasResolvedLayout, resolveTypeLayout, sizeOf } from './layout';
import { spendMemory } from './memoryAccounting';
import { MemoryFault, UNDEFINED_MEMORY } from './memoryFault';
import { type BranchCount, type Frame, ZigPanic } from './runtime';
import { singleValueOf } from './singleValue';
import {
  arrayOf,
  type ArrayType,
  BOOL,
  COMPTIME_FLOAT,
  COMPTIME_INT,
  type Decl,
  type EnumType,
  errorSetOf,
  type ErrorSetType,
  errorUnionOf,
  fitsInt,
  type FloatType,
  type FnType,
  type IntType,
  intType,
  isComptimeOnly,
  type Namespace,
  NULL_TYPE,
  optionalOf,
  pointerOf,
  pointerTo,
  type PointerType,
  sameSentinel,
  Sentinel,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeName,
  UNDEFINED_TYPE,
  type UnionType,
  USIZE,
  VOID,
} from './types';
import { aggregateFacts, fieldFacts, staticResultOf, type ValueFacts, valueFactsOf } from './valueFacts';
import {
  arrayPointerView,
  copyZeroArray,
  type EnumLiteral,
  ErrorValue,
  FnValue,
  hasUndefinedHeader,
  isUndefinedMemory,
  markConstantStorage,
  NativeHandle,
  NULL,
  Pointer,
  Slice,
  type Slots,
  Some,
  type Value,
  ZArray,
  zeroArray,
  ZStruct,
  ZUnion,
} from './values';

export type Eval = (frame: Frame) => Value;

/** Where an expression's value lives, for assigning to it and taking its address. */
export interface Place {
  /** Whether the place may not be written: a constant, or what a `*const` pointer or a slice of constants refers to. */
  readonly isConst: boolean;
  readonly locate: (frame: Frame) => Pointer;
  readonly compileTimePointer?: Pointer;
  readonly address?: () => TExpr;
  /**
   * Whether the value read here is a copy of a `comptime var`'s value where the code stands, whose parts come from the
   * copy while addresses and stores still reach the variable.
   */
  readonly snapshot?: boolean;
  /** The `comptime var` the place lies in, whose reads and stores happen as the compiler analyzes them. */
  readonly comptimeVar?: LocalBinding;
  /** The alignment that `align(n)` gives the variable, which a pointer to it carries. */
  readonly alignment?: number;
}

/** An analyzed expression: its type, its value when the compiler knows it, and the code that computes it. */
export interface TExpr {
  readonly type: Type;
  /** Whether this expression can be replaced with `value`. */
  readonly known: boolean;
  readonly staticResult?: { value: Value };
  readonly knownLength?: bigint;
  readonly valueFacts?: ValueFacts;
  readonly value: Value;
  readonly eval: Eval;
  readonly place?: Place;
  readonly span: Span;
  /** The local that the expression names, if it names one directly. */
  readonly local?: LocalBinding;
}

export interface LocalBinding {
  readonly kind: 'local';
  readonly name: string;
  readonly slot: number;
  readonly type: Type;
  readonly isConst: boolean;
  readonly knownLength?: bigint;
  readonly valueFacts?: ValueFacts;
  /** The value of a constant that the compiler knows. */
  readonly known: boolean;
  readonly value?: Value;
  /** The storage of a `comptime var`, which the compiler reads and writes as it analyzes the code after it. */
  readonly comptimeCell?: ComptimeCell;
  readonly alignment?: number;
}

export interface ComptimeCell extends Slots {
  /** How many branches on runtime conditions enclose the declaration, inside which no more may enclose a store. */
  readonly conditionDepth: number;
}

/** A lexical scope: the locals of a block, or the declarations of a container. */
export interface Scope {
  readonly parent?: Scope;
  readonly locals?: Map<string, LocalBinding>;
  readonly namespace?: Namespace;
}

/** A function declaration as a value known at compile time, which a call instantiates for its argument types. */
export class FnRef {
  constructor(
    readonly decl: Extract<Decl, { kind: 'fn' }>,
    /** The receiver of a method value such as `p.len`, which a call passes first. */
    readonly receiver?: TExpr
  ) {}

  get functionName(): string {
    return this.decl.syntax.name;
  }
}

export interface NativeSignature {
  type: FnType;
  receiver?: boolean;
}

export class NativeFn {
  constructor(
    readonly name: string,
    readonly compileCall: (sema: SemaApi, call: NativeCall) => TExpr,
    readonly signature?: NativeSignature
  ) {}

  get functionName(): string {
    return this.name.slice(this.name.lastIndexOf('.') + 1);
  }
}

export interface NativeCall {
  readonly span: Span;
  readonly args: readonly Expression[];
  /** The receiver of a method call such as `list.append(...)`. */
  readonly receiver?: TExpr;
  readonly resultType?: Type;
}

export interface LibraryFunctionOptions {
  args?: readonly TExpr[];
  namespaceName?: string;
  members?: Readonly<Record<string, { type: Type; value: Value }>>;
}

export interface SemaApi {
  compile(expression: Expression, resultType?: Type): TExpr;
  compileType(expression: Expression): Type;
  valueComparator(type: Type, ordered: boolean, span: Span): (a: Value, b: Value) => number;
  reserveStorage(type: Type, span: Span): void;
  resolveStorage(type: Type, span: Span): void;
  requiresComptime(type: Type, span: Span): boolean;
  spendCompilation(cost?: number): void;
  nameSlice(text: string, frame?: Frame): Slice;
  libraryFunction(
    file: SourceFile,
    element: Type,
    name: string,
    params: readonly Type[],
    span: Span,
    options?: LibraryFunctionOptions
  ): FunctionInstance;
  coerce(expression: TExpr, type: Type, span?: Span): TExpr;
  error(span: Span, message: string): never;
  knownValue(expression: TExpr, what: string): Value;
  peerType(expressions: readonly TExpr[], span: Span): Type;
  callFunction(fn: FunctionInstance, args: Value[], frame: Frame, callRow?: number): Value;
  knownFunctionValue(expression: TExpr, span: Span): FnValue;
  instantiate(ref: FnRef, argTypes: readonly Type[], span: Span): FunctionInstance;
  functionSignature(value: TExpr, span: Span): FnType;
  functionOf(
    value: TExpr,
    span: Span
  ): { call: (frame: Frame, args: Value[]) => Value; params: readonly Type[]; returnType: Type };
  addressOf(expression: TExpr): TExpr;
  structFields(type: StructType, span: Span): StructField[];
  /** The tuple type of fields, the same type for the same field types. */
  tupleType(fields: StructField[]): StructType;
  enumFields(type: EnumType): NonNullable<EnumType['fields']>;
  unionFields(type: UnionType): NonNullable<UnionType['fields']>;
  /** The declaration of a type with a name, such as a method of a struct. */
  findDecl(type: Type, name: string): Decl | undefined;
  resolveDecl(decl: Decl, span: Span): TExpr;
}

export { UNASSIGNED } from './values';
export { staticResultOf } from './valueFacts';

export const NATIVE_FN_TYPE: Type = { kind: 'fn', params: [], returnType: VOID };

export function known(type: Type, value: Value, span: Span): TExpr {
  return { type, known: true, value, eval: () => value, span };
}

export function runtime(type: Type, evaluate: Eval, span: Span, place?: Place): TExpr {
  return { type, known: false, value: undefined, eval: evaluate, span, place };
}

export function isType(value: Value): value is Type {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** What the analysis of one function or declaration tracks as it compiles the code. */
export interface AnalysisContext {
  /** How deep the compiler is in code that it runs itself, such as a `comptime` block. */
  comptimeDepth: number;
  /**
   * The `comptime var` that the code the compiler runs stores to, when that code is such a store: it runs once where it
   * stands, so the other `comptime var`s it reads have the values they hold there.
   */
  comptimeStore: LocalBinding | undefined;
  /** How many branches on runtime conditions and runtime loop bodies enclose the code being compiled. */
  runtimeConditionDepth: number;
  /** The backward branches that the analysis has evaluated, against the evaluation quota. */
  evalBranches: BranchCount;
}

export function newAnalysisContext(): AnalysisContext {
  return {
    comptimeDepth: 0,
    comptimeStore: undefined,
    runtimeConditionDepth: 0,
    evalBranches: { count: 0, quota: 1000 },
  };
}

export abstract class SemaBase implements SemaApi {
  protected readonly storage = new CompilationStorage();
  protected scope: Scope;
  protected readonly namespaceTypes = new WeakMap<Namespace, Type>();
  private readonly containerTypes = new WeakMap<Scope, Map<Container, Type>>();
  /** The container-level variables the program uses, as the trace shows them. */
  protected readonly globalVariables: { name: string; type: Type; cell: Slots }[] = [];
  private anonymousCount = 0;
  private readonly indexedFields = new WeakMap<readonly { name: string }[], ReadonlyMap<string, number>>();
  /** How many structs' fields are being resolved, during which function bodies wait to compile. */
  protected resolvingFields = 0;
  /** The state of the analysis of the current function or declaration, which a separate analysis replaces as a unit. */
  protected context: AnalysisContext = newAnalysisContext();
  private resolvingUnionFields = 0;

  constructor(
    readonly root: Namespace,
    protected readonly compilationBudget = new ExecutionBudget()
  ) {
    this.scope = { namespace: root };
  }

  abstract libraryFunction(
    file: SourceFile,
    element: Type,
    name: string,
    params: readonly Type[],
    span: Span,
    options?: LibraryFunctionOptions
  ): FunctionInstance;

  spendCompilation(cost = 1): void {
    this.compilationBudget.spend(cost);
  }

  private readonly functionReferences = new WeakMap<Decl, FnRef>();
  /** The `comptime var` that each pointer or slice the compiler made refers into. */
  protected readonly comptimeVarReferences = new WeakMap<Pointer | Slice, LocalBinding>();

  resolveStorage(type: Type, span: Span): void {
    this.resolveLayout(type, span, new Set());
  }

  requiresComptime(type: Type, span: Span): boolean {
    this.resolveStorage(type, span);
    return isComptimeOnly(type);
  }

  private copyForCompilation(value: Value, type: Type, span: Span): Value {
    this.resolveStorage(type, span);
    this.spendCompilation(sizeOf(type) === 0 ? 0 : 1);
    return copyStoredValue(
      value,
      (slots) => {
        this.storage.reserveSlots(slots);
        this.spendCompilation(slots);
      },
      type,
      () => this.spendCompilation()
    );
  }

  protected materializeUnion(type: UnionType, index: number, payload: TExpr, span: Span): TExpr {
    this.resolveStorage(type, span);
    const build = (payload: Value, frame?: Frame): Value => {
      const value = new ZUnion(index, payload);
      return frame ? copyForFrame(frame, value, type) : this.copyForCompilation(value, type, span);
    };
    if (payload.known) return known(type, build(payload.value), span);
    const evaluate = payload.eval;
    return {
      ...runtime(type, (frame) => build(evaluate(frame), frame), span),
      staticResult: this.constantResult([payload], ([value]) => build(value), span),
    };
  }

  reserveStorage(type: Type, span: Span): void {
    this.resolveStorage(type, span);
    this.storage.reserve(type);
  }

  reservePhysicalSlots(count: number): void {
    this.storage.reserveSlots(count);
  }

  error(span: Span, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  abstract compile(expression: Expression, resultType?: Type): TExpr;
  abstract nameSlice(text: string, frame?: Frame): Slice;
  abstract valueComparator(type: Type, ordered: boolean, span: Span): (a: Value, b: Value) => number;
  abstract callFunction(fn: FunctionInstance, args: Value[], frame: Frame, callRow?: number): Value;
  protected abstract declarationType(decl: Extract<Decl, { kind: 'fn' }>, span: Span): FnType;
  abstract instantiate(ref: FnRef, argTypes: readonly Type[], span: Span): FunctionInstance;
  abstract functionSignature(value: TExpr, span: Span): FnType;
  abstract functionOf(
    value: TExpr,
    span: Span
  ): { call: (frame: Frame, args: Value[]) => Value; params: readonly Type[]; returnType: Type };
  abstract addressOf(expression: TExpr): TExpr;
  abstract findDecl(type: Type, name: string): Decl | undefined;
  abstract tupleType(fields: StructField[]): StructType;
  /** Evaluates a function call at compile time, as a container-level constant's initializer does. */
  protected abstract evaluateAtCompileTime(expression: TExpr, ownSlots?: { from: number; count: number }): Value;
  /** Compiles code that the compiler runs as it analyzes, such as a `comptime` block, and gives its value. */
  protected abstract comptimeValue(compileCode: () => TExpr, span: Span, store?: LocalBinding): TExpr;
  /** Runs an analysis of its own, as Zig analyzes each function and declaration apart from the one that uses it. */
  protected abstract separateAnalysis<T>(run: () => T): T;
  /** The function whose body the compiler is analyzing, if any. */
  protected abstract analyzedFunction(): FunctionInstance | undefined;
  protected abstract addressSpace(expression: Expression): void;
  /** Whether `set` is the inferred error set (`!T`) of the function being analyzed, which takes in any error. */
  protected abstract growsErrorSet(set: ErrorSetType): boolean;

  // Scopes ----------------------------------------------------------------------------------------------------------

  protected withScope<T>(scope: Scope, run: () => T): T {
    const outer = this.scope;
    this.scope = scope;
    try {
      return run();
    } finally {
      this.scope = outer;
    }
  }

  protected lookup(name: string): LocalBinding | Decl | undefined {
    for (let scope: Scope | undefined = this.scope; scope; scope = scope.parent) {
      const local = scope.locals?.get(name);
      if (local) return local;
      const decl = scope.namespace?.decls.get(name);
      if (decl) return decl;
    }
    return undefined;
  }

  /** Whether code here reads a `comptime var` when the compiler runs it, rather than as the value where it stands. */
  protected readsComptimeVarLive(variable: LocalBinding): boolean {
    return this.context.comptimeDepth > 0 && (!this.context.comptimeStore || this.context.comptimeStore === variable);
  }

  /** The `comptime var` an expression lies in, or that the pointer or slice it is known to be refers into. */
  protected comptimeVarOf(expression: TExpr): LocalBinding | undefined {
    if (expression.place?.comptimeVar) return expression.place.comptimeVar;
    const value = expression.known ? expression.value : undefined;
    return value instanceof Pointer || value instanceof Slice ? this.comptimeVarReferences.get(value) : undefined;
  }

  /** Refuses a value that code running when the program runs would hold while it refers into a `comptime var`. */
  protected refuseComptimeVarReference(value: TExpr, span: Span): void {
    if (this.context.comptimeDepth > 0 || !value.known) return;
    const parts = value.value instanceof ZStruct ? value.value.slots : [value.value];
    const referred = parts.find(
      (part) => (part instanceof Pointer || part instanceof Slice) && this.comptimeVarReferences.has(part)
    );
    if (referred !== undefined)
      this.error(span, '実行時の値に、comptime var を指すポインタが入っています（実行時には使えません）。');
  }

  /** Compiles code inside a branch on a runtime condition or a runtime loop's body, where a `comptime var` is fixed. */
  protected underRuntimeCondition<T>(run: () => T): T {
    // A branch in code that the compiler runs is decided as it runs, so it is no runtime condition.
    if (this.context.comptimeDepth > 0) return run();
    this.context.runtimeConditionDepth++;
    try {
      return run();
    } finally {
      this.context.runtimeConditionDepth--;
    }
  }

  /** The innermost container whose scope the compiler is in, which `@This()` names. */
  protected enclosingNamespace(): Namespace {
    for (let scope: Scope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.namespace) return scope.namespace;
    }
    return this.root;
  }

  protected checkMemoryOperand(value: TExpr, span: Span = value.span): void {
    if (hasUndefinedMemory(value)) this.error(span, 'undefined のポインタは参照できません。');
  }

  protected checkMemoryHeader(value: TExpr, span: Span = value.span): void {
    const fact = staticResultOf(value);
    if (fact && hasUndefinedHeader(fact.value)) this.error(span, 'undefined のヘッダーは参照できません。');
  }

  // Values known at compile time ------------------------------------------------------------------------------------

  knownValue(expression: TExpr, what: string): Value {
    void what;
    return expression.known ? expression.value : this.evaluateAtCompileTime(expression);
  }

  compileType(expression: Expression): Type {
    const compiled = this.compile(expression, undefined);
    if (compiled.type.kind !== 'type') {
      this.error(expression, `型が必要ですが、${typeName(compiled.type)} 型の値です。`);
    }
    const value = this.knownValue(compiled, '型');
    return value as Type;
  }

  // Declarations ----------------------------------------------------------------------------------------------------

  /** Creates the type of a container expression, whose fields the compiler resolves when the type is first used. */
  protected containerType(container: Container, name: string | undefined): Type {
    let types = this.containerTypes.get(this.scope);
    if (!types) {
      types = new Map();
      this.containerTypes.set(this.scope, types);
    }
    const existing = types.get(container);
    if (existing) return existing;
    const parent = this.enclosingNamespace();
    const qualified = name ?? `${parent.name}__${container.containerKind}_${++this.anonymousCount}`;
    const namespace: Namespace = {
      name: qualified,
      decls: new Map(),
      parent,
      internal: parent.internal,
      syntax: container,
      scope: this.scope,
    };
    let type: Type;
    if (container.containerKind === 'opaque') {
      type = { kind: 'struct', isTuple: false, namespace, layout: 'auto', fields: [] };
    } else if (container.containerKind === 'struct') {
      // `struct { u32, u32 }`, whose fields have types only, declares a tuple.
      const isTuple = container.fields.length > 0 && container.fields.every((field) => field.name === undefined);
      type = { kind: 'struct', isTuple, namespace, layout: container.layout, fields: undefined };
    } else if (container.containerKind === 'enum') {
      type = { kind: 'enum', namespace, tagType: undefined, fields: undefined, exhaustive: true };
    } else {
      type = {
        kind: 'union',
        namespace,
        layout: container.layout,
        tagType: undefined,
        fields: undefined,
      };
    }
    types.set(container, type);
    this.namespaceTypes.set(namespace, type);
    addDecls(namespace, container.members);
    this.runComptimeBlocks(container.comptimeBlocks, namespace);
    return type;
  }

  /** Runs `comptime { ... }` declarations, as Zig does when it analyzes their container. */
  protected runComptimeBlocks(blocks: readonly Expression[], namespace: Namespace): void {
    for (const block of blocks) {
      this.inContainerScope(namespace, () =>
        this.separateAnalysis(() => {
          const value = this.comptimeValue(() => this.compile(block), block);
          if (value.type.kind !== 'void' && value.type.kind !== 'noreturn')
            this.error(block, `${typeName(value.type)} 型の値を使っていません（捨てるときは _ = ... と書きます）。`);
        })
      );
    }
  }

  /** Resolves a declaration: a constant's type and value, a variable's type and storage, or a function. */
  resolveDecl(decl: Decl, span: Span): TExpr {
    switch (decl.kind) {
      case 'fn': {
        let ref = this.functionReferences.get(decl);
        if (!ref) {
          ref = new FnRef(decl);
          this.functionReferences.set(decl, ref);
        }
        return known(this.declarationType(decl, span), ref, span);
      }
      case 'native': {
        if (decl.resolveWith) return (decl.resolveWith as (sema: SemaApi, span: Span) => TExpr)(this, span);
        const { type, value, unavailable } = decl.resolve();
        if (unavailable) this.error(span, `${unavailable}は、この採点環境では使えません。`);
        return known(type, value, span);
      }
      default: {
        this.resolveVariable(decl);
        const { alignment } = decl;
        if (decl.kind === 'const') {
          const pointer = new Pointer(decl.cell as Slots, 0);
          return {
            ...known(decl.type as Type, decl.value, span),
            place: { isConst: true, locate: () => pointer, compileTimePointer: pointer, alignment },
          };
        }
        const cell = decl.cell as Slots;
        const type = decl.type as Type;
        return runtime(type, () => cell.slots[0], span, {
          isConst: false,
          locate: () => new Pointer(cell, 0),
          compileTimePointer: new Pointer(cell, 0),
          alignment,
        });
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps declaration state and its compilation-time storage transaction together.
  private resolveVariable(decl: Extract<Decl, { kind: 'const' | 'var' }>): void {
    if (decl.state === 'resolved') return;
    if (decl.state === 'resolving') {
      this.error(decl.syntax, `「${decl.syntax.name}」の値が、それ自身に依存しています。`);
    }
    decl.state = 'resolving';
    const scope = (decl.namespace.scope as Scope | undefined) ?? { namespace: decl.namespace };
    this.withScope(
      {
        namespace: decl.namespace,
        parent: scope.namespace === decl.namespace ? scope.parent : scope,
      },
      () => {
        const { syntax } = decl;
        const declared = syntax.type ? this.compileType(syntax.type) : undefined;
        const value = syntax.value as Expression;
        const compiled = this.separateAnalysis(() =>
          this.comptimeValue(() => {
            const compiled = this.compileDeclValue(value, declared, syntax.name);
            return declared ? this.coerce(compiled, declared, value) : compiled;
          }, value)
        );
        if (decl.kind === 'var') runtimeVariableType(this, syntax.name, compiled.type, syntax, 'container');
        decl.cell = { slots: [this.copyForCompilation(compiled.value, compiled.type, syntax)] };
        decl.type = compiled.type;
        if (syntax.addressSpace) this.addressSpace(syntax.addressSpace);
        if (syntax.alignment) decl.alignment = alignmentOperand(this, syntax.alignment);
        if (decl.kind === 'const') {
          decl.value = compiled.value;
          markConstantStorage(decl.cell, compiled.type);
        } else {
          markRuntimeStorage(decl.cell, compiled.type);
          const owner = decl.namespace.name.replace(/^main\.?/, '');
          this.globalVariables.push({
            name: owner ? `${owner}.${syntax.name}` : syntax.name,
            type: compiled.type,
            cell: decl.cell,
          });
        }
      }
    );
    decl.state = 'resolved';
  }

  /** A declaration's value, where a container takes the declaration's name. */
  protected compileDeclValue(value: Expression, declared: Type | undefined, name: string, owner?: string): TExpr {
    if (value.kind === 'container') {
      const qualified = `${this.enclosingNamespace().name}.${owner ? `${owner}.` : ''}${name}`;
      return known(TYPE, this.containerType(value, qualified), value);
    }
    return this.compile(value, declared);
  }

  // Container fields ------------------------------------------------------------------------------------------------

  /** The fields of a struct, resolving their types and default values on first use. */
  // code-gauge-allow functionCognitiveComplexity -- Keeps field type, layout and default-value checks in one pass.
  // code-gauge-allow functionNcss -- Keeps field type, layout and default-value checks in one pass.
  structFields(type: StructType, span: Span): StructField[] {
    if (type.fields) return type.fields;
    const syntax = type.namespace.syntax;
    if (!syntax) return [];
    type.fields = [];
    const fields: StructField[] = [];
    this.resolvingFields++;
    this.inContainerScope(type.namespace, () => {
      for (const [index, field] of syntax.fields.entries()) {
        if (!field.type) this.error(field, '構造体のフィールドには型を書いてください。');
        if (field.name === undefined && !type.isTuple)
          this.error(field, '構造体のフィールドには名前を書いてください。');
        const fieldType = this.compileType(field.type);
        if (type.layout === 'packed') this.checkPackedField(fieldType, 'struct', field);
        let defaultValue: Value | undefined;
        if (field.value) {
          const compiled = this.coerce(this.compile(field.value, fieldType), fieldType, field.value);
          defaultValue = this.knownValue(compiled, 'フィールドの初期値');
        }
        fields.push({
          name: field.name ?? String(index),
          type: fieldType,
          defaultValue,
          hasDefault: field.value !== undefined,
          ...(field.isComptime ? { comptimeValue: { value: defaultValue } } : {}),
          ...(field.alignment ? { alignment: this.fieldAlignment(type, field.alignment) } : {}),
        });
      }
    });
    this.resolvingFields--;
    type.fields = fields;
    const seen = new Set<Type>();
    for (const [index, field] of fields.entries()) {
      if (this.holdsByValue(field.type, type, seen)) {
        this.error(
          syntax.fields[index],
          `構造体 ${typeName(type)} が、フィールドに自分自身を値として持っています（ポインタにしてください）。`
        );
      }
    }
    // Zig checks a packed type's backing integer at the type's first use.
    if (type.layout !== 'auto') this.resolveStorage(type, span);
    return fields;
  }

  protected fieldIndexes(fields: readonly { name: string }[]): ReadonlyMap<string, number> {
    let indexes = this.indexedFields.get(fields);
    if (indexes) return indexes;
    const created = new Map<string, number>();
    for (const [index, field] of fields.entries()) {
      this.compilationBudget.spend();
      created.set(field.name, index);
    }
    this.indexedFields.set(fields, created);
    return created;
  }

  /** Resolves the fields of the structs and unions a value of `type` holds in place, which its undefined value needs. */
  // code-gauge-allow functionCognitiveComplexity -- Resolves the by-value type graph before validating and caching layouts.
  // code-gauge-allow functionNcss -- Resolves the by-value type graph before validating and caching layouts.
  private resolveLayout(type: Type, span: Span, seen: Set<Type>): void {
    if (type.kind === 'struct' && type.namespace.syntax?.containerKind === 'opaque')
      this.error(span, `opaque 型 ${typeName(type)} の値は持てません（ポインタにしてください）。`);
    if (type.kind === 'anyopaque') this.error(span, 'anyopaque 型の値は持てません（ポインタにしてください）。');
    if (seen.has(type) || hasResolvedLayout(type)) return;
    this.spendCompilation();
    seen.add(type);
    if (type.kind === 'array' || type.kind === 'optional') this.resolveLayout(type.child, span, seen);
    else if (type.kind === 'error_union') this.resolveLayout(type.payload, span, seen);
    else if (type.kind === 'enum') this.enumFields(type);
    else if (type.kind === 'struct') {
      const fields = this.structFields(type, span);
      for (const field of fields) {
        this.spendCompilation();
        this.resolveLayout(field.type, span, seen);
      }
      this.checkPackedBacking(type);
    } else if (type.kind === 'union') {
      const fields = this.unionFields(type);
      for (const field of fields) {
        this.spendCompilation();
        this.resolveLayout(field.type, span, seen);
      }
      if (type.layout === 'packed') {
        this.checkPackedUnion(fields, span);
        this.checkPackedBacking(type);
      }
    }
    if (this.resolvingFields === 0 && this.resolvingUnionFields === 0) {
      resolveTypeLayout(type, () => this.spendCompilation());
      resolveTypeSlots(type, () => this.spendCompilation());
    }
  }

  /** The alignment that `align(n)` gives a struct's field, which a packed struct's fields cannot override. */
  private fieldAlignment(type: StructType, expression: Expression): number {
    if (type.layout === 'packed') this.error(expression, 'packed struct のフィールドの整列は変えられません。');
    return alignmentOperand(this, expression);
  }

  /** Checks the backing integer that `packed struct(u8)` or `packed union(u8)` names against the fields' bits. */
  private checkPackedBacking(type: Extract<Type, { kind: 'struct' | 'union' }>): void {
    const syntax = type.namespace.syntax;
    if (type.layout !== 'packed' || !syntax?.argument) return;
    const argument = syntax.argument;
    this.inContainerScope(type.namespace, () => {
      const backing = this.compileType(argument);
      if (backing.kind !== 'int') this.error(argument, `packed ${type.kind} の基底型には整数型を指定してください。`);
      type.backingInteger = backing;
      const bits = bitSizeOf(type, () => this.spendCompilation());
      if (backing.bits !== bits)
        this.error(
          argument,
          `packed ${type.kind} の基底型は、${type.kind === 'struct' ? 'フィールドの合計' : 'フィールド'}と同じ ${bits} ビットにしてください。`
        );
    });
  }

  private checkPackedUnion(fields: readonly { type: Type }[], span: Span): void {
    if (fields.length === 0) this.error(span, 'packed union にはフィールドを書いてください。');
    let width: number | undefined;
    for (const field of fields) {
      this.spendCompilation();
      this.checkPackedField(field.type, 'union', span);
      const bits = bitSizeOf(field.type);
      if (width !== undefined && width !== bits)
        this.error(span, 'packed union のフィールドのビット数をそろえてください。');
      width = bits;
    }
  }

  private checkPackedField(type: Type, container: 'struct' | 'union', span: Span): void {
    switch (type.kind) {
      case 'int':
      case 'float':
      case 'bool':
      case 'void': {
        return;
      }
      case 'enum': {
        if (type.namespace.syntax?.argument !== undefined) return;
        break;
      }
      case 'struct':
      case 'union': {
        if (type.layout === 'packed') return;
        break;
      }
    }
    this.error(span, `${typeName(type)} 型は、packed ${container} のフィールドにできません。`);
  }

  /** Whether a value of `type` contains a `target` in place, not behind a pointer, which would have no size. */
  // code-gauge-allow duplicateLines -- By-value cycle detection and comptime classification traverse similar graphs with different leaf and field predicates.
  private holdsByValue(type: Type, target: Type, seen: Set<Type>): boolean {
    this.spendCompilation();
    if (type === target) return true;
    if (seen.has(type)) return false;
    seen.add(type);
    switch (type.kind) {
      case 'array':
      case 'optional': {
        return this.holdsByValue(type.child, target, seen);
      }
      case 'error_union': {
        return this.holdsByValue(type.payload, target, seen);
      }
      case 'struct': {
        return (type.fields ?? []).some((field) => this.holdsByValue(field.type, target, seen));
      }
      case 'union': {
        return (type.fields ?? []).some((field) => this.holdsByValue(field.type, target, seen));
      }
      default: {
        return false;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Checks each rule of Zig's type coercion or container analysis in turn.
  // code-gauge-allow functionNcss -- Resolves enum tags, indexed uniqueness, and integer range checks in declaration order.
  enumFields(type: EnumType): NonNullable<EnumType['fields']> {
    if (type.fields) return type.fields;
    const syntax = type.namespace.syntax;
    if (!syntax) return [];
    this.inContainerScope(type.namespace, () => {
      const declaredTag = syntax.argument ? this.compileType(syntax.argument) : undefined;
      if (declaredTag && declaredTag.kind !== 'int') this.error(syntax, 'enum のタグの型は整数の型にしてください。');
      const named = syntax.fields.filter((field) => !isDiscardName(field));
      type.exhaustive = named.length === syntax.fields.length;
      const fields: { name: string; value: bigint }[] = [];
      let next = 0n;
      const values = new Set<bigint>();
      for (const field of named) {
        this.spendCompilation();
        let value = next;
        if (field.value) {
          if (!declaredTag) this.error(field, 'enum の値を指定するときは、整数のタグの型を書いてください。');
          const tagType = declaredTag as IntType;
          value = this.knownValue(
            this.coerce(this.compile(field.value, tagType), tagType, field.value),
            'enum の値'
          ) as bigint;
        }
        if (values.has(value)) this.error(field, `enum の値 ${value} が重複しています。`);
        values.add(value);
        fields.push({ name: field.name as string, value });
        next = value + 1n;
      }
      const tagType = (declaredTag as IntType | undefined) ?? smallestUnsigned(Math.max(fields.length - 1, 0));
      for (const [index, field] of fields.entries()) {
        if (!fitsInt(field.value, tagType)) {
          this.error(syntax.fields[index], `enum の値 ${field.value} は、タグの型 ${typeName(tagType)} に入りません。`);
        }
      }
      type.tagType = tagType;
      type.fields = fields;
    });
    return type.fields ?? [];
  }

  unionFields(type: UnionType): NonNullable<UnionType['fields']> {
    if (type.fields) return type.fields;
    const syntax = type.namespace.syntax;
    if (!syntax) return [];
    this.resolvingUnionFields++;
    this.inContainerScope(type.namespace, () => {
      const fields = syntax.fields.map((field) => {
        this.spendCompilation();
        if (field.name === undefined) this.error(field, 'union のフィールドには名前を書いてください。');
        return { name: field.name, type: field.type ? this.compileType(field.type) : VOID };
      });
      type.fields = fields;
      if (syntax.taggedByEnum) {
        const tagNamespace: Namespace = {
          name: `@typeInfo(${type.namespace.name}).@"union".tag_type.?`,
          decls: new Map(),
          scope: this.scope,
          syntax: { ...syntax, containerKind: 'enum' },
        };
        type.tagType = {
          kind: 'enum',
          namespace: tagNamespace,
          tagType: undefined,
          fields: undefined,
          exhaustive: true,
          unionOf: type,
        };
        this.enumFields(type.tagType);
      } else if (syntax.argument && type.layout !== 'packed') {
        const tagType = this.compileType(syntax.argument);
        if (tagType.kind !== 'enum') this.error(syntax, 'union(T) の T は enum の型にしてください。');
        const tagFields = this.enumFields(tagType);
        const tagNames = new Set(tagFields.map((field) => field.name));
        const fieldNames = new Set(fields.map((field) => field.name));
        for (const field of fields) {
          this.spendCompilation();
          if (!tagNames.has(field.name)) {
            this.error(syntax, `enum ${typeName(tagType)} には、フィールド「${field.name}」がありません。`);
          }
        }
        for (const tag of tagFields) {
          this.spendCompilation();
          if (!fieldNames.has(tag.name)) {
            this.error(syntax, `union にフィールド「${tag.name}」がありません。`);
          }
        }
        if (fields.some((field, index) => field.name !== tagFields[index]?.name))
          this.error(syntax, 'union のフィールドの順序は、タグの enum とそろえてください。');
        type.tagType = tagType;
      }
    });
    this.resolvingUnionFields--;
    if (type.layout !== 'auto') this.resolveStorage(type, syntax);
    return type.fields ?? [];
  }

  private inContainerScope(namespace: Namespace, run: () => void): void {
    const outer = (namespace.scope as Scope | undefined) ?? this.scope;
    this.withScope({ namespace, parent: outer }, run);
  }

  // Coercion --------------------------------------------------------------------------------------------------------

  /** Converts an expression to a type as Zig's implicit coercions do, or reports that it cannot. */
  coerce(expression: TExpr, to: Type, span: Span = expression.span): TExpr {
    const converted = this.tryCoerce(expression, to, span);
    if (converted) return converted;
    return this.error(span, mismatch(to, expression.type));
  }

  protected tryCoerce(expression: TExpr, to: Type, span: Span): TExpr | undefined {
    if (!expression.known && expression.staticResult) {
      const converted = this.tryCoerce(known(expression.type, expression.staticResult.value, span), to, span);
      if (!converted) return undefined;
      return {
        ...runtime(
          to,
          (frame) => {
            expression.eval(frame);
            return converted.eval(frame);
          },
          span
        ),
        staticResult: { value: converted.value },
      };
    }

    const from = expression.type;
    if (from === to) return expression;
    if (from.kind === 'noreturn') return { ...expression, type: to };
    if (from.kind === 'undefined') {
      this.resolveLayout(to, span, new Set());
      this.storage.reserve(to);
      return known(to, undefinedValue(to), span);
    }
    switch (to.kind) {
      case 'int': {
        return this.coerceToInt(expression, to, span);
      }
      case 'comptime_int': {
        if (from.kind === 'int' && expression.known) return known(to, expression.value, span);
        if (from.kind === 'comptime_float' && expression.known) {
          const value = expression.value as BigFloat;
          if (!isIntegral(value)) this.error(span, fractional(value, to));
          return known(to, truncateToBigInt(value), span);
        }
        return undefined;
      }
      case 'float': {
        return this.coerceToFloat(expression, to, span);
      }
      case 'comptime_float': {
        if (from.kind === 'comptime_int' && expression.known) {
          return known(to, asBigFloat(floatFromBigInt(expression.value as bigint, 128)), span);
        }
        if (from.kind === 'float' && expression.known)
          return known(to, roundTo(asBigFloat(expression.value as AnyFloat), 128), span);
        return undefined;
      }
      case 'optional': {
        return this.coerceToOptional(expression, to, span);
      }
      case 'error_union': {
        return this.coerceToErrorUnion(expression, to, span);
      }
      case 'error_set': {
        return this.coerceToErrorSet(expression, to, span);
      }
      case 'fn': {
        if (from.kind !== 'fn' || (expression.value instanceof NativeFn && !expression.value.signature))
          return undefined;
        const signature = this.functionSignature(expression, span);
        const fn =
          signature.returnType.kind === 'error_union' && signature.returnType.errorSet.resolved === false
            ? this.functionOf(expression, span)
            : signature;
        if (!fnTypeCoercible(fn.params, fn.returnType, to)) return undefined;
        return { ...expression, type: to };
      }
      case 'pointer': {
        return this.coerceToPointer(expression, to, span);
      }
      case 'enum': {
        if (from.kind === 'enum_literal' && expression.known) {
          const { name } = expression.value as EnumLiteral;
          const field = enumLookup(this.enumFields(to), () => this.spendCompilation()).byName.get(name);
          if (!field) this.error(span, `enum ${typeName(to)} には、フィールド「${name}」がありません。`);
          return known(to, field.value, span);
        }
        if (from.kind === 'union' && from.tagType === to) {
          this.unionFields(from);
          const tags = this.enumFields(to);
          return this.derived(expression, to, (value) => unionTagValue(value as ZUnion, tags));
        }
        return undefined;
      }
      case 'union': {
        const fields = this.unionFields(to);
        if (from.kind === 'enum_literal' && expression.known) {
          const { name } = expression.value as EnumLiteral;
          const index = this.fieldIndexes(fields).get(name);
          if (index === undefined) this.error(span, `union ${typeName(to)} には、フィールド「${name}」がありません。`);
          if (fields[index].type.kind !== 'void') {
            this.error(span, `union のフィールド「${name}」には値が要るので、.${name} だけでは作れません。`);
          }
          return this.materializeUnion(to, index, known(VOID, undefined, span), span);
        }
        if (from.kind === 'enum' && to.tagType === from && expression.known) {
          const tag = enumLookup(this.enumFields(from), () => this.spendCompilation()).byValue.get(
            expression.value as bigint
          );
          const index = tag && this.fieldIndexes(fields).get(tag.name);
          if (index === undefined || fields[index].type.kind !== 'void') return undefined;
          return this.materializeUnion(to, index, known(VOID, undefined, span), span);
        }
        return undefined;
      }
      case 'array': {
        return this.coerceAggregateSource(expression, (source) => this.coerceToArray(source, to, span));
      }
      case 'struct': {
        return this.coerceAggregateSource(expression, (source) => this.coerceToStruct(source, to, span));
      }
      default: {
        return undefined;
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Checks each rule of Zig's type coercion or container analysis in turn.
  private coerceToInt(expression: TExpr, to: IntType, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'comptime_int' || (from.kind === 'int' && expression.known)) {
      if (!expression.known && this.context.comptimeDepth > 0) return this.checkedComptimeInt(expression, to);
      if (!expression.known) return undefined;
      const value = expression.value as bigint;
      if (!fitsInt(value, to)) this.error(span, `${typeName(to)} 型では、整数 ${value} を表せません。`);
      return known(to, value, span);
    }
    if (from.kind === 'int' && intWidens(from, to)) return { ...expression, type: to };
    if (from.kind === 'int' && this.context.comptimeDepth > 0) return this.checkedComptimeInt(expression, to);
    if (from.kind === 'int') return undefined;
    if ((from.kind === 'comptime_float' || from.kind === 'float') && expression.known) {
      const value = asBigFloat(expression.value as AnyFloat);
      if (!isIntegral(value)) this.error(span, fractional(value, to));
      const integer = truncateToBigInt(value);
      if (!fitsInt(integer, to)) this.error(span, `${typeName(to)} 型では、整数 ${integer} を表せません。`);
      return known(to, integer, span);
    }
    return undefined;
  }

  /**
   * An integer that code the compiler runs reads as it runs, such as a `comptime var` in a `comptime` block's loop,
   * which Zig knows at every step: whether it fits the type is checked when the code runs.
   */
  private checkedComptimeInt(expression: TExpr, to: IntType): TExpr {
    return this.derived(expression, to, (value) =>
      fitsInt(value as bigint, to) ? value : panic(`${typeName(to)} cannot represent integer value ${value as bigint}`)
    );
  }

  // code-gauge-allow functionCognitiveComplexity -- Checks each rule of Zig's type coercion or container analysis in turn.
  private coerceToFloat(expression: TExpr, to: Extract<Type, { kind: 'float' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'comptime_float' && expression.known) {
      return known(to, floatOf(expression.value as BigFloat, to.bits), span);
    }
    if ((from.kind === 'comptime_int' || from.kind === 'int') && expression.known) {
      const integer = expression.value as bigint;
      const converted = floatFromBigInt(integer, to.bits);
      if (isInfinite(converted) || truncateToBigInt(converted) !== integer) {
        this.error(span, `${typeName(to)} 型では、整数 ${integer} を表せません。`);
      }
      return known(to, converted, span);
    }
    if (from.kind === 'float' && expression.known) {
      const value = asBigFloat(expression.value as AnyFloat);
      const converted = floatOf(value, to.bits);
      if (value.kind !== 'nan' && compareFloats(value, converted) !== 0)
        this.error(span, `${typeName(to)} 型では、浮動小数点数を正確に表せません。`);
      return known(to, converted, span);
    }
    if (from.kind === 'float' && from.bits <= to.bits) {
      if (to.bits <= 64) return { ...expression, type: to };
      return this.derived(expression, to, (value) => floatOf(asBigFloat(value as AnyFloat), to.bits));
    }
    if (from.kind === 'int') {
      if (!intFitsFloatExactly(from, to)) return undefined;
      return this.derived(expression, to, (value) => floatFromBigInt(value as bigint, to.bits));
    }
    return undefined;
  }

  private coerceToOptional(expression: TExpr, to: Extract<Type, { kind: 'optional' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'null') return known(to, NULL, span);
    if (from.kind === 'optional' && inMemoryCoercible(from.child, to.child)) return { ...expression, type: to };
    if (from.kind === 'optional' && to.child.kind !== 'optional') return undefined;
    const payload = this.tryCoerce(expression, to.child, span);
    if (!payload) return undefined;
    if (to.child.kind !== 'optional')
      return { ...payload, type: to, place: undefined, valueFacts: { payload: valueFactsOf(payload) } };
    return { ...this.derived(payload, to, (value) => new Some(value)), valueFacts: { payload: valueFactsOf(payload) } };
  }

  private coerceToErrorSet(expression: TExpr, to: ErrorSetType, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind !== 'error_set') return undefined;
    if (to.names === undefined) return { ...expression, type: to };
    if (this.growsErrorSet(to)) {
      addErrors(to, from, expression);
      return { ...expression, type: to };
    }
    if (expression.known) {
      const { name } = expression.value as ErrorValue;
      if (!to.names.has(name)) this.error(span, `error.${name} は、エラー集合 ${typeName(to)} にありません。`);
      return known(to, expression.value, span);
    }
    if (from.names && [...from.names].every((name) => to.names?.has(name))) return { ...expression, type: to };
    return undefined;
  }

  private coerceToErrorUnion(
    expression: TExpr,
    to: Extract<Type, { kind: 'error_union' }>,
    span: Span
  ): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'error_union') {
      if (this.growsErrorSet(to.errorSet)) addErrors(to.errorSet, from.errorSet, undefined);
      if (!errorSetIncludes(to.errorSet, from.errorSet) || !inMemoryCoercible(from.payload, to.payload))
        return undefined;
      return { ...expression, type: to };
    }
    if (from.kind === 'error_set') {
      const converted = this.tryCoerce(expression, to.errorSet, span);
      return converted ? { ...converted, type: to } : undefined;
    }
    const payload = this.tryCoerce(expression, to.payload, span);
    return payload
      ? { ...payload, type: to, place: undefined, valueFacts: { payload: valueFactsOf(payload) } }
      : undefined;
  }

  // code-gauge-allow functionCognitiveComplexity -- Checks each rule of Zig's type coercion or container analysis in turn.
  private coerceToPointer(expression: TExpr, to: Extract<Type, { kind: 'pointer' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'fn') {
      if (!to.isConst || to.size !== 'one' || to.child.kind !== 'fn') return undefined;
      const fn = this.functionOf(expression, span);
      if (!fnTypeCoercible(fn.params, fn.returnType, to.child)) return undefined;
      return known(to, this.knownFunctionValue(expression, span), span);
    }
    if (to.size === 'c' && from.kind !== 'pointer') return this.coerceToCPointer(expression, to, span);
    if (from.kind !== 'pointer') return undefined;
    const rule = pointerCoercionOf(from, to);
    if (!rule || !pointerQualifiersCoercible(from, to)) return undefined;
    const array = from.child.kind === 'array' ? from.child : undefined;
    // A constant empty array converts to a pointer to variables, which it has no element to break.
    const empty = rule.element === 'arrayChild' && to.sentinel === undefined && array?.length === 0n;
    if (from.isConst && !to.isConst && !empty) return undefined;
    const source = rule.element === 'arrayChild' ? (array as ArrayType) : from;
    if (!pointerChildCoercible(source.child, to.child, to.isConst || empty)) return undefined;
    const sentinelHolds =
      rule.sentinel === 'none' ||
      sameSentinel(source.sentinel, to.sentinel) ||
      (rule.sentinel === 'target' && to.sentinel === undefined);
    return sentinelHolds ? this.convertPointer(expression, from, to, rule.convert) : undefined;
  }

  /** A converted pointer, which refers into the same `comptime var` as the pointer it converts. */
  private convertPointer(
    expression: TExpr,
    from: Extract<Type, { kind: 'pointer' }>,
    to: Extract<Type, { kind: 'pointer' }>,
    convert: PointerConversion
  ): TExpr {
    const converted = this.convertedPointer(expression, from, to, convert);
    const variable = this.comptimeVarOf(expression);
    if (variable && converted.known && (converted.value instanceof Pointer || converted.value instanceof Slice))
      this.comptimeVarReferences.set(converted.value, variable);
    return converted;
  }

  private convertedPointer(
    expression: TExpr,
    from: Extract<Type, { kind: 'pointer' }>,
    to: Extract<Type, { kind: 'pointer' }>,
    convert: PointerConversion
  ): TExpr {
    switch (convert) {
      case 'retype': {
        return { ...expression, type: to };
      }
      case 'fromC': {
        return this.derived(expression, to, (value) =>
          value === NULL ? panic('cast causes pointer to be null') : value
        );
      }
      case 'sliceToMany': {
        return this.derived(expression, to, (value) => new Pointer((value as Slice).target, (value as Slice).start));
      }
      case 'arrayToMany': {
        const array = from.child as ArrayType;
        return this.derived(expression, to, (value) => {
          const view = arrayPointerView(value as Pointer, array, sizeOf(array.child));
          return new Pointer(view, view.offset);
        });
      }
      case 'arrayToSlice': {
        const array = from.child as ArrayType;
        const { length } = array;
        return {
          ...this.derived(expression, to, (value) => {
            const view = arrayPointerView(value as Pointer, array, sizeOf(array.child));
            return new Slice(view, view.offset, length);
          }),
          knownLength: expression.known ? length : expression.knownLength,
        };
      }
    }
  }

  /** `null` or an optional pointer to `[*c]T`, which holds null itself. */
  private coerceToCPointer(expression: TExpr, to: Extract<Type, { kind: 'pointer' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'null') return known(to, NULL, span);
    if (from.kind !== 'optional' || from.child.kind !== 'pointer') return undefined;
    // Only a pointer whose value stays as it is converts, since the optional's null stays null.
    if (pointerCoercionOf(from.child, to)?.convert !== 'retype') return undefined;
    return this.tryCoerce({ ...expression, type: from.child }, to, span) && { ...expression, type: to };
  }

  /** A function value that the compiler knows, as a runtime function pointer. */
  abstract knownFunctionValue(expression: TExpr, span: Span): FnValue;

  private coerceAggregateSource(expression: TExpr, convert: (source: TExpr) => TExpr | undefined): TExpr | undefined {
    if (expression.known) return convert(expression);
    const held = new WeakMap<Frame, Value>();
    const result = convert({ ...expression, eval: (frame) => held.get(frame) });
    if (!result) return undefined;
    return {
      ...runtime(
        result.type,
        (frame) => {
          const source = expression.eval(frame);
          const previous = held.get(frame);
          const mark = frame.temporaries.length;
          held.set(frame, source);
          frame.temporaries.push({ value: source, type: expression.type });
          try {
            return result.eval(frame);
          } finally {
            frame.temporaries.length = mark;
            if (previous === undefined) held.delete(frame);
            else held.set(frame, previous);
          }
        },
        expression.span
      ),
      staticResult: staticResultOf(result),
      valueFacts: result.valueFacts,
    };
  }

  private coerceToArray(expression: TExpr, to: Extract<Type, { kind: 'array' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'array') {
      if (from.length !== to.length || !inMemoryCoercible(from.child, to.child)) return undefined;
      if (to.sentinel !== undefined && !sameSentinel(from.sentinel, to.sentinel)) return undefined;
      return { ...expression, type: to };
    }
    if (from.kind === 'struct' && from.isTuple) {
      const fields = from.fields ?? [];
      if (BigInt(fields.length) !== to.length) {
        this.error(span, `配列の長さが合いません（${to.length} 個が必要ですが、${fields.length} 個です）。`);
      }
      const elements = fields.map((field, index) =>
        this.coerce(this.tupleElement(expression, index, field, span), to.child, span)
      );
      return this.aggregate(to, elements, span, (values) => newArray(values, to.sentinel));
    }
    return undefined;
  }

  private coerceToStruct(expression: TExpr, to: StructType, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind !== 'struct' || !from.isTuple || !to.isTuple) return undefined;
    const sourceFields = from.fields ?? [];
    const targetFields = this.structFields(to, span);
    if (sourceFields.length !== targetFields.length) return undefined;
    const elements = targetFields.map((field, index) => {
      this.compilationBudget.spend();
      return this.coerce(this.tupleElement(expression, index, sourceFields[index], span), field.type, span);
    });
    return this.aggregate(to, elements, span, (values) => new ZStruct(values));
  }

  protected structInitializerPlan(
    expression: ExpressionOf<'structInit'>,
    type: StructType
  ): { position: number; field: StructField; value: Expression | undefined }[] {
    const fields = this.structFields(type, expression);
    const indexes = this.fieldIndexes(fields);
    const seen = new Set<string>();
    const plan = expression.fields.map<{ position: number; field: StructField; value: Expression | undefined }>(
      (init) => {
        this.compilationBudget.spend();
        const position = indexes.get(init.name);
        if (position === undefined)
          this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
        if (seen.has(init.name)) this.error(init, `フィールド「${init.name}」を2回初期化しています。`);
        seen.add(init.name);
        return { position, field: fields[position], value: init.value };
      }
    );
    for (const [position, field] of fields.entries()) {
      this.compilationBudget.spend();
      if (seen.has(field.name)) continue;
      if (!field.hasDefault) this.error(expression, `フィールド「${field.name}」の値がありません。`);
      plan.push({ position, field, value: undefined });
    }
    return plan;
  }

  protected nativeDefault(type: StructType, span: Span, operand?: TExpr): TExpr {
    const initialize = type.native?.defaultValue;
    if (!initialize) return this.error(span, `${typeName(type)} 型には初期化に必要なフィールドがあります。`);
    this.storage.reserve(type);
    return operand ? this.fixedResult(operand, type, initialize(), span) : known(type, initialize(), span);
  }

  /** The `index`th field of a tuple or anonymous struct value. */
  protected tupleElement(expression: TExpr, index: number, field: StructField, span: Span): TExpr {
    if (field.comptimeValue !== undefined) return known(field.type, field.comptimeValue.value, span);
    if (expression.known) return known(field.type, (expression.value as ZStruct).slots[index], span);
    const evaluate = expression.eval;
    const facts = fieldFacts(valueFactsOf(expression), index);
    const result = facts?.exact
      ? this.fixedResult(expression, field.type, facts.exact.value, span)
      : runtime(field.type, (frame) => (evaluate(frame) as ZStruct).slots[index], span);
    return { ...result, valueFacts: facts, knownLength: facts?.length };
  }

  protected comptimeOperand(operand: TExpr): TExpr {
    return staticResultOf(operand) ? operand : known(operand.type, this.knownValue(operand, '値'), operand.span);
  }

  protected combine(
    operands: readonly TExpr[],
    type: Type,
    compute: (values: Value[], frame?: Frame) => Value,
    span: Span,
    result = this.constantResult(operands, compute, span)
  ): TExpr {
    if (operands.every((operand) => operand.known)) return known(type, result?.value, span);
    const evaluators = valueEvaluators(operands, false);
    return {
      ...runtime(
        type,
        (frame) => {
          const values = evaluateHeld(frame, evaluators);
          return result ? copyFrameStorage(frame, result.value, type) : compute(values, frame);
        },
        span
      ),
      staticResult: result,
    };
  }

  protected constantResult(
    operands: readonly TExpr[],
    compute: (values: Value[]) => Value,
    span: Span
  ): { value: Value } | undefined {
    const facts = operands.map(staticResultOf);
    let result: { value: Value } | undefined;
    if (facts.every((fact) => fact !== undefined)) {
      try {
        result = { value: compute(facts.map((fact) => fact.value)) };
      } catch (error) {
        if (error instanceof MemoryFault) return this.error(span, 'undefined のポインタは参照できません。');
        if (error instanceof ZigPanic)
          return this.error(span, `値が決まっている計算が、実行時のエラー（${error.text}）になります。`);
        throw error;
      }
    }
    return result;
  }

  protected singleReturningResult(expressions: readonly TExpr[]): { value: Value } | undefined {
    const returning = expressions.filter((expression) => expression.type.kind !== 'noreturn');
    return returning.length === 1 ? staticResultOf(returning[0]) : undefined;
  }

  /** An aggregate built from elements, known when they all are. */
  protected aggregate(
    type: Type,
    elements: readonly TExpr[],
    span: Span,
    build: (values: Value[]) => Value,
    retainFacts = false
  ): TExpr {
    this.reserveStorage(type, span);
    if (elements.every((element) => element.known)) {
      this.spendCompilation(elements.length);
      return known(type, build(elements.map((element) => copyIntoReservedStorage(element.value))), span);
    }
    const evaluators = valueEvaluators(elements, false);
    return {
      ...runtime(
        type,
        (frame) => {
          frame.runtime.reserveStorage(valueSlots(type));
          frame.runtime.spend(elements.length);
          return build(evaluateHeld(frame, evaluators, copyIntoReservedStorage));
        },
        span
      ),
      staticResult: this.constantResult(
        elements,
        (values) => {
          this.spendCompilation(values.length);
          return build(values.map(copyIntoReservedStorage));
        },
        span
      ),
      valueFacts: retainFacts ? aggregateFacts(elements, () => this.spendCompilation()) : undefined,
    };
  }

  protected fixedResult(operand: TExpr, type: Type, value: Value, span: Span = operand.span): TExpr {
    if (operand.known || operand.local?.isConst) return known(type, value, span);
    return {
      ...runtime(
        type,
        (frame) => {
          operand.eval(frame);
          return value;
        },
        span
      ),
      staticResult: { value },
    };
  }

  /** An expression of another type whose value a function computes from the original's. */
  protected derived(
    expression: TExpr,
    type: Type,
    convert: (value: Value, frame?: Frame) => Value,
    allocates = false
  ): TExpr {
    const sourceResult = staticResultOf(expression);
    let result: { value: Value } | undefined;
    if (sourceResult) {
      try {
        result = { value: convert(sourceResult.value) };
      } catch (error) {
        if (error instanceof MemoryFault) return this.error(expression.span, 'undefined のポインタは参照できません。');
        if (error instanceof ZigPanic)
          return this.error(expression.span, `コンパイルのときの計算が失敗しました: ${error.text}`);
        throw error;
      }
    }
    if (expression.known) return known(type, result?.value, expression.span);
    const evaluate = expression.eval;
    return {
      ...runtime(
        type,
        (frame) => {
          const value = evaluate(frame);
          if (result) return copyFrameStorage(frame, result.value, type);
          if (allocates) frame.runtime.reserveStorage(valueSlots(type));
          return convert(value, frame);
        },
        expression.span
      ),
      staticResult: result,
    };
  }

  // Peer types ------------------------------------------------------------------------------------------------------

  /** The type that Zig's peer type resolution gives the results of branches and the operands of operators. */
  peerType(expressions: readonly TExpr[], span: Span): Type {
    const relevant = expressions.filter((expression) => expression.type.kind !== 'noreturn');
    if (relevant.length === 0) return expressions[0]?.type ?? VOID;
    let result = relevant[0].type;
    for (const expression of relevant.slice(1)) {
      const next = this.peerPair(result, expression.type, relevant);
      if (!next) {
        this.error(span, `型 ${typeName(result)} と ${typeName(expression.type)} をそろえられません。`);
      }
      result = next;
    }
    return result;
  }

  private peerPair(a: Type, b: Type, all: readonly TExpr[]): Type | undefined {
    if (a === b) return a;
    if (a.kind === 'undefined') return b;
    if (b.kind === 'undefined') return a;
    if (a.kind === 'null') return b.kind === 'optional' ? b : optionalOf(b);
    if (b.kind === 'null') return a.kind === 'optional' ? a : optionalOf(a);
    if (a.kind === 'optional' || b.kind === 'optional') {
      const child = this.peerPair(a.kind === 'optional' ? a.child : a, b.kind === 'optional' ? b.child : b, all);
      return child ? optionalOf(child) : undefined;
    }
    if (a.kind === 'error_set' && b.kind === 'error_set') return mergeErrorSets(a, b);
    if (a.kind === 'error_union' || b.kind === 'error_union' || a.kind === 'error_set' || b.kind === 'error_set') {
      const setA = a.kind === 'error_union' ? a.errorSet : a.kind === 'error_set' ? a : undefined;
      const setB = b.kind === 'error_union' ? b.errorSet : b.kind === 'error_set' ? b : undefined;
      const payloadA = a.kind === 'error_union' ? a.payload : a.kind === 'error_set' ? undefined : a;
      const payloadB = b.kind === 'error_union' ? b.payload : b.kind === 'error_set' ? undefined : b;
      const set = setA && setB ? mergeErrorSets(setA, setB) : ((setA ?? setB) as ErrorSetType);
      const payload = payloadA && payloadB ? this.peerPair(payloadA, payloadB, all) : (payloadA ?? payloadB);
      return payload ? errorUnionOf(set, payload) : undefined;
    }
    if (a.kind === 'comptime_int' && (b.kind === 'int' || b.kind === 'float' || b.kind === 'comptime_float')) return b;
    if (b.kind === 'comptime_int' && (a.kind === 'int' || a.kind === 'float' || a.kind === 'comptime_float')) return a;
    if (a.kind === 'comptime_float' && b.kind === 'float') return b;
    if (b.kind === 'comptime_float' && a.kind === 'float') return a;
    if (a.kind === 'int' && b.kind === 'int') {
      if (intWidens(a, b)) return b;
      if (intWidens(b, a)) return a;
      const selected = a.bits >= b.bits ? a : b;
      const fits = all.every(
        (expression) =>
          expression.type.kind !== 'int' ||
          intWidens(expression.type, selected) ||
          (staticResultOf(expression) !== undefined && fitsInt(staticResultOf(expression)?.value as bigint, selected))
      );
      return fits ? selected : undefined;
    }
    if (a.kind === 'float' && b.kind === 'float') return a.bits >= b.bits ? a : b;
    if ((a.kind === 'int' && b.kind === 'float') || (a.kind === 'float' && b.kind === 'int')) {
      const float = a.kind === 'float' ? a : (b as FloatType);
      const exact = all.every(
        (expression) =>
          expression.type.kind !== 'int' || expression.known || intFitsFloatExactly(expression.type, float)
      );
      return exact ? float : undefined;
    }
    if (a.kind === 'enum_literal' && (b.kind === 'enum' || b.kind === 'union')) return b;
    if (b.kind === 'enum_literal' && (a.kind === 'enum' || a.kind === 'union')) return a;
    if (a.kind === 'pointer' && b.kind === 'pointer') return peerPointers(a, b);
    if (isTupleType(a) && isTupleType(b)) return this.peerTuples(a, b);
    if (a.kind === 'noreturn') return b;
    if (b.kind === 'noreturn') return a;
    return undefined;
  }

  /** Two tuples of the same length resolve to the tuple of their fields' peer types, as Zig's anonymous tuples do. */
  private peerTuples(a: StructType, b: StructType): Type | undefined {
    const left = a.fields ?? [];
    const right = b.fields ?? [];
    if (left.length !== right.length) return undefined;
    const types = left.map((field, index) => this.peerPair(field.type, right[index].type, []));
    if (types.some((type) => type === undefined)) return undefined;
    return this.tupleType(types.map((type, index) => ({ name: String(index), type: type as Type, hasDefault: false })));
  }
}

function isTupleType(type: Type): type is StructType {
  return type.kind === 'struct' && type.isTuple;
}

function addDecls(namespace: Namespace, members: readonly ContainerMember[]): void {
  for (const member of members) {
    if (member.kind === 'fn') {
      namespace.decls.set(member.name, {
        kind: 'fn',
        syntax: member as FunctionDeclaration,
        namespace,
      });
    } else {
      namespace.decls.set(member.name, {
        kind: member.isConst ? 'const' : 'var',
        syntax: member,
        namespace,
        state: 'unresolved',
      });
    }
  }
}

export { addDecls };

export function mismatch(expected: Type, found: Type): string {
  return `型が合いません（${typeName(expected)} 型が必要ですが、${typeName(found)} 型です）。`;
}

function fractional(value: BigFloat, to: Type): string {
  return `小数部分があるので、${describeFloat(value)} を ${typeName(to)} 型にできません。`;
}

function describeFloat(value: BigFloat): string {
  return String(floatOf(value, 64));
}

/** Adds the errors a value of an error set may hold to an inferred error set. */
function addErrors(to: ErrorSetType, from: ErrorSetType, value: TExpr | undefined): void {
  if (!to.names) return;
  if (value?.known && value.value instanceof ErrorValue) to.names.add(value.value.name);
  else if (from.names) for (const name of from.names) to.names.add(name);
  else to.names = undefined;
}

/** Whether a float type represents every value of an integer type exactly, which lets them be peers at run time. */
function intFitsFloatExactly(int: IntType, float: FloatType): boolean {
  const magnitudeBits = int.signed ? int.bits - 1 : int.bits;
  return magnitudeBits <= FORMATS[float.bits].precision;
}

/** Whether every value of one integer type fits another. */
export function intWidens(from: IntType, to: IntType): boolean {
  if (from.signed === to.signed) return from.bits <= to.bits;
  if (!from.signed && to.signed) return from.bits < to.bits;
  return from.bits === 0;
}

/** Whether a value of one type is a value of another without conversion, as pointers' and optionals' children need. */
// code-gauge-allow functionCognitiveComplexity -- Checks each rule of Zig's type coercion or container analysis in turn.
export function inMemoryCoercible(from: Type, to: Type): boolean {
  if (from === to) return true;
  const sourcePointer = pointerRepresentation(from);
  const targetPointer = pointerRepresentation(to);
  if (sourcePointer && targetPointer) return pointerRepresentationCoercible(from, to, sourcePointer, targetPointer);
  if (from.kind === 'optional' && to.kind === 'optional') {
    if (Boolean(sourcePointer) !== Boolean(targetPointer)) return false;
    return inMemoryCoercible(from.child, to.child);
  }
  if (from.kind === 'fn' && to.kind === 'fn') return fnTypeCoercible(from.params, from.returnType, to);
  if (from.kind === 'error_set' && to.kind === 'error_set') return errorSetIncludes(to, from);
  if (from.kind === 'error_union' && to.kind === 'error_union') {
    return errorSetIncludes(to.errorSet, from.errorSet) && inMemoryCoercible(from.payload, to.payload);
  }
  if (from.kind === 'array' && to.kind === 'array') {
    return (
      from.length === to.length &&
      inMemoryCoercible(from.child, to.child) &&
      (to.sentinel === undefined || sameSentinel(from.sentinel, to.sentinel))
    );
  }
  if (from.kind === 'int' && to.kind === 'int') return from.bits === to.bits && from.signed === to.signed;
  return false;
}

/** Whether a pointer keeps the guarantees of another: no volatile, zero address, or weaker alignment it lacks. */
function pointerQualifiersCoercible(
  from: Extract<Type, { kind: 'pointer' }>,
  to: Extract<Type, { kind: 'pointer' }>
): boolean {
  if (from.isVolatile && !to.isVolatile) return false;
  if (from.allowZero && !(to.allowZero || to.size === 'c')) return false;
  if (from.alignment === undefined && to.alignment === undefined) return true;
  const fromChild =
    from.size === 'one' && from.child.kind === 'array' && to.size !== 'one' ? from.child.child : from.child;
  return (from.alignment ?? alignOf(fromChild)) >= (to.alignment ?? alignOf(to.child));
}

function pointerRepresentation(type: Type): Extract<Type, { kind: 'pointer' }> | undefined {
  if (type.kind === 'pointer') return type;
  if (type.kind === 'optional' && type.child.kind === 'pointer' && type.child.size !== 'slice') return type.child;
  return undefined;
}

function pointerRepresentationCoercible(
  from: Type,
  to: Type,
  source: Extract<Type, { kind: 'pointer' }>,
  target: Extract<Type, { kind: 'pointer' }>
): boolean {
  if (from.kind === 'optional' && to.kind !== 'optional') return false;
  if (source.size !== target.size || (source.isConst && !target.isConst)) return false;
  if (!pointerQualifiersCoercible(source, target)) return false;
  if (target.sentinel !== undefined && !sameSentinel(source.sentinel, target.sentinel)) return false;
  return pointerChildCoercible(source.child, target.child, target.isConst);
}

export function errorSetIncludes(set: ErrorSetType, subset: ErrorSetType): boolean {
  if (set.names === undefined) return true;
  if (subset.names === undefined) return false;
  return [...subset.names].every((name) => set.names?.has(name));
}

export function mergeErrorSets(a: ErrorSetType, b: ErrorSetType): ErrorSetType {
  if (a.names === undefined || b.names === undefined) return a.names === undefined ? a : b;
  if (errorSetIncludes(a, b)) return a;
  if (errorSetIncludes(b, a)) return b;
  return errorSetOf([...a.names, ...b.names]);
}

// code-gauge-allow functionCognitiveComplexity -- Intersects pointer qualifiers, array lengths and sentinel guarantees.
function peerPointers(a: Extract<Type, { kind: 'pointer' }>, b: Extract<Type, { kind: 'pointer' }>): Type | undefined {
  const isConst = a.isConst || b.isConst;
  const leftSentinel = pointerSentinel(a),
    rightSentinel = pointerSentinel(b);
  const sentinel = sameSentinel(leftSentinel, rightSentinel) ? leftSentinel : undefined;
  if (a.size === 'slice' || b.size === 'slice') {
    const elementA = elementOf(a);
    const elementB = elementOf(b);
    if (!elementA || !elementB) return undefined;
    const child = peerMemoryType(elementA, elementB, isConst);
    return child ? sliceOf(child, isConst, sentinel) : undefined;
  }
  if (a.child.kind === 'array' && b.child.kind === 'array') {
    const left = a.child,
      right = b.child;
    const child = peerMemoryType(left.child, right.child, isConst);
    if (!child) return undefined;
    return left.length === right.length
      ? pointerTo(arrayOf(left.length, child, sentinel), isConst)
      : sliceOf(child, isConst, sentinel);
  }
  const size = a.size === b.size ? a.size : (retypedSize(a, b) ?? retypedSize(b, a));
  const child = size && peerMemoryType(a.child, b.child, isConst);
  if (!size || !child) return undefined;
  const alignment =
    a.alignment === undefined && b.alignment === undefined
      ? undefined
      : Math.min(a.alignment ?? alignOf(a.child), b.alignment ?? alignOf(b.child));
  return pointerOf(size, child, {
    isConst,
    isVolatile: a.isVolatile === true || b.isVolatile === true,
    allowZero: a.allowZero === true || b.allowZero === true,
    alignment,
    sentinel,
  });
}

/** The size two pointers of different sizes share: the one that the other converts to without changing its value. */
function retypedSize(from: PointerType, to: PointerType): PointerType['size'] | undefined {
  return POINTER_COERCIONS[`${pointerShapeOf(from, true)} ${to.size}`]?.convert === 'retype' ? to.size : undefined;
}

function peerMemoryType(a: Type, b: Type, isConst: boolean): Type | undefined {
  if (pointerChildCoercible(a, b, isConst)) return b;
  return pointerChildCoercible(b, a, isConst) ? a : undefined;
}

function pointerChildCoercible(from: Type, to: Type, isConst: boolean): boolean {
  return inMemoryCoercible(from, to) && (isConst || inMemoryCoercible(to, from) || dropsArraySentinel(from, to));
}

/** Whether `to` is the array `from` without its sentinel, which a write through a pointer cannot reach. */
function dropsArraySentinel(from: Type, to: Type): boolean {
  return (
    from.kind === 'array' &&
    to.kind === 'array' &&
    from.sentinel !== undefined &&
    to.sentinel === undefined &&
    from.length === to.length &&
    from.child === to.child
  );
}

function pointerSentinel(pointer: Extract<Type, { kind: 'pointer' }>): Sentinel | undefined {
  if (pointer.size !== 'one') return pointer.sentinel;
  return pointer.child.kind === 'array' ? pointer.child.sentinel : undefined;
}

function elementOf(pointer: Extract<Type, { kind: 'pointer' }>): Type | undefined {
  if (pointer.size === 'slice') return pointer.child;
  return pointer.child.kind === 'array' ? pointer.child.child : undefined;
}

function fnTypeCoercible(params: readonly Type[], returnType: Type, fn: Extract<Type, { kind: 'fn' }>): boolean {
  return (
    params.length === fn.params.length &&
    params.every((param, index) => functionValueCoercible(fn.params[index], param)) &&
    (returnType.kind === 'noreturn' || functionValueCoercible(returnType, fn.returnType))
  );
}

function functionValueCoercible(from: Type, to: Type): boolean {
  if (!inMemoryCoercible(from, to)) return false;
  if (from.kind === 'array' && to.kind === 'array')
    return sameSentinel(from.sentinel, to.sentinel) && functionValueCoercible(from.child, to.child);
  if (from.kind === 'optional' && to.kind === 'optional') return functionValueCoercible(from.child, to.child);
  if (from.kind === 'error_union' && to.kind === 'error_union') return functionValueCoercible(from.payload, to.payload);
  return true;
}

export function isAnonymous(type: StructType): boolean {
  return type.isTuple || type.namespace.name.startsWith('anonymous');
}

/** The smallest unsigned type that holds the value, as an enum's automatic tag type. */
export function smallestUnsigned(value: number): IntType {
  let bits = 0;
  while (value >= 2 ** bits) bits++;
  return intType(false, bits);
}

export function withSentinel(values: Value[], sentinel: Value | Sentinel): Value[] {
  return sentinel === undefined ? values : [...values, sentinel instanceof Sentinel ? sentinel.value : sentinel];
}

/** A new array of the elements, followed by the sentinel of a sentinel-terminated array type. */
export function newArray(values: Value[], sentinel: Value | Sentinel): ZArray {
  return new ZArray(withSentinel(values, sentinel), 0, values.length, sentinel !== undefined);
}

export function hasUndefinedMemory(expression: TExpr): boolean {
  return isUndefinedMemory(staticResultOf(expression)?.value);
}

export function knownLengthOf(expression: TExpr): bigint | undefined {
  const type = expression.type;
  if (type.kind === 'array') return type.length;
  if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') return type.child.length;
  return (
    expression.knownLength ??
    (expression.known && expression.value instanceof Slice ? expression.value.lengthValue : undefined)
  );
}

export function evaluateHeld(
  frame: Frame,
  evaluators: readonly (Eval & { valueType?: Type })[],
  convert: (value: Value) => Value = (value) => value
): Value[] {
  const mark = frame.temporaries.length;
  const values: Value[] = [];
  try {
    for (const evaluate of evaluators) {
      const value = convert(evaluate(frame));
      values.push(value);
      frame.temporaries.push({ value, type: evaluate.valueType });
    }
  } finally {
    frame.temporaries.length = mark;
  }
  return values;
}

export function valueEvaluators(args: readonly TExpr[], copy = true): (Eval & { valueType: Type })[] {
  return args.map((arg) =>
    Object.assign((frame: Frame) => (copy ? copyForFrame(frame, arg.eval(frame), arg.type) : arg.eval(frame)), {
      valueType: arg.type,
    })
  );
}

export function copyForFrame(frame: Frame, value: Value, type: Type): Value {
  frame.runtime.spend(sizeOf(type) === 0 ? 0 : 1);
  return copyFrameStorage(frame, value, type);
}

function copyFrameStorage(frame: Frame, value: Value, type: Type): Value {
  return copyStoredValue(
    value,
    (slots) => {
      frame.runtime.reserveStorage(slots);
      frame.runtime.spend(slots);
    },
    type,
    () => frame.runtime.spend()
  );
}

/** A value about to be stored, whose aggregates must not be shared with the value it came from. */
export function copyForStorage(value: Value): Value {
  return copyStoredValue(value);
}

export function copyIntoReservedStorage(value: Value): Value {
  return copyStoredValue(value, spendMemory);
}

// code-gauge-allow functionCognitiveComplexity -- Dispatches concrete value shapes while retaining type proofs and charging each mutable clone before allocation.
function copyStoredValue(
  value: Value,
  reserve?: (slots: number) => void,
  type?: Type,
  spend: () => void = () => {}
): Value {
  if (type?.kind === 'error_union') type = type.payload;
  if (type && (value instanceof ZArray || value instanceof ZStruct || value instanceof ZUnion)) {
    const singleton = singleValueOf(type, spend);
    if (singleton) return singleton.value;
  }
  const copy = (child: Value, type?: Type): Value => copyStoredValue(child, reserve, type, spend);
  if (value instanceof ZArray) {
    const child = type?.kind === 'array' ? type.child : undefined;
    const virtual = copyZeroArray(value);
    if (virtual) return virtual;
    const length = value.length + (value.hasSentinel ? 1 : 0);
    reserve?.(length);
    return new ZArray(
      Array.from({ length }, (_, index) => copy(value.get(index), child)),
      0,
      value.lengthValue,
      value.hasSentinel
    );
  }
  if (value instanceof ZStruct) {
    reserve?.(value.slots.length);
    return new ZStruct(
      value.slots.map((value, index) => copy(value, type?.kind === 'struct' ? type.fields?.[index]?.type : undefined))
    );
  }
  if (value instanceof ZUnion) {
    reserve?.(1);
    return (
      value.copyBacking?.() ??
      value.withCopiedPayload(copy(value.slots[0], type?.kind === 'union' ? type.fields?.[value.tag]?.type : undefined))
    );
  }
  if (value instanceof Some) {
    reserve?.(1);
    return new Some(copy(value.value, type?.kind === 'optional' ? type.child : undefined));
  }
  if (value instanceof NativeHandle && typeof value.state.fresh === 'function') {
    reserve?.(1);
    return (value.state.fresh as () => Value)();
  }
  return value;
}

// Undefined values ------------------------------------------------------------------------------------------------

const undefinedIntegers = new WeakMap<IntType, bigint>();
const undefinedFunctions = new WeakMap<FnType, FnValue>();

/** The value that `undefined` memory holds in a Debug build, which fills it with the byte 0xAA. */
export function undefinedValue(type: Type): Value {
  valueSlots(type);
  return buildUndefinedValue(type);
}

// code-gauge-allow functionNcss -- Mirrors the value shapes for every supported type.
function buildUndefinedValue(type: Type): Value {
  switch (type.kind) {
    case 'int': {
      return undefinedInteger(type);
    }
    case 'float': {
      return decodeFloat(undefinedBitPattern(type.bits), type.bits);
    }
    case 'bool': {
      return true;
    }
    case 'array': {
      const child = singleValueOf(type.child, () => {});
      if (child) return zeroArray(type.length, type.sentinel !== undefined, child.value);
      return newArray(
        Array.from({ length: Number(type.length) }, () => buildUndefinedValue(type.child)),
        type.sentinel
      );
    }
    case 'struct': {
      return new ZStruct((type.fields ?? []).map((field) => buildUndefinedValue(field.type)));
    }
    case 'optional': {
      return type.child.kind === 'pointer' ? buildUndefinedValue(type.child) : NULL;
    }
    case 'error_union': {
      return buildUndefinedValue(type.payload);
    }
    case 'enum': {
      return 0xaan & ((1n << BigInt(type.tagType?.bits ?? 8)) - 1n);
    }
    case 'union': {
      const fields = type.fields ?? [];
      return new ZUnion(0, fields[0] ? buildUndefinedValue(fields[0].type) : undefined, false);
    }
    case 'fn': {
      let value = undefinedFunctions.get(type);
      if (!value) {
        value = new FnValue(
          new FunctionInstance('undefined', type.params, type.returnType, () => {
            throw new MemoryFault();
          }),
          true
        );
        undefinedFunctions.set(type, value);
      }
      return value;
    }
    case 'pointer': {
      return type.child.kind === 'fn'
        ? buildUndefinedValue(type.child)
        : type.size === 'slice'
          ? new Slice(UNDEFINED_MEMORY, 0, undefinedInteger(USIZE), true)
          : new Pointer(UNDEFINED_MEMORY, 0);
    }
    default: {
      return undefined;
    }
  }
}

function undefinedInteger(type: IntType): bigint {
  let value = undefinedIntegers.get(type);
  if (value === undefined) {
    const pattern = undefinedBitPattern(Math.ceil(type.bits / 8) * 8);
    value = type.signed ? BigInt.asIntN(type.bits, pattern) : BigInt.asUintN(type.bits, pattern);
    undefinedIntegers.set(type, value);
  }
  return value;
}

function undefinedBitPattern(bits: number): bigint {
  return (((1n << BigInt(bits)) - 1n) / 255n) * 170n;
}

export function nullUnwrapPanic(): never {
  return panic(PANIC.nullUnwrap);
}

export { BigFloat, BOOL, COMPTIME_FLOAT, COMPTIME_INT, NULL_TYPE, UNDEFINED_TYPE, arrayOf, isComptimeOnly };

type PointerConversion = 'retype' | 'fromC' | 'sliceToMany' | 'arrayToMany' | 'arrayToSlice';

/**
 * How a pointer coerces to a pointer of another or the same size: which element type must coerce (the pointer's
 * child, or the element of the array it points to), what the target's sentinel must match ('target': the source's
 * sentinel when the target has one; 'exact': the source's sentinel, which the target must have), and how the value
 * changes.
 */
interface PointerCoercion {
  readonly element: 'child' | 'arrayChild';
  readonly sentinel: 'none' | 'target' | 'exact';
  readonly convert: PointerConversion;
}

/** The source's shape that Zig's pointer coercions tell apart: a pointer to an array, and a slice with a sentinel. */
export type PointerShape = 'one' | 'array' | 'many' | 'slice' | 'sentinelSlice' | 'c';

const SAME_SIZE: PointerCoercion = { element: 'child', sentinel: 'target', convert: 'retype' };

/** Zig's coercions between pointers, by the source's shape and the target's size; a pair not listed is refused. */
const POINTER_COERCIONS: Partial<Record<`${PointerShape} ${PointerType['size']}`, PointerCoercion>> = {
  'one one': SAME_SIZE,
  'array one': SAME_SIZE,
  'many many': SAME_SIZE,
  'slice slice': SAME_SIZE,
  'sentinelSlice slice': SAME_SIZE,
  'c c': SAME_SIZE,
  'one c': { element: 'child', sentinel: 'none', convert: 'retype' },
  'many c': { element: 'child', sentinel: 'none', convert: 'retype' },
  'c one': { element: 'child', sentinel: 'none', convert: 'fromC' },
  'c many': { element: 'child', sentinel: 'none', convert: 'fromC' },
  'array many': { element: 'arrayChild', sentinel: 'target', convert: 'arrayToMany' },
  'array c': { element: 'arrayChild', sentinel: 'none', convert: 'arrayToMany' },
  'array slice': { element: 'arrayChild', sentinel: 'target', convert: 'arrayToSlice' },
  // Zig refuses a slice without a sentinel, whose end the many-item pointer could not find.
  'sentinelSlice many': { element: 'child', sentinel: 'exact', convert: 'sliceToMany' },
  'sentinelSlice c': { element: 'child', sentinel: 'none', convert: 'sliceToMany' },
};

function pointerCoercionOf(from: PointerType, to: PointerType): PointerCoercion | undefined {
  // `*[N]T` converts by its elements, except to `[*c][N]T`, which takes it as the single-item pointer it is.
  const wholeArray = to.size === 'c' && pointerChildCoercible(from.child, to.child, to.isConst);
  return POINTER_COERCIONS[`${pointerShapeOf(from, wholeArray)} ${to.size}`];
}

/** The shape of a pointer type that Zig's pointer rules tell apart, a pointer to an array taken whole if asked. */
export function pointerShapeOf(type: PointerType, wholeArray = false): PointerShape {
  if (type.size === 'one' && type.child.kind === 'array' && !wholeArray) return 'array';
  if (type.size === 'slice' && type.sentinel !== undefined) return 'sentinelSlice';
  return type.size;
}

/**
 * What each pointer shape allows besides coercion: `.ptr` to a many-item pointer, `.?` on a C pointer, `p + n` and an
 * open-ended slice `p[n..]` on an unbounded pointer, and `std.mem.span` and `len`, which need a sentinel or C's 0.
 */
export const POINTER_OPERATIONS: Record<
  PointerShape,
  { ptr: boolean; unwrap: boolean; unbounded: boolean; span: 'never' | 'sentinel' | 'always' }
> = {
  one: { ptr: false, unwrap: false, unbounded: false, span: 'never' },
  array: { ptr: true, unwrap: false, unbounded: false, span: 'never' },
  many: { ptr: false, unwrap: false, unbounded: true, span: 'sentinel' },
  slice: { ptr: true, unwrap: false, unbounded: false, span: 'never' },
  sentinelSlice: { ptr: true, unwrap: false, unbounded: false, span: 'never' },
  c: { ptr: false, unwrap: true, unbounded: true, span: 'always' },
};
