import { CompileError } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { convertScalar, type Scalar, type Value } from './arith';
import type {
  Declaration,
  Declarator,
  Expression,
  FieldDeclaration,
  Specifiers,
  StaticAssert,
  TypeName,
  TypeSpecifier,
} from './ast';
import { CRuntimeError } from './errors';
import { decodeStringLiteral } from './literals';
import type { Address, MetadataReader, PointerBytes, PointerRange } from './pointerBounds';
import type { Frame, FunctionInfo, GlobalInfo, LocalInfo } from './runtime';
import {
  alignOf,
  builtinType,
  type CType,
  type EnumInfo,
  INT,
  isComplete,
  isVariablyModified,
  layoutRecord,
  LONG,
  RecordInfo,
  type RecordMember,
  sizeOf,
  typeName,
  UINT,
  withQualifiers,
} from './types';
import { unsupported } from './unsupported';

export type Entity =
  | { kind: 'typedef'; type: CType }
  /** A variable; `constant` is the value of a const integer one with a constant initializer, which clang folds. */
  | { kind: 'local'; local: LocalInfo; type: CType; constant?: Scalar; constantBytes?: Uint8Array }
  | { kind: 'global'; global: GlobalInfo; type: CType; constant?: Scalar; constantBytes?: Uint8Array }
  | { kind: 'function'; fn: FunctionInfo; type: CType }
  | { kind: 'enumConstant'; value: number; type: CType };

type Tag = { kind: 'record'; info: RecordInfo } | { kind: 'enum'; info: EnumInfo; type: CType };

function isConstQualifiedInteger(type: CType): boolean {
  return type.kind === 'int' && type.isConst === true && type.isVolatile !== true;
}

export const TURTLE_TAG = '__turtle';

export class Scope {
  readonly ordinary = new Map<string, Entity>();
  readonly tags = new Map<string, Tag>();

  constructor(readonly parent?: Scope) {}

  lookup(name: string): Entity | undefined {
    return this.ordinary.get(name) ?? this.parent?.lookup(name);
  }

  lookupTag(name: string): Tag | undefined {
    return this.tags.get(name) ?? this.parent?.lookupTag(name);
  }
}

/** A value the program computes, as the compiler knows it: its type and how to read (and maybe write) it. */
export interface Operand {
  /** The type, before arrays and functions decay to pointers. */
  type: CType;
  /** Computes the value, after an lvalue's conversion and the decay of arrays and functions. */
  value: (frame: Frame) => Value;
  read?: MetadataReader;
  lvalue?: LValue;
  bitWidth?: number;
  constantBytes?: Uint8Array;
  pointer?: (frame: Frame) => Address;
  arrayObject?: boolean;
  /** The value of an arithmetic constant expression. */
  constant?: Scalar;
  /** Whether the value is an address known before the program runs, as static initializers require. */
  isAddressConstant?: boolean;
  /** Whether the expression is a call, whose statement records no step of its own when the call recorded some. */
  isCall?: boolean;
  /** Evaluates the expression for its effects only, as an expression statement does. */
  effect?: (frame: Frame) => void;
}

export interface Location {
  load: () => Value;
  store: (value: Value, range?: PointerRange, bytes?: PointerBytes) => void;
  range?: () => PointerRange | undefined;
  bytes?: () => PointerBytes | undefined;
}

export interface LValue {
  location?: (frame: Frame) => Address;
  resolve: (frame: Frame) => Location;
  /** The address of an object in memory; undefined for a variable that lives outside memory. */
  address?: (frame: Frame) => number;
  isBitField?: boolean;
  /** The variable, when the lvalue names one, for the checks that concern variables. */
  local?: LocalInfo;
  isRegister?: boolean;
  /** Whether the object has static storage, so that its address is known before the program runs. */
  isStatic?: boolean;
}

export interface LabelInfo {
  id: number;
  row: number;
  defined: boolean;
  declarations?: Set<Entity>;
  jumps: { row: number; declarations: Set<Entity> }[];
}

/** The state of the function being compiled. */
export interface FunctionContext {
  /** The number of the function's variable-length arrays, each of which has a slot for its length. */
  vlaCount: number;
  info: FunctionInfo;
  returnType: CType;
  labels: Map<string, LabelInfo>;
  nextLabel: number;
  loopDepth: number;
  /** The switch statements around the statement being compiled, innermost last. */
  switches: SwitchContext[];
  /** Names whose address the function takes, whose variables must live in memory. */
  addressTaken: Set<string>;
  registerLocals: Set<LocalInfo>;
}

