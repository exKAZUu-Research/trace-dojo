import { CompileError } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { convertScalar, type Scalar, type Value } from './arith';
import type { Declarator, Expression, FieldDeclaration, Specifiers, TypeName, TypeSpecifier } from './ast';
import type { Frame, FunctionInfo, GlobalInfo, LocalInfo } from './runtime';
import {
  builtinType,
  type CType,
  type EnumInfo,
  INT,
  isComplete,
  layoutRecord,
  RecordInfo,
  sizeOf,
  typeName,
  UINT,
  withQualifiers,
} from './types';
import { unsupported } from './unsupported';

export type Entity =
  | { kind: 'typedef'; type: CType }
  /** A variable; `constant` is the value of a const integer one with a constant initializer, which clang folds. */
  | { kind: 'local'; local: LocalInfo; type: CType; constant?: Scalar }
  | { kind: 'global'; global: GlobalInfo; type: CType; constant?: Scalar }
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
  lvalue?: LValue;
  bitWidth?: number;
  /** The value of an arithmetic constant expression. */
  constant?: Scalar;
  /** Whether the value is an address known before the program runs, as static initializers require. */
  isAddressConstant?: boolean;
  /** Whether the expression is a call, whose statement records no step of its own when the call recorded some. */
  isCall?: boolean;
  /** Evaluates the expression for its effects only, as an expression statement does. */
  effect?: (frame: Frame) => void;
  /** Whether the expression is a parenthesized one, which changes only some of clang's checks. */
  isParenthesized?: boolean;
}

export interface Location {
  load: () => Value;
  store: (value: Value) => void;
}

export interface LValue {
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

/** The state of the function being compiled. */
export interface FunctionContext {
  info: FunctionInfo;
  returnType: CType;
  labels: Map<string, { id: number; row: number; defined: boolean }>;
  nextLabel: number;
  loopDepth: number;
  /** The switch statements around the statement being compiled, innermost last. */
  switches: SwitchContext[];
  /** Names whose address the function takes, whose variables must live in memory. */
  addressTaken: Set<string>;
  registerLocals: Set<LocalInfo>;
}

export interface SwitchContext {
  type: CType;
  cases: Map<string, number>;
  defaultLabel?: number;
  defaultRow?: number;
}

export interface CompileOptions {
  trace?: TraceOptions;
}

export abstract class CompilerBase {
  protected scope = new Scope();
  protected fn?: FunctionContext;
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
    }
  }

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

  private defineRecord(info: RecordInfo, fields: FieldDeclaration[], row: number): void {
    const members: { name?: string; type: CType; bitWidth?: number }[] = [];
    const names = new Set<string>();
    for (const field of fields) {
      const base = this.baseType(field.specifiers);
      if (field.specifiers.storage) this.error(field.row, '構造体のメンバに記憶域の指定（static など）は書けません。');
      for (const declarator of field.declarators) {
        const { type, name } = this.declaredType(base, declarator.declarator);
        const memberRow = declarator.row;
        if (name !== undefined) {
          if (names.has(name)) this.error(memberRow, `メンバ「${name}」が2回宣言されています。`);
          names.add(name);
        }
        this.checkMemberType(info, type, name, memberRow);
        const bitWidth =
          declarator.bitWidth === undefined
            ? undefined
            : this.bitFieldWidth(declarator.bitWidth, type, name, memberRow);
        members.push({
          ...(name === undefined ? {} : { name }),
          type,
          ...(bitWidth === undefined ? {} : { bitWidth }),
        });
      }
    }
    if (members.length === 0) this.error(row, '構造体・共用体には、メンバを1つ以上書いてください。');
    layoutRecord(info, members);
  }

  private checkMemberType(info: RecordInfo, type: CType, name: string | undefined, row: number): void {
    if (type.kind === 'function') this.error(row, '構造体のメンバを関数にはできません（関数ポインタにしてください）。');
    if (type.kind === 'array' && type.length === undefined)
      unsupported(row, '大きさを書かない配列のメンバ（柔軟な配列メンバ）');
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
          let length: number | undefined;
          if (current.size !== undefined) length = this.arrayLength(current.size);
          type = { kind: 'array', of: type, ...(length === undefined ? {} : { length }) };
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

  private arrayLength(size: Expression): number {
    const operand = this.constantOperand(size);
    if (operand?.constant === undefined || operand.type.kind !== 'int') {
      if (this.fn) unsupported(size.row, '大きさが定数でない配列（可変長配列）');
      this.error(size.row, '配列の大きさには、整数の定数を書いてください。');
    }
    const length = Number(operand.constant);
    if (length < 0) this.error(size.row, '配列の大きさに負の数は使えません。');
    if (length === 0) unsupported(size.row, '大きさが 0 の配列');
    return length;
  }

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
    const types = params.map((param) => this.parameterType(param).type);
    return { kind: 'function', ret, params: types, variadic: declarator.variadic };
  }

  /** A parameter's type, adjusted as C adjusts it: arrays become pointers and functions pointers to functions. */
  protected parameterType(param: { specifiers: Specifiers; declarator: Declarator; row: number }): {
    type: CType;
    name?: string;
  } {
    if (param.specifiers.storage && param.specifiers.storage !== 'register') {
      this.error(param.row, '引数に記憶域の指定（static など）は書けません。');
    }
    const { type, name } = this.withScope(() => this.declaredType(this.baseType(param.specifiers), param.declarator));
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
