import type { Span } from './ast';
import type { Constant } from './constants';
import type { FuncEntity, PackageEntity, ProductSource, StaticCallee, Temporary, VarEntity } from './entities';
import type { Eval, Frame } from './runtime';
import { type Selection, type Type, underlying } from './types';
import type { Pointer, Value } from './values';

/** The local storage a value or an address may refer to, which Go's escape analysis follows. */
export interface Storage {
  /** Local variables whose storage the value may share (such as `s[1:]`, `a[:]`, or `&x`). */
  backingVars?: VarEntity[];
  /** A temporary allocation the value may refer to (such as `[]byte(s)`). */
  nonEscaping?: Temporary;
}

/** A compiled expression: what it is, its type, and how to evaluate it. */
export interface Operand extends Storage {
  mode:
    | 'value'
    /** An addressable variable, field, or element, which `store` writes. */
    | 'variable'
    /** `m[k]`, which can be assigned but has no address. */
    | 'mapIndex'
    | 'constant'
    /** A call of a function without results. */
    | 'novalue'
    | 'type'
    | 'builtin'
    | 'package'
    /** A method selected from a value, which only a call may use here. */
    | 'method';
  type: Type;
  span: Span;
  constant?: Constant;
  /** Evaluates the expression; a call with several results returns them as an array. */
  eval: Eval;
  store?: (frame: Frame, value: Value) => void;
  /**
   * Evaluates an assignment destination's operands, returning the writer that later checks the destination (nil
   * pointers, indices out of range, nil maps) and stores, so that a fault happens at its own store, as in Go.
   */
  prepareStore?: (frame: Frame) => (value: Value) => void;
  /**
   * Evaluates the operands of an addressable struct or array as `prepareStore` does, returning what reads its storage
   * after the same checks, for a destination inside it.
   */
  locate?: (frame: Frame) => () => Value;
  /** Reads and writes a map entry while evaluating the map and key expressions only once. */
  mapUpdate?: (frame: Frame, change: (value: Value) => Value) => void;
  /** Resolves a non-constant untyped shift expression once its target type is known. */
  resolveUntyped?: (target: Type) => Operand;
  /** Takes the address, which makes a local variable live in a cell. */
  addressOf?: () => (frame: Frame) => Pointer;
  /** The storage the address of this variable, field, or element refers to. */
  addressStorage?: Storage;
  /**
   * The local variable this variable, field, or array element lies in with no pointer, slice, or map between, which
   * Go's compiler may keep in registers as a whole.
   */
  ssaRoot?: VarEntity;
  /** What the program taking the address of this value, or of a part of it, does to escape analysis. */
  addressTaken?: () => void;
  /** Records a store into this field or element, which writes the array it lives in. */
  onWrite?: () => void;
  /** Evaluates `v, ok` forms: a map index or a type assertion. */
  commaOk?: (frame: Frame) => [Value, boolean];
  /** Tells a value its statement evaluates in the first pass that the statement uses `commaOk` rather than `eval`. */
  useCommaOk?: () => void;
  builtin?: string;
  package?: PackageEntity;
  /** The function a name refers to, which a call may call directly. */
  func?: FuncEntity;
  method?: { receiver: Operand; selection: Extract<Selection, { kind: 'method' | 'interfaceMethod' }> };
  /** Whether the expression is a call, which the step rules and the "is not used" check need. */
  isCall?: boolean;
  /** Whether the expression only creates an object, as Java's `new` does, for the step rules. */
  createsObject?: boolean;
  /**
   * The factors of a floating-point multiplication, which an addition or subtraction using it fuses into one rounding,
   * as Go's compiler does on arm64.
   */
  product?: {
    left: Eval;
    right: Eval;
    /** Whether the product still reaches the use, for a variable whose definition a loop may replace. */
    enabled?: () => boolean;
    /** Whether both factors are constants to Go's compiler, which computes the product before the program runs. */
    constant?: SsaConstant;
    /** Whether Go's compiler multiplies with FNMULD, for a negated factor or a negated product. */
    negated?: Negation;
    source: ProductSource;
  };
  /**
   * Whether Go's compiler knows the value as a constant: a constant, a variable whose reaching definition is one
   * (see ssaValues.ts), a parameter or captured variable of an inlined call that the caller knows as one, or the result
   * of an inlined call returning one. Decided when the program runs, once every loop's writes are known, for the frame
   * the value is computed in, which is undefined for the function itself rather than one of its calls.
   */
  ssaConstant?: SsaConstant;
  /** Whether Go's compiler computes a float value as a negation (FNEGD), which makes a product of it FNMULD. */
  negation?: Negation;
  /** For a complex value, whether Go's compiler computes its real and imaginary parts as negations. */
  partNegations?: readonly [Negation | undefined, Negation | undefined];
  /** For a struct value, what Go's compiler knows of each field when it keeps the struct in SSA form. */
  ssaFields?: SsaFields;
  /** What Go's compiler resolves the value to through names it sees defined once (see `StaticValue`). */
  static?: StaticValue;
  /** How many values the statement's first pass evaluates before this expression's place (`hoistingCalls`). */
  firstPass?: number;
  /** A value that exists only once the code producing it ran (a result of a multi-value call, a range value). */
  callResult?: boolean;
  /** The variable whose definitions reach this use, and which an assignment to it defines. */
  ssaVariable?: VarEntity;
  /** Which definition of the variable reaches this use. */
  ssaVersion?: number;
  /** The variable a name refers to, for marking it used or assigned. */
  variable?: { markUsed(): void; entity?: VarEntity };
}

