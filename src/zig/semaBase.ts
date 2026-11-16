// code-gauge-allow-file fileNcss 924 -- The file holds one layer of the compiler, whose parts share its private state.
// code-gauge-allow-file duplicateLines 18 -- Undefined and zero initializers share aggregate shapes but differ in scalar and optional values.
import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { CompilationStorage, valueSlots } from './allocation';
import { PANIC, panic } from './arith';
import { isDiscardName } from './ast';
import type { Container, ContainerMember, Expression, FunctionDeclaration, SourceFile, Span } from './ast';
import { markRuntimeStorage } from './comptimeMemory';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  bigFloatOf,
  floatFromBigInt,
  floatOf,
  FORMATS,
  isInfinite,
  isIntegral,
  roundTo,
  truncateToBigInt,
} from './floats';
import type { FunctionInstance } from './functions';
import { type Frame, ZigPanic } from './runtime';
import {
  arrayOf,
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
  type IntType,
  intType,
  isComptimeOnly,
  type Namespace,
  NULL_TYPE,
  optionalOf,
  pointerTo,
  sliceOf,
  type StructField,
  type StructType,
  type Type,
  typeName,
  UNDEFINED_TYPE,
  type UnionType,
  VOID,
} from './types';
import {
  type EnumLiteral,
  ErrorValue,
  type FnValue,
  markConstantStorage,
  NativeHandle,
  NULL,
  Pointer,
  Slice,
  type Slots,
  Some,
  type Value,
  ZArray,
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
}

/** An analyzed expression: its type, its value when the compiler knows it, and the code that computes it. */
export interface TExpr {
  readonly type: Type;
  /** Whether this expression can be replaced with `value`. */
  readonly known: boolean;
  readonly staticResult?: { value: Value };
  readonly knownLength?: number;
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
  readonly knownLength?: number;
  /** The value of a constant that the compiler knows. */
  readonly known: boolean;
  readonly value?: Value;
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
}

/**
 * A function of the standard library or the grader, which analyzes its own calls: it compiles its arguments with the
 * types it expects and returns the analyzed call.
 */
export class NativeFn {
  constructor(
    readonly name: string,
    readonly compileCall: (sema: SemaApi, call: NativeCall) => TExpr
  ) {}
}

export interface NativeCall {
  readonly span: Span;
  readonly args: readonly Expression[];
  /** The receiver of a method call such as `list.append(...)`. */
  readonly receiver?: TExpr;
  readonly resultType?: Type;
}

/** The compiler's services that native functions use. */
export interface SemaApi {
  compile(expression: Expression, resultType?: Type): TExpr;
  compileType(expression: Expression): Type;
  reserveStorage(type: Type, span: Span): void;
  resolveStorage(type: Type, span: Span): void;
  spendCompilation(cost?: number): void;
  libraryFunction(file: SourceFile, element: Type, name: string, params: readonly Type[], span: Span): FunctionInstance;
  coerce(expression: TExpr, type: Type, span?: Span): TExpr;
  error(span: Span, message: string): never;
  knownValue(expression: TExpr, what: string): Value;
  peerType(expressions: readonly TExpr[], span: Span): Type;
  callFunction(fn: FunctionInstance, args: Value[], frame: Frame): Value;
  instantiate(ref: FnRef, argTypes: readonly Type[], span: Span): FunctionInstance;
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

export abstract class SemaBase implements SemaApi {
  protected readonly storage = new CompilationStorage();
  protected scope: Scope;
  /** The namespaces of user containers, by syntax, so that a container expression evaluates to one type. */
  protected readonly containerTypes = new Map<Container, Type>();
  /** The container-level variables the program uses, as the trace shows them. */
  protected readonly globalVariables: { name: string; type: Type; cell: Slots }[] = [];
  private anonymousCount = 0;
  /** How many structs' fields are being resolved, during which function bodies wait to compile. */
  protected resolvingFields = 0;

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
    span: Span
  ): FunctionInstance;

  spendCompilation(cost = 1): void {
    this.compilationBudget.spend(cost);
  }