export interface SwitchContext {
  declarations: Set<Entity>;
  type: CType;
  cases: Map<string, number>;
  ranges: { low: Scalar; high: Scalar; label: number; row: number }[];
  defaultLabel?: number;
  defaultRow?: number;
}

export interface CompileOptions {
  trace?: TraceOptions;
}

export abstract class CompilerBase {
  protected scope = new Scope();
  protected isUnevaluated = false;
  private inParameter = false;
  protected fn?: FunctionContext;
  /** The lengths of variable-length arrays in the declarator being compiled, which its declaration computes. */
  protected pendingVla: ((frame: Frame) => void)[] = [];
  /** How deep in a prototype's parameter list the compiler is, where a variable length is only `[*]`. */
  private prototypeDepth = 0;

  /** The function being compiled, for the checks of calls that depend on it, such as `va_start`. */
  get currentFunction(): FunctionInfo | undefined {
    return this.fn?.info;
  }
  protected readonly globals: GlobalInfo[] = [];
  protected readonly functions: FunctionInfo[] = [];
  /** The distinct string literals, whose blocks the run creates when it starts. */
  protected readonly strings: Uint8Array[] = [];
  private readonly stringIndexes = new Map<string, number>();

  constructor(protected readonly options: CompileOptions) {}

  error(row: number, message: string): never {
    throw new CompileError([{ row, message }]);
  }

  protected get isTracing(): boolean {
    return this.options.trace !== undefined;
  }

  protected unevaluated<T>(compile: () => T): T {
    const previous = this.isUnevaluated;
    this.isUnevaluated = true;
    try {
      return compile();
    } finally {
      this.isUnevaluated = previous;
    }
  }

  protected withoutVlaEvaluation<T>(compile: () => T): T {
    const previous = this.pendingVla;
    this.pendingVla = [];
    try {
      return this.unevaluated(compile);
    } finally {
      this.pendingVla = previous;
    }
  }

  protected validateInline(specifiers: Specifiers, type: CType, name?: string): void {
    if (specifiers.isInline && (type.kind !== 'function' || specifiers.storage === 'typedef' || name === 'main'))
      this.error(specifiers.row, 'inline は main 以外の関数にだけ指定できます。');
  }

  protected withScope<T>(compile: () => T): T {
    const outer = this.scope;
    this.scope = new Scope(outer);
    try {
      return compile();
    } finally {
      this.scope = outer;
    }
  }

  protected stringIndex(bytes: Uint8Array): number {
    const key = String.fromCodePoint(...bytes);
    let index = this.stringIndexes.get(key);
    if (index === undefined) {
      index = this.strings.length;
      this.strings.push(bytes);
      this.stringIndexes.set(key, index);
    }
    return index;
  }

  // Types -------------------------------------------------------------------------------------------------------------

  /** The type that specifiers name, declaring the structs, unions, and enums they define. */
  protected baseType(specifiers: Specifiers): CType {
    const type = this.typeSpecifier(specifiers.type);
    return withQualifiers(type, specifiers.qualifiers.isConst, specifiers.qualifiers.isVolatile);
  }

  private typeSpecifier(specifier: TypeSpecifier): CType {
    const { row } = specifier;
    switch (specifier.kind) {
      case 'builtin': {
        if (specifier.words.length === 0) this.error(row, '型を書いてください（C では型を省けません）。');
        if (specifier.words.includes('_Complex')) unsupported(row, '_Complex');
        const type = builtinType(specifier.words);
        if (!type) this.error(row, `「${specifier.words.join(' ')}」という型はありません。`);
        return type;
      }
      case 'typedefName': {
        const entity = this.scope.lookup(specifier.name);
        if (entity?.kind !== 'typedef') this.error(row, `「${specifier.name}」という型はありません。`);
        return entity.type;
      }
      case 'struct':
      case 'union': {
        return { kind: 'record', info: this.recordInfo(specifier) };
      }
      case 'enum': {
        return this.enumType(specifier);
      }
      case 'typeof': {
        // __typeof__ names the type of its operand without evaluating it.
        return specifier.typeName
          ? this.typeOfName(specifier.typeName)
          : this.typeOfExpression(specifier.operand as Expression);
      }
    }
  }