/**
 * Whether Go's compiler knows a value as a constant, given which parameters and captured variables of the call
 * computing it are constants: undefined for the function itself, or the frame or arguments of a call it inlined.
 */
export type SsaConstant = (params: ConstantParams | undefined) => boolean;

/** Whether all operands are constants to Go's compiler, which then computes an operation on them before the program runs. */
export function allConstant(...operands: readonly Pick<Operand, 'ssaConstant'>[]): SsaConstant | undefined {
  const parts = operands.map((operand) => operand.ssaConstant);
  if (!parts.every(Boolean)) return undefined;
  return (params) => parts.every((part) => part?.(params));
}

/** Decided once the function is compiled, as which definitions reach a use is. */
export type Negation = () => boolean;

/** What Go's compiler knows of each field of a struct value; a field of a constant struct is itself a constant. */
export type SsaFields = (SsaFacts | undefined)[];

export type SsaFacts = Pick<Operand, 'ssaConstant' | 'ssaFields'>;

/** What Go's compiler knows of a field of a struct value. */
export function ssaFieldFacts(struct: SsaFacts, index: number): SsaFacts | undefined {
  return struct.ssaFields?.[index] ?? (struct.ssaConstant && { ssaConstant: struct.ssaConstant });
}

/** Facts that hold only while `holds` does. */
export function gateFacts(facts: SsaFacts, holds: () => boolean): SsaFacts {
  const { ssaConstant, ssaFields } = facts;
  return {
    ssaConstant: ssaConstant && ((params) => holds() && ssaConstant(params)),
    ssaFields: ssaFields?.map((field) => field && gateFacts(field, holds)),
  };
}

const fieldKeys = new WeakMap<object, Map<string, object>>();

/** Stands for a field of a captured struct variable in `ConstantParams.constantCapture`. */
export function capturedFieldKey(variable: object, path: readonly number[]): object {
  let keys = fieldKeys.get(variable);
  if (!keys) fieldKeys.set(variable, (keys = new Map()));
  const name = path.join('.');
  let key = keys.get(name);
  if (!key) keys.set(name, (key = {}));
  return key;
}

/**
 * What a call Go's compiler inlines knows of the fields of a struct variable, a parameter or one its callee captures,
 * through `ConstantParams.constantCapture` of the fields' `capturedFieldKey`s.
 */
export function keyedFields(
  variable: object,
  type: Type,
  path: number[] = [],
  enclosing: object[] = [variable]
): SsaFields | undefined {
  const under = underlying(type);
  if (under.kind !== 'struct') return undefined;
  return under.fields.map((field, index) => {
    // A field of a constant struct is a constant too.
    const keys = [...enclosing, capturedFieldKey(variable, [...path, index])];
    return {
      ssaConstant: (params) => keys.some((key) => params?.constantCapture?.(key)),
      ssaFields: keyedFields(variable, field.type, [...path, index], keys),
    };
  });
}

/** Adds the constant fields of a struct variable to `constants`, keyed by their `capturedFieldKey`. */
export function addFieldConstants(
  constants: Map<object, SsaConstant>,
  variable: object,
  fields: SsaFields | undefined,
  path: number[] = []
): void {
  for (const [index, facts] of fields?.entries() ?? []) {
    if (facts?.ssaConstant) constants.set(capturedFieldKey(variable, [...path, index]), facts.ssaConstant);
    addFieldConstants(constants, variable, facts?.ssaFields, [...path, index]);
  }
}

/** What Go's compiler knows of the part of a value at `path`, a list of field indices. */
export function ssaFactsAt(value: SsaFacts | undefined, path: readonly number[]): SsaFacts | undefined {
  let facts = value;
  for (const index of path) facts = facts && ssaFieldFacts(facts, index);
  return facts;
}

export interface ConstantParams {
  constantParam(index: number): boolean;
  constantCapture?(variable: object): boolean;
}

/**
 * What Go's compiler resolves a value to as ir.StaticValue does, through a local variable it never assigns again or
 * addresses after its one definition and through the single result of a call it inlines: a constant, which converts to
 * an interface as constant data and folds in arithmetic, or a function of the program, whose calls it may inline.
 */
export interface StaticValue {
  constant?: SsaConstant;
  /** For a struct value, what Go's compiler knows of its fields. */
  fields?: SsaFields;
  callee?: StaticCallee;
}