  resolveStorage(type: Type, span: Span): void {
    this.resolveLayout(type, span, new Set());
  }

  reserveStorage(type: Type, span: Span): void {
    this.resolveStorage(type, span);
    this.storage.reserve(type);
  }

  error(span: Span, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  abstract compile(expression: Expression, resultType?: Type): TExpr;
  abstract callFunction(fn: FunctionInstance, args: Value[], frame: Frame): Value;
  abstract instantiate(ref: FnRef, argTypes: readonly Type[], span: Span): FunctionInstance;
  abstract functionOf(
    value: TExpr,
    span: Span
  ): { call: (frame: Frame, args: Value[]) => Value; params: readonly Type[]; returnType: Type };
  abstract addressOf(expression: TExpr): TExpr;
  abstract findDecl(type: Type, name: string): Decl | undefined;
  abstract tupleType(fields: StructField[]): StructType;
  /** Evaluates a function call at compile time, as a container-level constant's initializer does. */
  protected abstract evaluateAtCompileTime(expression: TExpr): Value;
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

  /** The innermost container whose scope the compiler is in, which `@This()` names. */
  protected enclosingNamespace(): Namespace {
    for (let scope: Scope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.namespace) return scope.namespace;
    }
    return this.root;
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
    const existing = this.containerTypes.get(container);
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
    if (container.containerKind === 'struct') {
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
    this.containerTypes.set(container, type);
    addDecls(namespace, container.members);
    return type;
  }

  /** Resolves a declaration: a constant's type and value, a variable's type and storage, or a function. */
  resolveDecl(decl: Decl, span: Span): TExpr {
    switch (decl.kind) {
      case 'fn': {
        return known(NATIVE_FN_TYPE, new FnRef(decl) as unknown as Value, span);
      }
      case 'native': {
        const { type, value, unavailable } = decl.resolve();
        if (unavailable) this.error(span, `${unavailable}は、この採点環境では使えません。`);
        return known(type, value, span);
      }
      default: {
        this.resolveVariable(decl);
        if (decl.kind === 'const') {
          const pointer = new Pointer(decl.cell as Slots, 0);
          return {
            ...known(decl.type as Type, decl.value, span),
            place: { isConst: true, locate: () => pointer, compileTimePointer: pointer },
          };
        }
        const cell = decl.cell as Slots;
        const type = decl.type as Type;
        return runtime(type, () => cell.slots[0], span, {
          isConst: false,
          locate: () => new Pointer(cell, 0),
          compileTimePointer: new Pointer(cell, 0),
        });
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Checks each rule of Zig's type coercion or container analysis in turn.
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
        let compiled = this.compileDeclValue(value, declared, syntax.name);
        if (declared) compiled = this.coerce(compiled, declared, value);
        if (!compiled.known) {
          compiled = known(compiled.type, this.evaluateAtCompileTime(compiled), value);
        }
        if (decl.kind === 'var' && isComptimeOnly(compiled.type)) {
          this.error(
            syntax,
            `変数「${syntax.name}」の型 ${typeName(compiled.type)} は、コンパイルのときだけの型です。`
          );
        }
        decl.type = compiled.type;
        if (decl.kind === 'const') {
          decl.value = compiled.value;
          decl.cell = { slots: [copyForStorage(compiled.value)] };
          markConstantStorage(decl.cell);
        } else {
          decl.cell = { slots: [copyForStorage(compiled.value)] };
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
  private compileDeclValue(value: Expression, declared: Type | undefined, name: string): TExpr {
    if (value.kind === 'container') {
      const qualified = `${this.enclosingNamespace().name}.${name}`;
      return known(TYPE_TYPE, this.containerType(value, qualified), value);
    }
    return this.compile(value, declared);
  }

  // Container fields ------------------------------------------------------------------------------------------------

  /** The fields of a struct, resolving their types and default values on first use. */
  // code-gauge-allow functionCognitiveComplexity 17 -- Keeps the field layout and default-value checks in one pass.
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
        });
      }
    });
    this.resolvingFields--;
    type.fields = fields;
    for (const [index, field] of fields.entries()) {
      if (this.holdsByValue(field.type, type, new Set())) {
        this.error(
          syntax.fields[index],
          `構造体 ${typeName(type)} が、フィールドに自分自身を値として持っています（ポインタにしてください）。`
        );
      }
    }
    void span;
    return fields;
  }

  /** Resolves the fields of the structs and unions a value of `type` holds in place, which its undefined value needs. */
  private resolveLayout(type: Type, span: Span, seen: Set<Type>): void {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.kind === 'array' || type.kind === 'optional') this.resolveLayout(type.child, span, seen);
    else if (type.kind === 'error_union') this.resolveLayout(type.payload, span, seen);
    else if (type.kind === 'enum') this.enumFields(type);
    else if (type.kind === 'struct') {
      for (const field of this.structFields(type, span)) this.resolveLayout(field.type, span, seen);
    } else if (type.kind === 'union') {
      for (const field of this.unionFields(type)) this.resolveLayout(field.type, span, seen);
    }
  }

  /** Whether a value of `type` contains a `target` in place, not behind a pointer, which would have no size. */
  private holdsByValue(type: Type, target: Type, seen: Set<Type>): boolean {
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

  // code-gauge-allow functionCognitiveComplexity 20 -- Checks each rule of Zig's type coercion or container analysis in turn.
  // code-gauge-allow functionNcss 33 -- Resolves enum tags, indexed uniqueness, and integer range checks in declaration order.
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
    this.inContainerScope(type.namespace, () => {
      const fields = syntax.fields.map((field) => {
        this.spendCompilation();
        if (field.name === undefined) this.error(field, 'union のフィールドには名前を書いてください。');
        return { name: field.name, type: field.type ? this.compileType(field.type) : VOID };
      });
      type.fields = fields;
      if (syntax.taggedByEnum) {
        const tagType = syntax.argument ? this.compileType(syntax.argument) : undefined;
        if (tagType && tagType.kind !== 'int') this.error(syntax, 'union(enum(T)) の T は整数の型にしてください。');
        const tagNamespace: Namespace = {
          name: `@typeInfo(${type.namespace.name}).@"union".tag_type.?`,
          decls: new Map(),
        };
        type.tagType = {
          kind: 'enum',
          namespace: tagNamespace,
          tagType: (tagType as IntType | undefined) ?? smallestUnsigned(Math.max(fields.length - 1, 0)),
          fields: fields.map((field, index) => ({ name: field.name, value: BigInt(index) })),
          exhaustive: true,
          unionOf: type,
        };
      } else if (syntax.argument) {
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
        // A function body type such as `fn (i32) i32` takes a function declared with that signature.
        if (from !== NATIVE_FN_TYPE || !(expression.value instanceof FnRef)) return undefined;
        const fn = this.functionOf(expression, span);
        if (!sameFnType(fn.params, fn.returnType, to)) return undefined;
        return known(to, this.knownFunctionValue(expression, span), span);
      }
      case 'pointer': {
        return this.coerceToPointer(expression, to, span);
      }
      case 'enum': {
        if (from.kind === 'enum_literal' && expression.known) {
          const { name } = expression.value as EnumLiteral;
          const field = this.enumFields(to).find((each) => each.name === name);
          if (!field) this.error(span, `enum ${typeName(to)} には、フィールド「${name}」がありません。`);
          return known(to, field.value, span);
        }
        if (from.kind === 'union' && from.tagType === to) {
          const fields = this.unionFields(from);
          const tags = this.enumFields(to);
          return this.derived(
            expression,
            to,
            (value) => tags.find((tag) => tag.name === fields[(value as ZUnion).tag].name)?.value
          );
        }
        return undefined;
      }
      case 'union': {
        if (from.kind === 'enum_literal' && expression.known) {
          const { name } = expression.value as EnumLiteral;
          const fields = this.unionFields(to);
          const index = fields.findIndex((field) => field.name === name);
          if (index === -1) this.error(span, `union ${typeName(to)} には、フィールド「${name}」がありません。`);
          if (fields[index].type.kind !== 'void') {
            this.error(span, `union のフィールド「${name}」には値が要るので、.${name} だけでは作れません。`);
          }
          return known(to, new ZUnion(index, undefined), span);
        }
        if (from.kind === 'enum' && to.tagType === from && expression.known) {
          const fields = this.unionFields(to);
          const tag = this.enumFields(from).find((field) => field.value === expression.value);
          const index = fields.findIndex((field) => field.name === tag?.name);
          if (index === -1 || fields[index].type.kind !== 'void') return undefined;
          return known(to, new ZUnion(index, undefined), span);
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

  // code-gauge-allow functionCognitiveComplexity 16 -- Checks each rule of Zig's type coercion or container analysis in turn.
  private coerceToInt(expression: TExpr, to: IntType, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'comptime_int' || (from.kind === 'int' && expression.known)) {
      if (!expression.known) return undefined;
      const value = expression.value as bigint;
      if (!fitsInt(value, to)) this.error(span, `${typeName(to)} 型では、整数 ${value} を表せません。`);
      return known(to, value, span);
    }
    if (from.kind === 'int') return intWidens(from, to) ? { ...expression, type: to } : undefined;
    if (from.kind === 'comptime_float' && expression.known) {
      const value = expression.value as BigFloat;
      if (!isIntegral(value)) this.error(span, fractional(value, to));
      const integer = truncateToBigInt(value);
      if (!fitsInt(integer, to)) this.error(span, `${typeName(to)} 型では、整数 ${integer} を表せません。`);
      return known(to, integer, span);
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Checks each rule of Zig's type coercion or container analysis in turn.
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
    if (from.kind === 'float' && from.bits <= to.bits) {
      if (expression.known) return known(to, floatOf(asBigFloat(expression.value as AnyFloat), to.bits), span);
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
    if (to.child.kind !== 'optional') return { ...payload, type: to, place: undefined };
    return this.derived(payload, to, (value) => new Some(value));
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
    return payload ? { ...payload, type: to, place: undefined } : undefined;
  }

  // code-gauge-allow functionNcss 31 -- Checks each rule of Zig's type coercion or container analysis in turn.
  // code-gauge-allow functionCognitiveComplexity 27 -- Checks each rule of Zig's type coercion or container analysis in turn.
  private coerceToPointer(expression: TExpr, to: Extract<Type, { kind: 'pointer' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'fn' || (from === NATIVE_FN_TYPE && expression.value instanceof FnRef)) {
      if (to.size !== 'one' || to.child.kind !== 'fn') return undefined;
      const fn = this.functionOf(expression, span);
      if (!sameFnType(fn.params, fn.returnType, to.child)) return undefined;
      return known(to, this.knownFunctionValue(expression, span), span);
    }
    if (from.kind !== 'pointer') return undefined;
    // A pointer to an empty array has nothing to write, so it coerces to a slice of variables.
    const empty = from.size === 'one' && from.child.kind === 'array' && from.child.length === 0;
    if (from.isConst && !to.isConst && !empty) return undefined;
    if (from.size === to.size) {
      if (!inMemoryCoercible(from.child, to.child)) return undefined;
      if (to.sentinel !== undefined && from.sentinel !== to.sentinel) return undefined;
      return { ...expression, type: to };
    }
    // `*[N]T` to `[]T`
    if (from.size === 'one' && to.size === 'slice' && from.child.kind === 'array') {
      const array = from.child;
      if (!inMemoryCoercible(array.child, to.child)) return undefined;
      if (to.sentinel !== undefined && array.sentinel !== to.sentinel) return undefined;
      const { length } = array;
      return {
        ...this.derived(expression, to, (value) => {
          const array = (value as Pointer).load() as ZArray;
          return new Slice(array, array.offset, length);
        }),
        knownLength: expression.known ? length : expression.knownLength,
      };
    }
    return undefined;
  }

  /** A function value that the compiler knows, as a runtime function pointer. */
  protected abstract knownFunctionValue(expression: TExpr, span: Span): FnValue;

  private coerceAggregateSource(expression: TExpr, convert: (source: TExpr) => TExpr | undefined): TExpr | undefined {
    if (expression.known) return convert(expression);
    const held = new WeakMap<Frame, Value>();
    const result = convert({ ...expression, eval: (frame) => held.get(frame) });
    if (!result) return undefined;
    return runtime(
      result.type,
      (frame) => {
        const source = expression.eval(frame);
        const previous = held.get(frame);
        const mark = frame.temporaries.length;
        held.set(frame, source);
        frame.temporaries.push(source);
        try {
          return result.eval(frame);
        } finally {
          frame.temporaries.length = mark;
          if (previous === undefined) held.delete(frame);
          else held.set(frame, previous);
        }
      },
      expression.span
    );
  }

  private coerceToArray(expression: TExpr, to: Extract<Type, { kind: 'array' }>, span: Span): TExpr | undefined {
    const from = expression.type;
    if (from.kind === 'array') {
      if (from.length !== to.length || !inMemoryCoercible(from.child, to.child)) return undefined;
      if (to.sentinel !== undefined && from.sentinel !== to.sentinel) return undefined;
      return { ...expression, type: to };
    }
    if (from.kind === 'struct' && from.isTuple) {
      const fields = from.fields ?? [];
      if (fields.length !== to.length) {
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
    if (from.kind !== 'struct' || !isAnonymous(from)) return undefined;
    const sourceFields = from.fields ?? [];
    const targetFields = this.structFields(to, span);
    if (sourceFields.length === 0 && targetFields.length === 0 && to.native)
      return this.nativeDefault(to, span, expression);
    if (to.isTuple) {
      if (sourceFields.length !== targetFields.length) return undefined;
      const elements = targetFields.map((field, index) =>
        this.coerce(this.tupleElement(expression, index, sourceFields[index], span), field.type, span)
      );
      return this.aggregate(to, elements, span, (values) => new ZStruct(values));
    }
    for (const field of sourceFields) {
      if (!targetFields.some((target) => target.name === field.name)) {
        this.error(span, `構造体 ${typeName(to)} には、フィールド「${field.name}」がありません。`);
      }
    }
    const elements = targetFields.map((field) => {
      const index = sourceFields.findIndex((source) => source.name === field.name);
      if (index === -1) {
        if (!field.hasDefault) this.error(span, `フィールド「${field.name}」の値がありません。`);
        return known(field.type, field.defaultValue, span);
      }
      return this.coerce(this.tupleElement(expression, index, sourceFields[index], span), field.type, span);
    });
    return this.aggregate(to, elements, span, (values) => new ZStruct(values));
  }

  protected nativeDefault(type: StructType, span: Span, operand?: TExpr): TExpr {
    const initialize = type.native?.defaultValue;
    if (!initialize) return this.error(span, `${typeName(type)} 型には初期化に必要なフィールドがあります。`);
    this.storage.reserve(type);
    return operand ? this.fixedResult(operand, type, initialize(), span) : known(type, initialize(), span);
  }

  /** The `index`th field of a tuple or anonymous struct value. */
  protected tupleElement(expression: TExpr, index: number, field: StructField, span: Span): TExpr {
    if (field.comptimeValue !== undefined) return known(field.type, field.comptimeValue, span);
    if (expression.known) return known(field.type, (expression.value as ZStruct).slots[index], span);
    const evaluate = expression.eval;
    return runtime(field.type, (frame) => (evaluate(frame) as ZStruct).slots[index], span);
  }

  /** An aggregate built from elements, known when they all are. */
  protected aggregate(type: Type, elements: readonly TExpr[], span: Span, build: (values: Value[]) => Value): TExpr {
    this.storage.reserve(type);
    if (elements.every((element) => element.known)) {
      return known(type, build(elements.map((element) => copyForStorage(element.value))), span);
    }
    const evaluators = elements.map((element) => element.eval);
    return runtime(
      type,
      (frame) => {
        frame.runtime.reserveStorage(valueSlots(type));
        return build(evaluateHeld(frame, evaluators, copyForStorage));
      },
      span
    );
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
  protected derived(expression: TExpr, type: Type, convert: (value: Value) => Value, allocates = false): TExpr {
    const sourceResult = staticResultOf(expression);
    let result: { value: Value } | undefined;
    if (sourceResult) {
      try {
        result = { value: convert(sourceResult.value) };
      } catch (error) {
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
          if (allocates) frame.runtime.reserveStorage(valueSlots(type));
          return convert(value);
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
    if (a.kind === 'noreturn') return b;
    if (b.kind === 'noreturn') return a;
    return undefined;
  }
}

const TYPE_TYPE: Type = { kind: 'type' };

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
// code-gauge-allow functionCognitiveComplexity 24 -- Checks each rule of Zig's type coercion or container analysis in turn.
export function inMemoryCoercible(from: Type, to: Type): boolean {
  if (from === to) return true;
  if (from.kind === 'pointer' && to.kind === 'pointer') {
    if (from.size !== to.size || (from.isConst && !to.isConst)) return false;
    if (to.sentinel !== undefined && from.sentinel !== to.sentinel) return false;
    return inMemoryCoercible(from.child, to.child);
  }
  if (from.kind === 'optional' && to.kind === 'optional') return inMemoryCoercible(from.child, to.child);
  if (from.kind === 'error_set' && to.kind === 'error_set') return errorSetIncludes(to, from);
  if (from.kind === 'error_union' && to.kind === 'error_union') {
    return errorSetIncludes(to.errorSet, from.errorSet) && inMemoryCoercible(from.payload, to.payload);
  }
  if (from.kind === 'array' && to.kind === 'array') {
    return (
      from.length === to.length &&
      inMemoryCoercible(from.child, to.child) &&
      (to.sentinel === undefined || from.sentinel === to.sentinel)
    );
  }
  if (from.kind === 'int' && to.kind === 'int') return from.bits === to.bits && from.signed === to.signed;
  return false;
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

function peerPointers(a: Extract<Type, { kind: 'pointer' }>, b: Extract<Type, { kind: 'pointer' }>): Type | undefined {
  const isConst = a.isConst || b.isConst;
  if (a.size === 'slice' || b.size === 'slice') {
    const elementA = elementOf(a);
    const elementB = elementOf(b);
    if (!elementA || elementA !== elementB) return undefined;
    return sliceOf(elementA, isConst);
  }
  if (a.child.kind === 'array' && b.child.kind === 'array' && a.child.child === b.child.child) {
    return a.child.length === b.child.length ? pointerTo(a.child, isConst) : sliceOf(a.child.child, isConst);
  }
  if (a.child === b.child) return pointerTo(a.child, isConst);
  return undefined;
}

function elementOf(pointer: Extract<Type, { kind: 'pointer' }>): Type | undefined {
  if (pointer.size === 'slice') return pointer.child;
  return pointer.child.kind === 'array' ? pointer.child.child : undefined;
}

function sameFnType(params: readonly Type[], returnType: Type, fn: Extract<Type, { kind: 'fn' }>): boolean {
  return (
    params.length === fn.params.length &&
    params.every((param, index) => param === fn.params[index]) &&
    returnType === fn.returnType
  );
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

export function withSentinel(values: Value[], sentinel: Value | undefined): Value[] {
  return sentinel === undefined ? values : [...values, sentinel];
}

/** A new array of the elements, followed by the sentinel of a sentinel-terminated array type. */
export function newArray(values: Value[], sentinel: Value | undefined): ZArray {
  return new ZArray(withSentinel(values, sentinel), 0, values.length, sentinel !== undefined);
}

export function staticResultOf(expression: TExpr): { value: Value } | undefined {
  return expression.known ? { value: expression.value } : expression.staticResult;
}

export function knownLengthOf(expression: TExpr): number | undefined {
  const type = expression.type;
  if (type.kind === 'array') return type.length;
  if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') return type.child.length;
  const length =
    expression.knownLength ??
    (expression.known && expression.value instanceof Slice ? expression.value.length : undefined);
  return length !== undefined && Number.isSafeInteger(length) ? length : undefined;
}

export function evaluateHeld(
  frame: Frame,
  evaluators: readonly Eval[],
  convert: (value: Value) => Value = (value) => value
): Value[] {
  const mark = frame.temporaries.length;
  const values: Value[] = [];
  try {
    for (const evaluate of evaluators) {
      const value = convert(evaluate(frame));
      values.push(value);
      frame.temporaries.push(value);
    }
  } finally {
    frame.temporaries.length = mark;
  }
  return values;
}

export function valueEvaluators(args: readonly TExpr[]): TExpr['eval'][] {
  return args.map((arg) => (frame) => copyForFrame(frame, arg.eval(frame), arg.type));
}

export function copyForFrame(frame: Frame, value: Value, type: Type): Value {
  if (!(type.kind === 'struct' && type.namespace.internal)) frame.runtime.reserveStorage(valueSlots(type));
  return copyForStorage(value);
}

/** A value about to be stored, whose aggregates must not be shared with the value it came from. */
export function copyForStorage(value: Value): Value {
  if (value instanceof ZArray)
    return new ZArray(
      value.values(value.hasSentinel).map((slot) => copyForStorage(slot)),
      0,
      value.length,
      value.hasSentinel
    );
  if (value instanceof ZStruct) return new ZStruct(value.slots.map((slot) => copyForStorage(slot)));
  if (value instanceof ZUnion) return new ZUnion(value.tag, copyForStorage(value.slots[0]));
  if (value instanceof Some) return new Some(copyForStorage(value.value));
  if (value instanceof NativeHandle && typeof value.state.fresh === 'function')
    return (value.state.fresh as () => Value)();
  return value;
}

// Undefined values ------------------------------------------------------------------------------------------------

const undefinedIntegers = new WeakMap<IntType, bigint>();

/** The value that `undefined` memory holds in a Debug build, which fills it with the byte 0xAA. */
export function undefinedValue(type: Type): Value {
  valueSlots(type);
  return buildUndefinedValue(type);
}

function buildUndefinedValue(type: Type): Value {
  switch (type.kind) {
    case 'int': {
      return undefinedInteger(type);
    }
    case 'float': {
      return floatFromPattern(type.bits);
    }
    case 'bool': {
      return true;
    }
    case 'array': {
      return newArray(
        Array.from({ length: type.length }, () => buildUndefinedValue(type.child)),
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
      return new ZUnion(0, fields[0] ? buildUndefinedValue(fields[0].type) : undefined);
    }
    case 'pointer': {
      return type.size === 'slice' ? new Slice(UNDEFINED_STORAGE, 0, 0) : new Pointer(UNDEFINED_STORAGE, 0);
    }
    default: {
      return undefined;
    }
  }
}

/** What an undefined pointer points to. */
const UNDEFINED_STORAGE: Slots = { slots: [] };

function undefinedInteger(type: IntType): bigint {
  let value = undefinedIntegers.get(type);
  if (value === undefined) {
    const bits = BigInt(Math.ceil(type.bits / 8) * 8);
    const pattern = (((1n << bits) - 1n) / 255n) * 170n;
    value = type.signed ? BigInt.asIntN(type.bits, pattern) : BigInt.asUintN(type.bits, pattern);
    undefinedIntegers.set(type, value);
  }
  return value;
}

function floatFromPattern(bits: 16 | 32 | 64 | 80 | 128): Value {
  if (bits === 16) return bitsToFloat16(0xaa_aa);
  if (bits === 32) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, 0xaa_aa_aa_aa);
    return view.getFloat32(0);
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, 0xaa_aa_aa_aa_aa_aa_aa_aan);
  const value = view.getFloat64(0);
  return bits === 64 ? value : roundTo(bigFloatOf(value), bits);
}

function bitsToFloat16(bits: number): number {
  const sign = bits >> 15 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3_ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

export function nullUnwrapPanic(): never {
  return panic(PANIC.nullUnwrap);
}

export { BigFloat, BOOL, COMPTIME_FLOAT, COMPTIME_INT, NULL_TYPE, UNDEFINED_TYPE, arrayOf, isComptimeOnly };