  protected abstract typeOfExpression(expression: Expression): CType;

  /** `_Static_assert`, which stops compiling when its constant condition is 0. */
  protected staticAssert(item: StaticAssert): void {
    const condition = this.constantOperand(item.condition);
    if (condition?.constant === undefined || condition.type.kind !== 'int') {
      this.error(item.row, '_Static_assert の条件には、整数の定数を書いてください。');
    }
    if (condition.constant === 0 || condition.constant === 0n) {
      const message = item.message
        ? `（${new TextDecoder().decode(decodeStringLiteral(item.message, item.row).slice(0, -1))}）`
        : '';
      this.error(item.row, `_Static_assert の条件が成り立ちません${message}。`);
    }
  }

  /** The alignment that `_Alignas` asks for, which must be a power of two. */
  protected requestedAlignment(requests: NonNullable<Specifiers['alignas']>): number {
    return Math.max(...requests.map((request) => this.alignmentRequest(request)));
  }

  private alignmentRequest(alignas: NonNullable<Specifiers['alignas']>[number]): number {
    const typeName = alignas.typeName;
    if (typeName) return alignOf(this.withoutVlaEvaluation(() => this.typeOfName(typeName)));
    const value = this.integerConstant(alignas.expression as Expression, '_Alignas の大きさ');
    if (value !== 0 && (value < 0 || (value & (value - 1)) !== 0))
      this.error(alignas.row, '_Alignas の大きさは、2 のべき乗にしてください。');
    return value;
  }

  protected declareStandaloneTag(declaration: Declaration): void {
    const { type } = declaration.specifiers;
    if (
      declaration.declarators.length === 0 &&
      (type.kind === 'struct' || type.kind === 'union') &&
      type.tag &&
      !type.fields
    ) {
      const existing = this.scope.tags.get(type.tag);
      if (!existing) this.scope.tags.set(type.tag, { kind: 'record', info: new RecordInfo(type.kind, type.tag) });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Tag lookup and definition must share the current-scope identity; keep their resolution rules together.
  private recordInfo(specifier: Extract<TypeSpecifier, { kind: 'struct' | 'union' }>): RecordInfo {
    const { tag, fields, row, kind } = specifier;
    let info: RecordInfo | undefined;
    if (tag !== undefined) {
      // A definition, or a declaration `struct s;` alone, declares a new tag in the current scope.
      const existing = fields ? this.scope.tags.get(tag) : this.scope.lookupTag(tag);
      if (existing) {
        if (existing.kind !== 'record' || existing.info.kind !== kind) {
          this.error(row, `「${tag}」は、別の種類（struct・union・enum）の名前として使われています。`);
        }
        info = existing.info;
        if (fields && info.isComplete) this.error(row, `「${kind} ${tag}」が2回定義されています。`);
      }
    }
    if (!info) {
      info = new RecordInfo(kind, tag);
      // The interpreter's own header declares the opaque Turtle type with this tag, which programs cannot spell.
      info.isTurtle = tag === TURTLE_TAG;
      if (tag !== undefined) this.scope.tags.set(tag, { kind: 'record', info });
    }
    if (fields) this.defineRecord(info, fields, row);
    return info;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Field validation, duplicate names, and layout are one declaration pass; helpers already isolate type and width checks.
  private defineRecord(info: RecordInfo, fields: FieldDeclaration[], row: number): void {
    const members: RecordMember[] = [];
    const names = new Set<string>();
    const last = fields.flatMap((field) => field.declarators).at(-1);
    for (const field of fields) {
      if (field.specifiers.isInline) this.error(field.row, '構造体・共用体のメンバに inline は指定できません。');
      const base = this.baseType(field.specifiers);
      if (field.specifiers.storage) this.error(field.row, '構造体のメンバに記憶域の指定（static など）は書けません。');
      const align = field.specifiers.alignas ? this.requestedAlignment(field.specifiers.alignas) : undefined;
      if (field.declarators.length === 0 && base.kind === 'record' && field.specifiers.type.kind !== 'typedefName') {
        // An unnamed struct or union member (C11), whose members belong to this struct; a tagged one declares nothing.
        const specifier = field.specifiers.type as { tag?: string };
        if (specifier.tag !== undefined) continue;
        for (const name of base.info.memberNames()) this.claimMemberName(names, name, field.row);
        members.push({ type: base, isAnonymous: true, ...(align === undefined ? {} : { align }) });
        continue;
      }
      for (const declarator of field.declarators) {
        members.push(this.recordMember(info, base, declarator, declarator === last, names, align));
      }
    }
    if (members.length === 0) this.error(row, '構造体・共用体には、メンバを1つ以上書いてください。');
    layoutRecord(info, members);
  }

  private recordMember(
    info: RecordInfo,
    base: CType,
    declarator: FieldDeclaration['declarators'][number],
    isLast: boolean,
    names: Set<string>,
    align: number | undefined
  ): RecordMember {
    const { type, name } = this.declaredType(base, declarator.declarator);
    const memberRow = declarator.row;
    if (isVariablyModified(type))
      this.error(memberRow, '構造体・共用体のメンバの配列には、定数の大きさを書いてください。');
    if (name !== undefined) this.claimMemberName(names, name, memberRow);
    if (align !== undefined && align !== 0 && align < alignOf(type))
      this.error(memberRow, '_Alignas の大きさは、型のアラインメントより小さくできません。');
    const isFlexible = type.kind === 'array' && type.length === undefined;
    if (isFlexible) this.checkFlexibleMember(info, isLast, name, memberRow);
    else this.checkMemberType(info, type, name, memberRow);
    const bitWidth =
      declarator.bitWidth === undefined ? undefined : this.bitFieldWidth(declarator.bitWidth, type, name, memberRow);
    return {
      ...(name === undefined ? {} : { name }),
      type,
      ...(bitWidth === undefined ? {} : { bitWidth }),
      ...(align === undefined ? {} : { align }),
    };
  }

  private claimMemberName(names: Set<string>, name: string, row: number): void {
    if (names.has(name)) this.error(row, `メンバ「${name}」が2回宣言されています。`);
    names.add(name);
  }

  /** A flexible array member, `int a[];`, which only the last member of a struct with other members may be. */
  private checkFlexibleMember(info: RecordInfo, isLast: boolean, name: string | undefined, row: number): void {
    if (info.kind === 'union')
      this.error(row, `共用体のメンバ「${name ?? ''}」には、大きさを書かない配列を使えません。`);
    if (!isLast) this.error(row, `大きさを書かない配列のメンバ「${name ?? ''}」は、構造体の最後にしか書けません。`);
  }

  private checkMemberType(info: RecordInfo, type: CType, name: string | undefined, row: number): void {
    if (type.kind === 'function') this.error(row, '構造体のメンバを関数にはできません（関数ポインタにしてください）。');
    if (!isComplete(type)) {
      if (type.kind === 'record' && type.info === info)
        this.error(row, '構造体の中に、同じ構造体そのものは入れられません（ポインタにしてください）。');
      this.error(row, `メンバ「${name ?? ''}」の型（${typeName(type)}）は、中身が定義されていません。`);
    }
  }

  private bitFieldWidth(width: Expression, type: CType, name: string | undefined, row: number): number {
    if (type.kind !== 'int') this.error(row, 'ビットフィールドの型は整数にしてください。');
    if (type.enumInfo) unsupported(row, '列挙の型のビットフィールド');
    const bitWidth = this.integerConstant(width, 'ビットフィールドの幅');
    if (bitWidth < 0) this.error(row, 'ビットフィールドの幅に負の数は使えません。');
    if (bitWidth > sizeOf(type) * 8) this.error(row, 'ビットフィールドの幅が、型のビット数を超えています。');
    if (bitWidth === 0 && name !== undefined) this.error(row, '幅が 0 のビットフィールドには名前を付けられません。');
    return bitWidth;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Enumerator values and tag identity are resolved in declaration order; splitting the pass would distribute its state.
  // code-gauge-allow functionNcss 32 -- Enumerator values and tag identity are resolved in declaration order; splitting the pass would distribute its state.
  private enumType(specifier: Extract<TypeSpecifier, { kind: 'enum' }>): CType {
    const { tag, enumerators, row } = specifier;
    if (tag !== undefined && !enumerators) {
      const existing = this.scope.lookupTag(tag);
      if (existing?.kind === 'enum') return existing.type;
      if (existing) this.error(row, `「${tag}」は、別の種類（struct・union・enum）の名前として使われています。`);
      // C forbids using an enum before defining it, which clang accepts with a warning as an incomplete type.
      this.error(row, `「enum ${tag}」は、まだ定義されていません。`);
    }
    if (tag !== undefined && this.scope.tags.has(tag)) this.error(row, `「enum ${tag}」が2回定義されています。`);
    const info: EnumInfo = { ...(tag === undefined ? {} : { tag }), constants: new Map(), isComplete: false };
    const values: number[] = [];
    let next = 0;
    const declared: { name: string; value: number; row: number }[] = [];
    for (const enumerator of enumerators ?? []) {
      const value = enumerator.value ? this.integerConstant(enumerator.value, '列挙の値') : next;
      if (value > 2_147_483_647 || value < -2_147_483_648) unsupported(enumerator.row, 'int の範囲を超える列挙の値');
      if (this.scope.ordinary.has(enumerator.name))
        this.error(enumerator.row, `「${enumerator.name}」が2回宣言されています。`);
      this.scope.ordinary.set(enumerator.name, { kind: 'enumConstant', value, type: INT });
      info.constants.set(enumerator.name, value);
      declared.push({ name: enumerator.name, value, row: enumerator.row });
      values.push(value);
      next = value + 1;
    }
    info.isComplete = true;
    // clang gives an enum whose values are all non-negative the underlying type unsigned int.
    const underlying = values.some((value) => value < 0) ? INT : UINT;
    const type: CType = { ...underlying, enumInfo: info };
    if (tag !== undefined) this.scope.tags.set(tag, { kind: 'enum', info, type });
    return type;
  }

  /** The type a declarator derives from a base type, and the name it declares. */
  // code-gauge-allow functionCognitiveComplexity 24 -- The declarator walk applies pointer, array, and function layers in order; separate cases would only move the same branches.
  protected declaredType(base: CType, declarator: Declarator): { type: CType; name?: string; row: number } {
    let type = base;
    let current = declarator;
    for (;;) {
      switch (current.kind) {
        case 'name': {
          return { type, ...(current.name === undefined ? {} : { name: current.name }), row: current.row };
        }
        case 'pointer': {
          type = withQualifiers(
            { kind: 'pointer', to: type },
            current.qualifiers.isConst,
            current.qualifiers.isVolatile
          );
          break;
        }
        case 'array': {
          if (type.kind === 'function')
            this.error(current.row, '関数の配列は作れません（関数ポインタの配列にしてください）。');
          if (!isComplete(type))
            this.error(current.row, `要素の型（${typeName(type)}）が決まっていない配列は作れません。`);
          const length = current.size === undefined ? {} : this.arrayLength(current.size);
          type = { kind: 'array', of: type, ...length };
          break;
        }
        case 'function': {
          if (type.kind === 'array') this.error(current.row, '関数は配列を返せません。');
          if (type.kind === 'function') this.error(current.row, '関数は関数を返せません。');
          type = this.functionType(type, current);
          break;
        }
      }
      current = current.inner;
    }
  }

  /** An array's length, or the slot of a variable-length array, whose length the declaration computes. */
  private arrayLength(size: Expression): { length?: number; vla?: number } {
    const operand = this.rvalueOf(size);
    if (operand.type.kind !== 'int')
      this.error(size.row, `配列の大きさには整数を書いてください（${typeName(operand.type)}）。`);
    if (operand.constant !== undefined) {
      const length = Number(operand.constant);
      if (length < 0) this.error(size.row, '配列の大きさに負の数は使えません。');
      return { length };
    }
    if (this.prototypeDepth > 0) return { vla: -1 };
    if (!this.fn) this.error(size.row, '関数の外の配列の大きさには、整数の定数を書いてください。');
    const slot = this.fn.vlaCount++;
    const value = operand.value;
    const sourceType = operand.type;
    this.pendingVla.push((frame) => {
      const length = Number(convertScalar(value(frame) as Scalar, sourceType, LONG));
      // A variable-length array of no or negative length is undefined behavior.
      if (length <= 0)
        throw new CRuntimeError('custom', `可変長配列の大きさが ${length} です（1 以上にしてください）。`);
      frame.vla[slot] = length;
    });
    return { vla: slot };
  }

  /** Runs the length computations of the variable-length arrays declared since the last call. */
  protected takePendingVla(): ((frame: Frame) => void) | undefined {
    const pending = this.pendingVla;
    if (pending.length === 0) return undefined;
    this.pendingVla = [];
    return (frame) => {
      for (const compute of pending) compute(frame);
    };
  }

  protected abstract rvalueOf(expression: Expression): Operand;

  private functionType(ret: CType, declarator: Extract<Declarator, { kind: 'function' }>): CType {
    if (!declarator.params) {
      return { kind: 'function', ret, variadic: false };
    }
    const params = declarator.params;
    if (
      params.length === 1 &&
      params[0].declarator.kind === 'name' &&
      params[0].declarator.name === undefined &&
      params[0].specifiers.type.kind === 'builtin' &&
      params[0].specifiers.type.words.join(' ') === 'void' &&
      !params[0].specifiers.qualifiers.isConst
    ) {
      return { kind: 'function', ret, params: [], variadic: declarator.variadic };
    }
    // In a prototype, earlier parameters are in scope for later ones' array lengths, which are only `[*]` there.
    this.prototypeDepth++;
    try {
      const types = this.withScope(() =>
        params.map((param) => {
          const { type, name } = this.parameterType(param);
          if (name !== undefined) {
            const local: LocalInfo = {
              name,
              type,
              index: -1,
              row: param.row,
              inMemory: false,
              size: 0,
              isParameter: true,
            };
            this.scope.ordinary.set(name, { kind: 'local', local, type });
          }
          return type;
        })
      );
      return { kind: 'function', ret, params: types, variadic: declarator.variadic };
    } finally {
      this.prototypeDepth--;
    }
  }

  /** A parameter's type, adjusted as C adjusts it: arrays become pointers and functions pointers to functions. */
  protected parameterType(param: { specifiers: Specifiers; declarator: Declarator; row: number }): {
    type: CType;
    name?: string;
  } {
    if (param.specifiers.storage && param.specifiers.storage !== 'register') {
      this.error(param.row, '引数に記憶域の指定（static など）は書けません。');
    }
    if (param.specifiers.isInline) this.error(param.row, '引数に inline は指定できません。');
    const previous = this.inParameter;
    this.inParameter = true;
    let declared: ReturnType<CompilerBase['declaredType']>;
    try {
      declared = this.withScope(() => this.declaredType(this.baseType(param.specifiers), param.declarator));
    } finally {
      this.inParameter = previous;
    }
    const { type, name } = declared;
    if (type.kind === 'void') this.error(param.row, '引数の型に void は使えません。');
    if (type.kind === 'array')
      return { type: withQualifiers({ kind: 'pointer', to: type.of }, false, false), ...(name ? { name } : {}) };
    if (type.kind === 'function') return { type: { kind: 'pointer', to: type }, ...(name ? { name } : {}) };
    return { type, ...(name ? { name } : {}) };
  }

  protected typeOfName(typeNameNode: TypeName): CType {
    return this.declaredType(this.baseType(typeNameNode.specifiers), typeNameNode.declarator).type;
  }

  // Constants ---------------------------------------------------------------------------------------------------------

  protected abstract constantOperand(expression: Expression): Operand | undefined;

  /**
   * The value that clang folds a const variable's initializer to, which lets the variable stand where C requires a
   * constant (an array's length, a case label).
   */
  protected foldedConstant(
    type: CType,
    init: { kind: string; expression?: Expression } | undefined
  ): Scalar | undefined {
    if (!isConstQualifiedInteger(type) || init?.kind !== 'expression' || !init.expression) return undefined;
    const operand = this.constantOperand(init.expression);
    if (operand?.constant === undefined || operand.type.kind !== 'int') return undefined;
    return convertScalar(operand.constant, operand.type, type);
  }

  protected integerConstant(expression: Expression, what: string): number {
    const operand = this.constantOperand(expression);
    if (operand?.constant === undefined || operand.type.kind !== 'int') {
      this.error(expression.row, `${what}には、整数の定数を書いてください。`);
    }
    return Number(operand.constant);
  }
}
